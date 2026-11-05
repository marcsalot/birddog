// Launch slots, end to end: real (tiny) node HTTP servers on high ports, real lock files.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  applyOverlays, revertOverlays, preflight,
  alive, board, claim, cleanupSlots, fill, findLaunchConfig, LaunchError, loadLaunchConfig, lockPath, lockState,
  normalizeLaunchConfig, portOpen, readLock, restartSlot, slotCommand, startSlot, stopSlot, sweepStale,
} from '../src/launch.mjs';
import { installSkill, listSkills, skillCommand } from '../src/skills.mjs';
import { createWorkspace } from '../src/workspace.mjs';
import { workspaceHTML } from '../public/js/work.js';
import { spawn } from 'node:child_process';
import { commit, git, tmpDir } from './helpers.mjs';

const NODE = JSON.stringify(process.execPath);
const SERVER = `${NODE} -e "require('http').createServer((q,s)=>s.end('ok')).listen(+process.env.PORT,'127.0.0.1')"`;
let nextBase = 47000 + Math.floor(Math.random() * 400) * 10;
const ports = (n) => { const b = nextBase; nextBase += 10; return Array.from({ length: n }, (_, i) => b + i); };

/** A repo with launch-site.json and two worktree folders, and a config with two slots. */
async function setup(over = {}) {
  const root = await tmpDir();
  const main = path.join(root, 'app');
  for (const d of ['app', 'app-PROJ-1', 'app-PROJ-2']) {
    await fs.mkdir(path.join(root, d, 'api'), { recursive: true });
    await fs.mkdir(path.join(root, d, 'web'), { recursive: true });
  }
  const [a1, w1, a2, w2] = ports(4);
  const raw = {
    worktreeRoot: '..',
    slots: [{ name: 'dev1', ports: { api: a1, web: w1 } }, { name: 'dev2', ports: { api: a2, web: w2 } }],
    services: {
      api: { cwd: 'api', command: SERVER, env: { PORT: '{api}' }, timeoutSec: 20 },
      web: { cwd: 'web', command: SERVER, env: { PORT: '{web}' }, timeoutSec: 20 },
    },
    ...over,
  };
  await fs.writeFile(path.join(main, 'launch-site.json'), JSON.stringify(raw));
  const cfg = await loadLaunchConfig(path.join(main, 'launch-site.json'));
  return { root, main, cfg, raw, p: { a1, w1, a2, w2 } };
}
const wt = (s, name) => ({ worktree: name, worktreePath: path.join(s.root, `app-${name}`) });
const listen = (port) => new Promise((r) => { const srv = net.createServer().listen(port, '127.0.0.1', () => r(srv)); });
const cleanups = [];
after(async () => { for (const c of cleanups) await c().catch(() => {}); });

