import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  createWorkspace, fillN, lockFacts, newWorktreeCommand, normalizeWorkspace, parseLock, parseWorktreeList, pidAlive,
  probePort, SlotError, ticketIndex, ticketKeys, ticketLinks, versionInfo, workspaceSettings,
} from '../src/workspace.mjs';
import { commit, DAY, fakeFetch, git, tmpDir } from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 5, 12);

describe('workspace settings', () => {
  it('defaults: auto-detected repos, three dev slots, no QA slots', () => {
    const s = normalizeWorkspace({});
    assert.deepEqual(s.repos, []);
    assert.deepEqual(s.devSlots.map((d) => [d.id, d.label]), [['dev1', 'Dev 1'], ['dev2', 'Dev 2'], ['dev3', 'Dev 3']]);
    assert.deepEqual(s.qa, { count: 0, pattern: '', versionPath: '', label: 'QA {n}' });
    assert.equal(s.branchPrefix, 'feature/');
  });

  it('takes 12 QA slots with a pattern and version path, and ports as text', () => {
    const s = normalizeWorkspace({
      devSlots: [{ label: 'Primary', ports: '5173, 5001' }, { label: 'Aux', ports: [5174], lockFile: '~/code/.dev2.lock' }],
      qa: { count: 12, pattern: 'https://qa{n}.example.com', versionPath: '/api/version' },
    });
    assert.deepEqual(s.devSlots[0], { id: 'dev1', label: 'Primary', ports: [5173, 5001], url: 'http://localhost:5173', lockFile: '' });
    assert.equal(s.devSlots[1].lockFile, '~/code/.dev2.lock');
    assert.equal(s.qa.count, 12);
  });

  it('a number of dev slots is enough', () => {
    assert.deepEqual(normalizeWorkspace({ devSlots: 2 }).devSlots.map((d) => d.label), ['Dev 1', 'Dev 2']);
  });

  for (const [what, input] of [
    ['a bad pattern', { ticketPattern: '([' }], ['a pattern that matches nothing', { ticketPattern: 'x*' }],
    ['a branch prefix with spaces', { branchPrefix: 'my branch/' }], ['13 dev slots', { devSlots: 13 }],
    ['port 0', { devSlots: [{ ports: [0] }] }], ['port 70000', { devSlots: [{ ports: '70000' }] }],
    ['a non-http slot URL', { devSlots: [{ url: 'file:///etc/passwd' }] }],
    ['41 QA slots', { qa: { count: 41 } }], ['a QA pattern without {n}', { qa: { count: 2, pattern: 'https://qa.example.com' } }],
    ['a non-http QA pattern', { qa: { count: 2, pattern: 'ftp://qa{n}.example.com' } }],
    ['a version path without /', { qa: { versionPath: 'api/version' } }], ['a QA name without {n}', { qa: { label: 'QA' } }],
  ]) {
    it(`refuses ${what}`, () => assert.throws(() => normalizeWorkspace(input), TypeError));
  }

  it('falls back to defaults when config.json is broken', () => {
    assert.equal(workspaceSettings({ workspace: { qa: { count: 'lots' } } }).qa.count, 0);
  });
});