describe('launch-site.json', () => {
  const base = '/repo/app';
  const ok = { slots: [{ name: 'dev1', ports: { api: 5010, web: 5173 } }], services: { web: { command: 'npm run dev' } } };
  it('fills in defaults: worktree root and lock folder next to the repo, one lock per slot', () => {
    const c = normalizeLaunchConfig(ok, base);
    assert.equal(c.worktreeRoot, path.resolve('/repo'));
    assert.equal(c.lockDir, path.resolve('/repo'));
    assert.equal(c.slots[0].lock, '.slot-dev1.lock');
    assert.deepEqual(c.services.web, { command: 'npm run dev', cwd: '.', env: {}, port: 'web', timeoutSec: 120, ownerCheck: 'tree' });
    assert.deepEqual([c.overlays, c.guards, c.after, c.require], [[], [], [], []]);
  });
  for (const [what, raw] of [
    ['no slots', { slots: [] }],
    ['a lock with a folder in it', { slots: [{ name: 'a', lock: '../x.lock', ports: { web: 1 } }] }],
    ['a port in two slots', { slots: [{ name: 'a', ports: { web: 5173 } }, { name: 'b', ports: { web: 5173 } }] }],
    ['a slot without ports', { slots: [{ name: 'a', ports: {} }] }],
    ['a duplicate slot name', { slots: [{ name: 'a', ports: { web: 1 } }, { name: 'a', ports: { web: 2 } }] }],
    ['a service waiting on a port a slot lacks', { ...ok, services: { db: { command: 'x' } } }],
    ['a service folder outside the worktree', { ...ok, services: { web: { command: 'x', cwd: '../elsewhere' } } }],
    ['a bad environment variable name', { ...ok, services: { web: { command: 'x', env: { 'A B': '1' } } } }],
    ['a service without a command', { ...ok, services: { web: {} } }],
    ['an unknown ownerCheck', { ...ok, services: { web: { command: 'x', ownerCheck: 'any' } } }],
    ['an overlay outside the worktree', { ...ok, overlays: [{ file: '../x.env', body: '' }] }],
    ['an overlay listed twice', { ...ok, overlays: [{ file: 'web/.env', body: '' }, { file: 'web//.env', body: '' }] }],
    ['an overlay without a body', { ...ok, overlays: [{ file: 'web/.env' }] }],
    ['a guard with a wildcard', { ...ok, guards: [{ file: 'api/*.json', pattern: 'x' }] }],
    ['a guard with a bad pattern', { ...ok, guards: [{ file: 'a.json', pattern: '(' }] }],
    ['a required file outside the worktree', { ...ok, require: ['/etc/passwd'] }],
  ]) {
    it(`refuses ${what}`, () => assert.throws(() => normalizeLaunchConfig(raw, base), LaunchError));
  }
  it('fills placeholders and leaves other braces alone', () => {
    const slot = { name: 'dev2', ports: { api: 5012, web: 5174 } };
    assert.equal(fill('--port {web} --api http://localhost:{api} {slot} {worktree} {worktree_path} { x: {nope} }', slot, 'PROJ-1', '/w'),
      '--port 5174 --api http://localhost:5012 dev2 PROJ-1 /w { x: {nope} }');
  });
  it('is found from a linked worktree through its main checkout', async () => {
    const root = await tmpDir();
    const main = path.join(root, 'app');
    await fs.mkdir(main);
    git(main, ['init', '-q']);
    commit(main, 'x', Date.now());
    git(main, ['worktree', 'add', '-q', '-b', 'f/PROJ-3', path.join(root, 'app-PROJ-3')]);
    await fs.writeFile(path.join(main, 'launch-site.json'), JSON.stringify(ok));
    assert.equal(await fs.realpath(await findLaunchConfig(path.join(root, 'app-PROJ-3'))), await fs.realpath(path.join(main, 'launch-site.json')));
    assert.equal(await findLaunchConfig(root), null);
  });
});