describe('workspace helpers', () => {
  it('finds ticket keys in branch names', () => {
    assert.deepEqual(ticketKeys('feature/PROJ-123-login'), ['PROJ-123']);
    assert.deepEqual(ticketKeys('bugfix/proj-9_and_DBA-12'), ['PROJ-9', 'DBA-12']);
    assert.deepEqual(ticketKeys('main'), []);
    assert.deepEqual(ticketKeys(null), []);
    assert.deepEqual(ticketKeys('x/OPS-48', '(PROJ|OPS)-\\d+'), ['OPS-48']);
  });

  it('parses git worktree list --porcelain', () => {
    const out = 'worktree /r/app\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/app-PROJ-1\nHEAD bbb\nbranch refs/heads/feature/PROJ-1\nlocked reason\n\nworktree /r/gone\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n';
    assert.deepEqual(parseWorktreeList(out), [
      { path: '/r/app', head: 'aaa', branch: 'main', bare: false, detached: false, locked: false, prunable: false, main: true },
      { path: '/r/app-PROJ-1', head: 'bbb', branch: 'feature/PROJ-1', bare: false, detached: false, locked: true, prunable: false, main: false },
      { path: '/r/gone', head: 'ccc', branch: null, bare: false, detached: true, locked: false, prunable: true, main: false },
    ]);
  });

  it('reads lock files as key=value or JSON', () => {
    const kv = parseLock('# my launcher\nworktree=C:\\code\\app-PROJ-1\nbranch = feature/PROJ-1\napi_pid=4242\nweb_pid: 4343\nheartbeat=2026-11-05T11:59:00Z\n');
    assert.deepEqual(lockFacts(kv), { worktree: 'C:\\code\\app-PROJ-1', branch: 'feature/PROJ-1', ticket: null, pids: [4242, 4343], heartbeatAt: Date.parse('2026-11-05T11:59:00Z') });
    assert.deepEqual(lockFacts(parseLock('{"path":"/r/x","pid":12,"ticket":"A-1","updated":1793880000}')), { worktree: '/r/x', branch: null, ticket: 'A-1', pids: [12], heartbeatAt: 1793880000000 });
    assert.deepEqual(parseLock('{broken'), {});
    assert.deepEqual(parseLock(''), {});
  });

  it('knows a live process from a gone one', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(2 ** 22 + 12345), false);
  });

  it('probes a local port', async () => {
    const srv = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const { port } = srv.address();
    assert.equal(await probePort(port), true);
    await new Promise((r) => srv.close(r));
    assert.equal(await probePort(port), false);
  });

  it('fills in slot numbers', () => {
    assert.equal(fillN('https://qa{n}.x.com', 7), 'https://qa7.x.com');
    assert.equal(fillN('https://qa{nn}.x.com', 7), 'https://qa07.x.com');
  });

  it('reads version replies whatever they call things', () => {
    assert.deepEqual(versionInfo({ gitSha: 'abcdef0123456789', branch: 'refs/heads/feature/PROJ-1', buildId: 77 }), { branch: 'feature/PROJ-1', sha: 'abcdef012345', build: '77', deployedAt: null });
    assert.deepEqual(versionInfo({ git: { commit: 'abc', branch: 'main' }, build: { number: '9', date: '2026-11-01' } }), { branch: 'main', sha: 'abc', build: '9', deployedAt: '2026-11-01' });
    assert.equal(versionInfo({ hello: 'world' }), null);
    assert.equal(versionInfo('text'), null);
  });

  it('quotes paths in the new-worktree command', () => {
    assert.equal(newWorktreeCommand({ repo: '/code/my app', key: 'PROJ-9', prefix: 'feature/', base: 'origin/main' }),
      "git -C '/code/my app' worktree add -b feature/PROJ-9 '/code/my app-PROJ-9' origin/main");
  });

  it('links tickets to worktrees, dev slots and QA slots', () => {
    const ws = {
      repos: [{ worktrees: [{ ticket: 'A-1', display: '~/a-A-1', branch: 'f/A-1', changed: 1, untracked: 1 }, { ticket: null, display: '~/a' }] }],
      devSlots: [{ id: 'dev1', label: 'Dev 1', state: 'running', ticket: 'A-1' }, { id: 'dev2', label: 'Dev 2', state: 'free', ticket: null }],
      qaSlots: [{ n: 3, label: 'QA 3', deployedTicket: 'A-1', claim: { ticket: 'A-1' } }, { n: 4, label: 'QA 4', deployedTicket: 'B-2', claim: { ticket: 'A-1' } }],
    };
    assert.deepEqual(ticketLinks(ws), {
      'A-1': { worktrees: [{ path: '~/a-A-1', branch: 'f/A-1', dirty: 2 }], dev: [{ id: 'dev1', label: 'Dev 1', state: 'running' }], qa: [{ n: 3, label: 'QA 3', how: 'deployed' }, { n: 4, label: 'QA 4', how: 'claimed' }] },
      'B-2': { worktrees: [], dev: [], qa: [{ n: 4, label: 'QA 4', how: 'deployed' }] },
    });
    assert.deepEqual(ticketIndex({ lanes: [{ id: 'review', label: 'In Code Review', cards: [{ key: 'A-1', status: 'Code Review', summary: 'S', url: 'u' }] }] }),
      { 'A-1': { lane: 'review', laneLabel: 'In Code Review', status: 'Code Review', summary: 'S', url: 'u' } });
  });
});

// A real repo with two linked worktrees.
async function repoWithWorktrees() {
  const root = await tmpDir();
  const repo = path.join(root, 'app');
  await fs.mkdir(repo);
  git(repo, ['init', '-q']);
  commit(repo, 'first', NOW - 10 * DAY);
  git(repo, ['branch', 'origin-main']); // stand-in base so ahead/behind has something to count against
  git(repo, ['worktree', 'add', '-q', '-b', 'feature/PROJ-1-login', path.join(root, 'app-PROJ-1')]);
  git(repo, ['worktree', 'add', '-q', '-b', 'bugfix/PROJ-2', path.join(root, 'app-PROJ-2')]);
  commit(path.join(root, 'app-PROJ-1'), 'work', NOW - 2 * DAY);
  commit(path.join(root, 'app-PROJ-1'), 'more work', NOW - DAY);
  await fs.writeFile(path.join(root, 'app-PROJ-1', 'new.txt'), 'x');
  commit(repo, 'main moved', NOW - DAY / 2);
  return { root, repo };
}

describe('workspace service', () => {
  it('lists worktrees with their ticket, changes and ahead/behind', async () => {
    const { root, repo } = await repoWithWorktrees();
    const dir = await tmpDir();
    const ws = createWorkspace({ dir, getConfig: () => ({ workspace: { repos: [repo] } }), now: () => NOW, probe: async () => false });
    const data = await ws.get();
    assert.equal(data.repos.length, 1);
    const [main, one, two] = data.repos[0].worktrees;
    assert.equal(main.main, true);
    assert.equal(main.commands.remove, undefined, 'never offers to remove the main checkout');
    assert.equal(one.ticket, 'PROJ-1');
    assert.equal(one.branch, 'feature/PROJ-1-login');
    assert.equal(one.untracked, 1);
    assert.equal(one.lastSubject, 'more work');
    assert.equal(two.ticket, 'PROJ-2');
    assert.match(one.commands.remove, /worktree remove/);
    assert.ok(one.path.startsWith(root));
    // base falls back to main when there is no origin
    assert.equal(data.repos[0].base, 'main');
    assert.equal(one.ahead, 2);
    assert.equal(one.behind, 1);
    assert.deepEqual(Object.keys(data.links).sort(), ['PROJ-1', 'PROJ-2']);
  });

  it('finds repos that use worktrees in the git scan folders when none are set', async () => {
    const { root } = await repoWithWorktrees();
    const lone = path.join(root, 'lonely');
    await fs.mkdir(lone);
    git(lone, ['init', '-q']);
    commit(lone, 'x', NOW);
    const ws = createWorkspace({ dir: await tmpDir(), getConfig: () => ({ sources: { git: { roots: [root] } } }), now: () => NOW, probe: async () => false });
    const data = await ws.get();
    assert.deepEqual(data.repos.map((r) => r.name), ['app'], 'one entry per repo (not per worktree), and repos without worktrees are left out');
    assert.equal(data.repos[0].worktrees.length, 3);
  });

  it('reports a repo it cannot read', async () => {
    const ws = createWorkspace({ dir: await tmpDir(), getConfig: () => ({ workspace: { repos: ['/definitely/not/here'] } }), now: () => NOW, probe: async () => false });
    const data = await ws.get();
    assert.equal(data.repos.length, 0);
    assert.equal(data.warnings.length, 1);
  });

  const fakeGit = (files = {}) => ({
    findRepos: async () => [],
    worktrees: async () => [
      { path: '/r/app', branch: 'main', head: 'a', main: true },
      { path: '/r/app-PROJ-1', branch: 'feature/PROJ-1', head: 'b', main: false },
    ],
    base: async () => 'origin/main',
    inspect: async () => ({ changed: 0, untracked: 0, conflicts: 0, upstream: null, unpushed: null, ahead: 1, behind: 0, lastCommitAt: null, lastSubject: null }),
    readFile: async (f) => { if (f in files) return files[f]; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
  });
  const cfg = (over = {}) => ({
    workspace: {
      repos: ['/r/app'],
      devSlots: [{ label: 'Dev 1', ports: [5173] }, { label: 'Dev 2', ports: [5174], lockFile: '/locks/dev2.lock' }, { label: 'Dev 3', lockFile: '/locks/dev3.lock' }, { label: 'Dev 4' }],
      qa: { count: 4, pattern: 'https://qa{n}.example.com', versionPath: '/api/version' },
      ...over,
    },
  });

  it('works out each dev slot: ports, lock files (live or stale), claims', async () => {
    const files = { '/locks/dev2.lock': 'worktree=/r/app-PROJ-1\napi_pid=111\n', '/locks/dev3.lock': 'branch=feature/PROJ-5\nweb_pid=222\n' };
    const ws = createWorkspace({
      dir: await tmpDir(), getConfig: () => cfg(), now: () => NOW, git: fakeGit(files),
      probe: async (p) => p === 5173, alive: (pid) => pid === 111,
      fetchImpl: fakeFetch(() => ({ body: { branch: 'main' } })),
    });
    await ws.claim('dev', 'dev4', { ticket: 'proj-9', note: 'later' }).catch((e) => assert.match(e.message, /doesn't look like/));
    await ws.claim('dev', 'dev4', { ticket: 'PROJ-9', note: 'later' });
    const { devSlots, repos } = await ws.get({ fresh: true });
    const by = Object.fromEntries(devSlots.map((s) => [s.label, s]));
    assert.equal(by['Dev 1'].state, 'running');
    assert.equal(by['Dev 1'].from, 'ports');
    assert.equal(by['Dev 2'].state, 'running');
    assert.equal(by['Dev 2'].from, 'lock file');
    assert.equal(by['Dev 2'].ticket, 'PROJ-1', 'ticket from the worktree the lock names');
    assert.equal(by['Dev 3'].state, 'stale', 'lock file whose processes are gone');
    assert.equal(by['Dev 3'].ticket, 'PROJ-5');
    assert.equal(by['Dev 4'].state, 'claimed');
    assert.equal(by['Dev 4'].ticket, 'PROJ-9');
    assert.equal(by['Dev 4'].claim.note, 'later');
    assert.deepEqual(repos[0].worktrees[1].slot, { id: 'dev2', label: 'Dev 2', state: 'running' });
  });

  it('asks each QA slot what it runs, once a minute at most, and survives slots that are down', async () => {
    let t = NOW;
    const f = fakeFetch((u) => {
      const n = Number(/^qa(\d)\./.exec(u.hostname)[1]);
      if (n === 1) return { body: { branch: 'feature/PROJ-1-login', gitSha: 'abc123', buildId: 'b1' } };
      if (n === 2) return { status: 503, body: {} };
      if (n === 3) throw new TypeError('fetch failed');
      return { body: { nothing: 'useful' } };
    });
    const ws = createWorkspace({ dir: await tmpDir(), getConfig: () => cfg(), now: () => t, git: fakeGit(), probe: async () => false, fetchImpl: f });
    const { qaSlots, links } = await ws.get();
    assert.deepEqual(qaSlots.map((s) => [s.label, s.state, s.deployedTicket]), [['QA 1', 'up', 'PROJ-1'], ['QA 2', 'down', null], ['QA 3', 'down', null], ['QA 4', 'up', null]]);
    assert.equal(qaSlots[0].url, 'https://qa1.example.com');
    assert.equal(qaSlots[1].error, 'HTTP 503');
    assert.equal(qaSlots[2].error, 'Not reachable');
    assert.match(qaSlots[3].error, /No branch/);
    assert.equal(f.calls[0].url.href, 'https://qa1.example.com/api/version');
    assert.ok(f.calls.every((c) => c.method === 'GET' && !c.headers.authorization), 'plain anonymous GETs');
    assert.deepEqual(links['PROJ-1'].qa, [{ n: 1, label: 'QA 1', how: 'deployed' }]);
    t += 25_000; await ws.get();
    assert.equal(f.calls.length, 4, 'QA probes are cached');
    t += 40_000; await ws.get();
    assert.equal(f.calls.length, 8);
  });

  it('does not probe QA slots without a version path', async () => {
    const f = fakeFetch(() => { throw new Error('should not be called'); });
    const ws = createWorkspace({ dir: await tmpDir(), getConfig: () => cfg({ qa: { count: 12, pattern: 'https://qa{n}.example.com' } }), now: () => NOW, git: fakeGit(), probe: async () => false, fetchImpl: f });
    const { qaSlots } = await ws.get();
    assert.equal(qaSlots.length, 12);
    assert.ok(qaSlots.every((s) => s.state === 'unknown'));
    assert.equal(f.calls.length, 0);
  });

  it('claims and releases QA slots, saved on this machine (mode 600)', async () => {
    const dir = await tmpDir();
    const make = () => createWorkspace({ dir, getConfig: () => cfg({ qa: { count: 12 } }), now: () => NOW, git: fakeGit(), probe: async () => false });
    const ws = make();
    await ws.claim('qa', '7', { ticket: 'PROJ-3', owner: 'Priya', note: '  regression   run ' });
    const again = await make().get();
    assert.deepEqual(again.qaSlots[6].claim, { ticket: 'PROJ-3', owner: 'Priya', note: 'regression run', at: new Date(NOW).toISOString() });
    assert.equal((await fs.stat(path.join(dir, 'slots.json'))).mode & 0o777, 0o600);
    await ws.release('qa', '7');
    assert.equal((await ws.get()).qaSlots[6].claim, null);
    await assert.rejects(ws.release('qa', '7'), SlotError);
  });

  for (const [what, kind, id, body] of [
    ['an unknown dev slot', 'dev', 'dev99', { ticket: 'A-1' }], ['an empty dev claim', 'dev', 'dev1', {}],
    ['QA slot 13 of 12', 'qa', '13', { owner: 'me' }], ['QA slot 0', 'qa', '0', { owner: 'me' }], ['a QA slot that is not a number', 'qa', 'x', { owner: 'me' }],
    ['an empty QA claim', 'qa', '1', {}], ['a ticket that is not a key', 'qa', '1', { ticket: 'PROJ-1; rm -rf' }],
    ['a long note', 'qa', '1', { owner: 'me', note: 'x'.repeat(201) }], ['an unknown kind', 'prod', '1', { owner: 'me' }],
  ]) {
    it(`refuses ${what}`, async () => {
      const ws = createWorkspace({ dir: await tmpDir(), getConfig: () => cfg({ qa: { count: 12 } }), now: () => NOW, git: fakeGit(), probe: async () => false });
      await assert.rejects(ws.claim(kind, id, body), SlotError);
    });
  }
});