describe('launch slots', () => {
  it('claims atomically: a second claim on the same slot loses', async () => {
    const s = await setup();
    assert.equal(await claim(s.cfg, s.cfg.slots[0], 'PROJ-1', '/a'), true);
    assert.equal(await claim(s.cfg, s.cfg.slots[0], 'PROJ-2', '/b'), false);
    assert.equal((await readLock(lockPath(s.cfg, s.cfg.slots[0]))).worktree, 'PROJ-1');
    assert.equal(await lockState(s.cfg, s.cfg.slots[0]), 'LIVE', 'a fresh starting lock with nothing running yet');
  });

  it('starts both services in the first free slot, then stops them and releases the lock', async () => {
    const s = await setup();
    cleanups.push(() => cleanupSlots(s.cfg));
    const lines = [];
    const r = await startSlot(s.cfg, { ...wt(s, 'PROJ-1'), log: (m) => lines.push(m) });
    assert.equal(r.slot, 'dev1');
    assert.equal(r.urls.web, `http://localhost:${s.p.w1}`);
    assert.ok(await portOpen(s.p.a1) && await portOpen(s.p.w1));
    const lock = await readLock(lockPath(s.cfg, s.cfg.slots[0]));
    assert.equal(lock.status, 'live');
    assert.equal(lock.worktree, 'PROJ-1');
    assert.ok(alive(lock.api_pid) && alive(lock.web_pid));
    assert.ok(lines.some((l) => /^LIVE slot dev1/.test(l)));
    const rows = await board(s.cfg);
    assert.deepEqual(rows.map((x) => [x.slot, x.free, x.worktree]), [['dev1', false, 'PROJ-1'], ['dev2', true, null]]);

    await assert.rejects(startSlot(s.cfg, wt(s, 'PROJ-1')), /ALREADY_RUNNING/);
    const two = await startSlot(s.cfg, wt(s, 'PROJ-2'));
    assert.equal(two.slot, 'dev2', 'the next worktree gets the next slot');

    const oldWeb = lock.web_pid;
    await restartSlot(s.cfg, { worktree: 'PROJ-1', service: 'web' });
    const after1 = await readLock(lockPath(s.cfg, s.cfg.slots[0]));
    assert.notEqual(after1.web_pid, oldWeb);
    assert.equal(after1.api_pid, lock.api_pid, 'the API kept running');
    assert.equal(after1.status, 'live');
    assert.ok(!alive(oldWeb));

    const stop = await stopSlot(s.cfg, { worktree: 'PROJ-1' });
    assert.equal(stop.verified, true);
    assert.equal(await readLock(lockPath(s.cfg, s.cfg.slots[0])), null);
    assert.ok(!(await portOpen(s.p.a1)) && !(await portOpen(s.p.w1)));
    assert.ok(await portOpen(s.p.w2), 'the other slot is untouched');

    const all = await cleanupSlots(s.cfg);
    assert.deepEqual(all.map((x) => [x.slot, x.verified]), [['dev2', true]]);
    assert.ok(!(await portOpen(s.p.w2)));
  });

  it('skips a slot whose port something else holds, and never kills it', async () => {
    const s = await setup();
    cleanups.push(() => cleanupSlots(s.cfg));
    const outsider = await listen(s.p.w1);
    cleanups.push(() => new Promise((r) => outsider.close(r)));
    const r = await startSlot(s.cfg, wt(s, 'PROJ-1'));
    assert.equal(r.slot, 'dev2');
    await assert.rejects(startSlot(s.cfg, { ...wt(s, 'PROJ-2'), slot: 'dev1' }), /NO_SLOT: Slot dev1 is busy/);
    await cleanupSlots(s.cfg);
    assert.ok(await portOpen(s.p.w1), 'the outsider is still listening');
    assert.equal((await board(s.cfg))[0].status, 'orphan');
  });

  it('a service that dies before opening its port fails fast and takes the slot down', async () => {
    const s = await setup();
    s.raw.services.api.command = `${NODE} -e "process.exit(3)"`;
    await fs.writeFile(path.join(s.main, 'launch-site.json'), JSON.stringify(s.raw));
    const cfg = await loadLaunchConfig(path.join(s.main, 'launch-site.json'));
    cleanups.push(() => cleanupSlots(cfg));
    const t0 = Date.now();
    await assert.rejects(startSlot(cfg, wt(s, 'PROJ-1')), (e) => e.code === 'START_FAILED' && /api exited before opening port/.test(e.message));
    assert.ok(Date.now() - t0 < 15_000, 'well before the 20 s timeout');
    assert.equal(await readLock(lockPath(cfg, cfg.slots[0])), null, 'claim released');
    assert.ok(!(await portOpen(s.p.w1)), 'the web service that did start was stopped');
  });

  it('a failed build releases the claim and starts nothing', async () => {
    const s = await setup({ build: [{ command: `${NODE} -e "console.log('compiling'); process.exit(2)"` }] });
    await assert.rejects(startSlot(s.cfg, wt(s, 'PROJ-1')), (e) => e.code === 'START_FAILED' && /Build step 1 failed \(exit 2\)/.test(e.message) && /compiling/.test(e.message));
    assert.equal(await readLock(lockPath(s.cfg, s.cfg.slots[0])), null);
    assert.ok(!(await portOpen(s.p.a1)));
  });

  it('clears stale locks: dead processes, or "starting" for too long', async () => {
    const s = await setup();
    const [one, two] = s.cfg.slots;
    await fs.writeFile(lockPath(s.cfg, one), 'worktree=OLD-1\nstatus=live\napi_pid=999999\n');
    await fs.writeFile(lockPath(s.cfg, two), 'worktree=OLD-2\nstatus=starting\n');
    assert.deepEqual(await sweepStale(s.cfg), ['dev1']);
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(lockPath(s.cfg, two), old, old);
    assert.deepEqual(await sweepStale(s.cfg), ['dev2']);
  });

  it('stop and restart need a slot this worktree holds', async () => {
    const s = await setup();
    await assert.rejects(stopSlot(s.cfg, { worktree: 'PROJ-9' }), /NO_LOCK/);
    await assert.rejects(restartSlot(s.cfg, { worktree: 'PROJ-9', service: 'web' }), /NO_LOCK/);
  });
});

describe('birddog slot (CLI)', () => {
  it('prints the board, and says where the settings go when there are none', async () => {
    const s = await setup();
    const out = [];
    assert.equal(await slotCommand(['status'], { out: (m) => out.push(m), cwd: s.main }), 0);
    assert.match(out.join('\n'), new RegExp(`\\[dev1\\] FREE  api:${s.p.a1}  web:${s.p.w1}`));
    const err = [];
    assert.equal(await slotCommand(['status'], { err: (m) => err.push(m), cwd: s.root }), 1);
    assert.match(err[0], /^NO_CONFIG: No launch-site\.json/);
    assert.equal(await slotCommand(['bogus'], { err: () => {}, cwd: s.main }), 2);
    assert.equal(await slotCommand(['status', 'stray'], { err: () => {}, cwd: s.main }), 2);
  });
});

describe('birddog skill install', () => {
  it('ships the launch-site skill with Claude Code frontmatter', async () => {
    assert.ok((await listSkills()).includes('launch-site'));
    const md = await fs.readFile(path.resolve('skills/launch-site/SKILL.md'), 'utf8');
    assert.match(md, /^---\r?\nname: launch-site\r?\ndescription: .+\r?\n---\r?\n/);
  });
  it('installs into ~/.claude/skills, and won\'t replace a folder it didn\'t put there', async () => {
    const home = await tmpDir();
    const dest = await installSkill('launch-site', { home });
    assert.equal(dest, path.join(home, '.claude', 'skills', 'launch-site'));
    assert.ok((await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8')).includes('birddog slot start'));
    await installSkill('launch-site', { home }); // reinstall over our own copy is fine
    const other = path.join(home, '.claude', 'skills', 'mine');
    await fs.mkdir(other, { recursive: true });
    await fs.rm(dest, { recursive: true });
    await fs.mkdir(dest);
    await fs.writeFile(path.join(dest, 'SKILL.md'), 'my own');
    await assert.rejects(installSkill('launch-site', { home }), /wasn't installed by Birddog/);
    await installSkill('launch-site', { home, force: true });
    await assert.rejects(installSkill('nope', { home }), /No skill called "nope"/);
    const out = [];
    assert.equal(await skillCommand(['install', 'launch-site', '--project'], { out: (m) => out.push(m), cwd: home, home }), 0);
    assert.match(out[0], /\.claude[\\/]skills[\\/]launch-site/);
  });
});

describe('the Worktrees page and launch slots', () => {
  it('takes dev slots from launch-site.json and reads their locks', async () => {
    const s = await setup();
    const dev1 = s.cfg.slots[0];
    await fs.writeFile(lockPath(s.cfg, dev1), `worktree=PROJ-1\nworktree_path=${path.join(s.root, 'app-PROJ-1')}\nslot=dev1\nstatus=starting\napi_pid=claiming\n`);
    const fakeGit = {
      findRepos: async () => [],
      worktrees: async () => [
        { path: s.main, branch: 'main', main: true },
        { path: path.join(s.root, 'app-PROJ-1'), branch: 'feature/PROJ-1', main: false },
        { path: path.join(s.root, 'app-PROJ-2'), branch: 'feature/PROJ-2', main: false },
      ],
      base: async () => 'origin/main',
      inspect: async () => ({ changed: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0 }),
      readFile: (f) => fs.readFile(f, 'utf8'),
      exists: (f) => f === path.join(s.main, 'launch-site.json'),
    };
    const ws = createWorkspace({ dir: await tmpDir(), getConfig: () => ({ workspace: { repos: [s.main] } }), git: fakeGit, probe: async () => false });
    const data = await ws.get();
    assert.match(data.launchSite, /launch-site\.json$/);
    assert.deepEqual(data.devSlots.map((d) => [d.id, d.state, d.ticket]), [['dev1', 'starting', 'PROJ-1'], ['dev2', 'free', null]]);
    assert.match(data.devSlots[0].commands.stop, /^birddog slot stop --worktree /);
    const [, one, two] = data.repos[0].worktrees;
    assert.equal(one.commands.slot, undefined, 'already in a slot');
    assert.match(two.commands.slot, /^birddog slot start --worktree .*app-PROJ-2/);
    await ws.claim('dev', 'dev2', { ticket: 'PROJ-2' }); // launch slots can still be claimed by hand
    const html = workspaceHTML({ ...data, tickets: {} });
    assert.match(html, /◌<\/span> Starting/);
    assert.match(html, /Start in a slot/);
    assert.match(html, /from <code>[^<]*launch-site\.json<\/code>/);
  });
});

/** A git repo worktree for the overlay tests (tracked checks need git). */
async function gitSetup(over = {}) {
  const s = await setup(over);
  for (const d of ['app-PROJ-1', 'app-PROJ-2']) {
    const w = path.join(s.root, d);
    git(w, ['init', '-q']);
    await fs.writeFile(path.join(w, 'tracked.env'), 'TRACKED=1\n');
    git(w, ['add', 'tracked.env']);
    commit(w, 'init', Date.now());
  }
  return s;
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

describe('launch slots: overlays', () => {
  const OVERLAY = { file: 'web/.env.local', body: 'PORT={web}\nAPI=http://localhost:{api}\nSLOT={slot}\n' };

  it('writes per-slot files, backs up yours, keeps both out of git, and restores on stop', async () => {
    const s = await gitSetup({ overlays: [OVERLAY] });
    cleanups.push(() => cleanupSlots(s.cfg));
    const w = path.join(s.root, 'app-PROJ-1');
    const env = path.join(w, 'web', '.env.local');
    await fs.writeFile(env, 'MINE=1\n');
    await startSlot(s.cfg, wt(s, 'PROJ-1'));
    assert.equal(await fs.readFile(env, 'utf8'), `PORT=${s.p.w1}\nAPI=http://localhost:${s.p.a1}\nSLOT=dev1\n`);
    assert.equal(await fs.readFile(`${env}.birddog-bak`, 'utf8'), 'MINE=1\n');
    const exclude = await fs.readFile(path.join(w, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^web\/\.env\.local$/m);
    assert.match(exclude, /^web\/\.env\.local\.birddog-bak$/m);
    assert.equal(git(w, ['status', '--porcelain']).trim(), '', 'git sees nothing new');
    await stopSlot(s.cfg, { worktree: 'PROJ-1' });
    assert.equal(await fs.readFile(env, 'utf8'), 'MINE=1\n', 'your file is back');
    assert.ok(!(await fs.stat(`${env}.birddog-bak`).catch(() => null)));
  });

  it('removes a file it created, and re-applying never backs up its own file over yours', async () => {
    const s = await gitSetup({ overlays: [OVERLAY] });
    const w = path.join(s.root, 'app-PROJ-1');
    const env = path.join(w, 'web', '.env.local');
    const slot = s.cfg.slots[0];
    await applyOverlays(s.cfg, slot, 'PROJ-1', w);
    await applyOverlays(s.cfg, slot, 'PROJ-1', w);
    assert.ok(!(await fs.stat(`${env}.birddog-bak`).catch(() => null)), 'no backup of our own file');
    assert.equal(await revertOverlays(s.cfg, w), true);
    assert.ok(!(await fs.stat(env).catch(() => null)), 'the file it created is gone');
  });

  for (const [what, overlays, setupFn, re] of [
    ['a git-tracked file', [{ file: 'tracked.env', body: 'X=1' }], null, /tracked by git/],
    ['a tracked file spelled in another case', [{ file: 'TRACKED.ENV', body: 'X=1' }], null, /tracked by git/],
    ['a leftover backup from a launch that never restored it', [{ file: 'web/.env.local', body: 'X=1' }], (w) => fs.writeFile(path.join(w, 'web', '.env.local.birddog-bak'), 'OLD'), /never restored/],
  ]) {
    it(`refuses ${what}, writes nothing and releases the claim`, async () => {
      const s = await gitSetup({ overlays: [{ file: 'web/first.env', body: 'A=1' }, ...overlays] });
      const w = path.join(s.root, 'app-PROJ-1');
      if (setupFn) await setupFn(w);
      await assert.rejects(startSlot(s.cfg, wt(s, 'PROJ-1')), re);
      assert.ok(!(await fs.stat(path.join(w, 'web', 'first.env')).catch(() => null)), 'no overlay was written');
      assert.equal(await fs.readFile(path.join(w, 'tracked.env'), 'utf8'), 'TRACKED=1\n');
      assert.equal(await readLock(lockPath(s.cfg, s.cfg.slots[0])), null);
    });
  }
});

describe('launch slots: before claiming', () => {
  it('stops on a guard or a missing file, with nothing claimed', async () => {
    const s = await setup({ require: ['api/settings.json'], guards: [{ file: 'api/local.json', pattern: '"Kestrel"\\s*:', message: 'remove the Kestrel block, it pins a port' }] });
    const w = path.join(s.root, 'app-PROJ-1');
    await assert.rejects(startSlot(s.cfg, wt(s, 'PROJ-1')), /MISSING_FILE: .*api\/settings\.json/);
    await fs.writeFile(path.join(w, 'api', 'settings.json'), '{}');
    await preflight(s.cfg, w); // guarded file absent: passes
    await fs.writeFile(path.join(w, 'api', 'local.json'), '{ "Kestrel": { "Endpoints": {} } }');
    await assert.rejects(startSlot(s.cfg, wt(s, 'PROJ-1')), /GUARD_TRIPPED: api\/local\.json: remove the Kestrel block/);
    assert.equal(await readLock(lockPath(s.cfg, s.cfg.slots[0])), null);
    assert.equal(await fs.readFile(path.join(w, 'api', 'local.json'), 'utf8'), '{ "Kestrel": { "Endpoints": {} } }', 'guards only read');
  });
});

describe('launch slots: ownership', () => {
  const IDLE = `${NODE} -e "setInterval(()=>{},1000)"`;

  it('a port answered by something the launch did not start is FOREIGN_LISTENER, not ready', async () => {
    const s = await setup();
    s.raw.services = { web: { cwd: 'web', command: IDLE, timeoutSec: 15 } };
    await fs.writeFile(path.join(s.main, 'launch-site.json'), JSON.stringify(s.raw));
    const cfg = await loadLaunchConfig(path.join(s.main, 'launch-site.json'));
    cleanups.push(() => cleanupSlots(cfg));
    const started = startSlot(cfg, wt(s, 'PROJ-1'));
    await sleepMs(1500); // after the pre-launch port check
    const outsider = await listen(s.p.w1);
    cleanups.push(() => new Promise((r) => outsider.close(r)));
    await assert.rejects(started, /FOREIGN_LISTENER: port \d+ \(web\) is held by pid \d+/);
    assert.ok(await portOpen(s.p.w1), 'the outsider was not killed');
    assert.equal(await readLock(lockPath(cfg, cfg.slots[0])), null, 'our claim was released');
    outsider.close();
  });

  it('ownerCheck "port" takes whoever listens (a Docker-published port)', async () => {
    const s = await setup();
    s.raw.services = { web: { cwd: 'web', command: IDLE, timeoutSec: 15, ownerCheck: 'port' } };
    await fs.writeFile(path.join(s.main, 'launch-site.json'), JSON.stringify(s.raw));
    const cfg = await loadLaunchConfig(path.join(s.main, 'launch-site.json'));
    cleanups.push(() => cleanupSlots(cfg));
    const started = startSlot(cfg, wt(s, 'PROJ-1'));
    await sleepMs(1500);
    // a separate process (stop takes the recorded port owner down, so not this test runner)
    const published = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end()).listen(${s.p.w1},'127.0.0.1')`], { stdio: 'ignore' });
    cleanups.push(async () => published.kill());
    const r = await started;
    assert.equal(r.slot, 'dev1');
    assert.equal((await readLock(lockPath(cfg, cfg.slots[0]))).web_port_pid, String(published.pid));
    const stop = await stopSlot(cfg, { worktree: 'PROJ-1' });
    assert.equal(stop.verified, true);
    assert.ok(!alive(published.pid), 'stop takes down the recorded port owner');
  });

  it('a recorded pid that now belongs to another process is not ours: stale, and never killed', async () => {
    const s = await setup();
    const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    cleanups.push(async () => victim.kill());
    await sleepMs(200);
    const file = lockPath(s.cfg, s.cfg.slots[0]);
    await fs.writeFile(file, `worktree=REUSE-1\nworktree_path=${s.root}\nslot=dev1\nstatus=live\napi_pid=${victim.pid}\nstarts=${victim.pid}:not-its-start-time\n`);
    assert.equal(await lockState(s.cfg, s.cfg.slots[0]), 'STALE');
    await stopSlot(s.cfg, { worktree: 'REUSE-1' });
    assert.ok(alive(victim.pid), 'the process that reused the pid is still running');
    // the real stamp, though, is ours
    const real = await (await import('../src/launch-proc.mjs')).procStamp(victim.pid);
    assert.ok(real, 'start stamps are readable on this OS');
    await fs.writeFile(file, `worktree=REUSE-2\nstatus=live\napi_pid=${victim.pid}\nstarts=${victim.pid}:${real}\n`);
    assert.equal(await lockState(s.cfg, s.cfg.slots[0]), 'LIVE');
    await fs.rm(file);
  });

  it('records each service pid with its start stamp, and the pid that owns each port', async () => {
    const s = await setup();
    cleanups.push(() => cleanupSlots(s.cfg));
    await startSlot(s.cfg, wt(s, 'PROJ-1'));
    const lock = await readLock(lockPath(s.cfg, s.cfg.slots[0]));
    assert.ok(/^\d+$/.test(lock.web_port_pid), 'the listener behind the web port');
    for (const k of ['api_pid', 'web_pid', 'web_port_pid']) assert.match(lock.starts, new RegExp(`(^|;)${lock[k]}:`), `${k} has a stamp`);
    await stopSlot(s.cfg, { worktree: 'PROJ-1' });
  });

  it('cleanup --ports also stops an orphan listener with no lock; plain cleanup leaves it', async () => {
    const s = await setup();
    const orphan = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end()).listen(${s.p.a2},'127.0.0.1')`], { stdio: 'ignore' });
    cleanups.push(async () => orphan.kill());
    for (let i = 0; i < 40 && !(await portOpen(s.p.a2)); i++) await sleepMs(100);
    await cleanupSlots(s.cfg);
    assert.ok(await portOpen(s.p.a2), 'plain cleanup only stops what locks record');
    const r = await cleanupSlots(s.cfg, { sweepPorts: true });
    assert.ok(r.every((x) => x.verified));
    assert.ok(!(await portOpen(s.p.a2)));
  });
});

describe('launch slots: after steps', () => {
  it('run once the slot is live; a failing one is reported and the slot stays up', async () => {
    const s = await setup({ after: [{ command: `${NODE} -e "require('fs').writeFileSync('codegen.txt','{api}')"` }, { command: `${NODE} -e "process.exit(4)"` }] });
    cleanups.push(() => cleanupSlots(s.cfg));
    const r = await startSlot(s.cfg, wt(s, 'PROJ-1'));
    assert.equal(await fs.readFile(path.join(s.root, 'app-PROJ-1', 'codegen.txt'), 'utf8'), String(s.p.a1));
    assert.deepEqual(r.afterFailed, [2]);
    assert.equal((await readLock(lockPath(s.cfg, s.cfg.slots[0]))).status, 'live');
    await stopSlot(s.cfg, { worktree: 'PROJ-1' });
  });
});
