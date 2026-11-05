// Launch slots: run several copies of the same app at once, one per git worktree,
// each in its own "slot" (a named set of ports plus a lock file), so they never
// collide and anyone (you, Claude, Birddog's Worktrees page) can see what is live.
//
//   birddog slot status                       every slot: ports, lock, free or not
//   birddog slot start  [--worktree X]        claim the first free slot, build, start, wait until ready
//   birddog slot stop   [--worktree X]        stop the slot this worktree holds
//   birddog slot restart --service api        restart one service, leave the rest running
//   birddog slot cleanup                      stop every slot the locks record
//
// Settings live in launch-site.json at the top of your repo (see README "Launch slots").
//
// A start goes: check required files and guards (nothing claimed yet) → claim a free
// slot → write the slot's overlay files → build → check every port is free → start all
// services together → wait for all of them → mark the slot live → run "after" steps.
// A failure before the services start releases the claim and reverts the overlays,
// killing nothing. A failure after tears the slot down.
//
// Rules that keep parallel launches safe:
//   - A slot is free only with no lock AND none of its ports answering.
//   - Claiming creates the lock exclusively (O_EXCL): two launches can't both win.
//   - Every change checks that the caller's worktree holds the lock (OWNER_MISMATCH).
//   - Each recorded pid carries its process start time, so a pid the OS has since given
//     to another process is never taken for ours, and never killed.
//   - A port answered by a process the launch didn't start fails as FOREIGN_LISTENER
//     instead of passing for ready, and teardown never kills it.
//   - Teardown releases the lock only after it has checked our processes are gone and
//     reverted the overlays.
//
// Lock files are plain key=value lines (worktree, worktree_path, slot, status,
// <service>_pid, <service>_port_pid, starts, ports, timestamp, heartbeat), the format
// Birddog's Worktrees page reads.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { alive, isOurs, killTree, openUrl, portOpen, portOwner, procStamp, sameProcess } from './launch-proc.mjs';

export { alive, killTree, portOpen, portOwner, procStamp, isOurs } from './launch-proc.mjs';

export const CONFIG_FILE = 'launch-site.json';
const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_STALE_SEC = 300;
const PORT_NAME = /^[a-z][a-z0-9_]{0,19}$/i;
const BACKUP = '.birddog-bak';

export class LaunchError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

// ---------------------------------------------------------------------------
// Config

const insideRel = (p) => !path.isAbsolute(p) && !String(p).split(/[\\/]/).includes('..');

/** Validate a launch-site.json object. `base` is the folder it lives in (relative paths resolve there). */
export function normalizeLaunchConfig(raw, base) {
  if (!raw || typeof raw !== 'object') throw new LaunchError('BAD_CONFIG', `${CONFIG_FILE} must hold a JSON object`);
  const resolve = (p, fallback) => path.resolve(base, String(p ?? fallback));
  const worktreeRoot = resolve(raw.worktreeRoot, '..');
  const lockDir = resolve(raw.lockDir, raw.worktreeRoot ?? '..');
  if (!Array.isArray(raw.slots) || !raw.slots.length) throw new LaunchError('BAD_CONFIG', 'Add at least one slot to "slots"');
  if (raw.slots.length > 12) throw new LaunchError('BAD_CONFIG', 'Up to 12 slots');
  const names = new Set();
  const used = new Map();
  const slots = raw.slots.map((s, i) => {
    const name = String(s?.name ?? '');
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(name) || names.has(name)) throw new LaunchError('BAD_CONFIG', `Slot ${i + 1} needs a unique name (letters, digits, - and _)`);
    names.add(name);
    const lock = String(s.lock ?? `.slot-${name}.lock`);
    if (!/^[A-Za-z0-9._-]+$/.test(lock) || /^\.+$/.test(lock)) throw new LaunchError('BAD_CONFIG', `Slot ${name}: the lock is a plain file name (no folders, no "..")`);
    const ports = {};
    for (const [k, v] of Object.entries(s.ports ?? {})) {
      const n = Number(v);
      if (!PORT_NAME.test(k) || !Number.isInteger(n) || n < 1 || n > 65535) throw new LaunchError('BAD_CONFIG', `Slot ${name}: port "${k}" must be a name and a number from 1 to 65535`);
      if (used.has(n)) throw new LaunchError('BAD_CONFIG', `Port ${n} is in both ${used.get(n)} and ${name}`);
      used.set(n, name);
      ports[k] = n;
    }
    if (!Object.keys(ports).length) throw new LaunchError('BAD_CONFIG', `Slot ${name} needs at least one port`);
    return { name, lock, ports };
  });
  const step = (b, what) => {
    if (typeof b?.command !== 'string' || !b.command.trim()) throw new LaunchError('BAD_CONFIG', `${what} needs a "command"`);
    const cwd = String(b.cwd ?? '.');
    if (!insideRel(cwd)) throw new LaunchError('BAD_CONFIG', `${what}: "cwd" is a folder inside the worktree`);
    const timeoutSec = Number(b.timeoutSec ?? 600);
    if (!(timeoutSec > 0 && timeoutSec <= 3600)) throw new LaunchError('BAD_CONFIG', `${what}: timeoutSec is 1 to 3600`);
    return { command: b.command, cwd, timeoutSec };
  };
  const services = {};
  for (const [name, s] of Object.entries(raw.services ?? {})) {
    if (!/^[a-z][a-z0-9]{0,19}$/.test(name)) throw new LaunchError('BAD_CONFIG', `Service "${name}": use lowercase letters and digits`);
    const base2 = step({ ...s, timeoutSec: s?.timeoutSec ?? DEFAULT_TIMEOUT_SEC }, `Service ${name}`);
    const port = String(s.port ?? name);
    for (const slot of slots) if (!(port in slot.ports)) throw new LaunchError('BAD_CONFIG', `Service ${name} waits on port "${port}", which slot ${slot.name} doesn't define`);
    const env = {};
    for (const [k, v] of Object.entries(s.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new LaunchError('BAD_CONFIG', `Service ${name}: "${k}" is not an environment variable name`);
      env[k] = String(v);
    }
    const ownerCheck = s.ownerCheck ?? 'tree';
    if (!['tree', 'port'].includes(ownerCheck)) throw new LaunchError('BAD_CONFIG', `Service ${name}: ownerCheck is "tree" (default) or "port"`);
    services[name] = { ...base2, env, port, ownerCheck };
  }
  const build = (raw.build ?? []).map((b, i) => step(b, `Build step ${i + 1}`));
  const after = (raw.after ?? []).map((b, i) => step(b, `After step ${i + 1}`));
  const require = (raw.require ?? []).map((f) => {
    if (typeof f !== 'string' || !f || !insideRel(f)) throw new LaunchError('BAD_CONFIG', `"require" lists files inside the worktree, like "api/appsettings.json"`);
    return f;
  });
  const seen = new Set();
  const overlays = (raw.overlays ?? []).map((o, i) => {
    const file = String(o?.file ?? '');
    if (!file || !insideRel(file)) throw new LaunchError('BAD_CONFIG', `Overlay ${i + 1}: "file" is a path inside the worktree`);
    if (typeof o.body !== 'string') throw new LaunchError('BAD_CONFIG', `Overlay ${file}: "body" is the file's text`);
    const key = path.normalize(file).toLowerCase();
    if (seen.has(key)) throw new LaunchError('BAD_CONFIG', `Overlay ${file} is listed twice`);
    seen.add(key);
    return { file, body: o.body };
  });
  const guards = (raw.guards ?? []).map((g, i) => {
    const file = String(g?.file ?? '');
    if (!file || !insideRel(file) || /[*?{}[\]]/.test(file)) throw new LaunchError('BAD_CONFIG', `Guard ${i + 1}: "file" is one plain path inside the worktree`);
    try { new RegExp(String(g.pattern ?? ''), 'i'); } catch { throw new LaunchError('BAD_CONFIG', `Guard ${file}: "${g.pattern}" is not a valid pattern`); }
    if (!g.pattern) throw new LaunchError('BAD_CONFIG', `Guard ${file} needs a "pattern"`);
    return { file, pattern: String(g.pattern), message: String(g.message ?? `${file} matches ${g.pattern}`) };
  });
  const staleSec = Number(raw.staleStartingSec ?? DEFAULT_STALE_SEC);
  return { file: path.join(base, CONFIG_FILE), base, worktreeRoot, lockDir, slots, services, build, after, require, overlays, guards, staleSec };
}

export async function loadLaunchConfig(file) {
  let raw;
  try { raw = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) {
    throw new LaunchError('BAD_CONFIG', e.code === 'ENOENT' ? `No ${CONFIG_FILE} at ${file}` : `${file} is not valid JSON (${e.message})`);
  }
  return normalizeLaunchConfig(raw, path.dirname(path.resolve(file)));
}

/** launch-site.json in this folder or a parent, or in the main checkout of this worktree. */
export async function findLaunchConfig(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const f = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const common = await git(start, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '');
  if (common) {
    const f = path.join(path.dirname(common.trim()), CONFIG_FILE);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers

function git(cwd, args) {
  return new Promise((res, rej) => execFile('git', ['-C', cwd, ...args], { timeout: 10_000, windowsHide: true }, (e, out) => (e ? rej(e) : res(out))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (t = Date.now()) => new Date(t).toISOString().slice(0, 19);

/** Replace {name} placeholders (ports, slot, worktree, worktree_path); other braces are left alone. */
export function fill(text, slot, worktree = '', worktreePath = '') {
  const values = { ...Object.fromEntries(Object.entries(slot.ports).map(([k, v]) => [k, String(v)])), slot: slot.name, worktree, worktree_path: worktreePath };
  return String(text).replace(/\{([a-z_][a-z0-9_]*)\}/gi, (m, k) => (k in values ? values[k] : m));
}

// ---------------------------------------------------------------------------
// Lock files

export const lockPath = (cfg, slot) => path.join(cfg.lockDir, slot.lock);

export function parseLockText(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export async function readLock(file) {
  try { return parseLockText(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const LOCK_ORDER = ['worktree', 'worktree_path', 'slot', 'status'];
const lockText = (lock) => {
  const keys = [...LOCK_ORDER.filter((k) => k in lock), ...Object.keys(lock).filter((k) => !LOCK_ORDER.includes(k))];
  return keys.map((k) => `${k}=${String(lock[k]).replace(/[\r\n]+/g, ' ')}`).join('\n') + '\n';
};

/** Replace a lock in one step (write a temp file, then rename over it). */
async function writeLock(file, lock) {
  const tmp = `${file}.tmp.${process.pid}`;
  await fsp.writeFile(tmp, lockText(lock));
  await fsp.rename(tmp, file);
}

/** Every recorded pid key: <service>_pid and <service>_port_pid (and a bare pid). */
const pidKeys = (lock) => Object.keys(lock ?? {}).filter((k) => /^([a-z0-9]+_)?(port_)?pid$/.test(k) && /^\d+$/.test(lock[k]));
export const lockPids = (lock) => [...new Set(pidKeys(lock).map((k) => Number(lock[k])))];

/** starts=<pid>:<stamp>;… → Map(pid → stamp) */
export function lockStarts(lock) {
  const m = new Map();
  for (const pair of String(lock?.starts ?? '').split(';')) {
    const i = pair.indexOf(':');
    if (i > 0) m.set(Number(pair.slice(0, i)), pair.slice(i + 1));
  }
  return m;
}
const startsText = (m) => [...m].map(([p, s]) => `${p}:${String(s).replace(/[;\r\n]/g, ' ')}`).join(';');

/** Record pids (and their start stamps) in the lock. */
async function recordPids(file, lock, pids) {
  const starts = lockStarts(lock);
  for (const pid of Object.values(pids)) {
    const s = await procStamp(pid);
    if (s) starts.set(Number(pid), s);
  }
  const next = { ...lock, ...pids, heartbeat: stamp() };
  if (starts.size) next.starts = startsText(starts);
  await writeLock(file, next);
  return next;
}

/** The lock if this worktree holds it; throws NO_LOCK or OWNER_MISMATCH otherwise. */
async function ownedLock(cfg, slot, worktree) {
  const lock = await readLock(lockPath(cfg, slot));
  if (!lock) throw new LaunchError('NO_LOCK', `Slot ${slot.name} has no lock; ${worktree} doesn't hold it. Nothing changed.`);
  if (lock.worktree !== worktree) throw new LaunchError('OWNER_MISMATCH', `Slot ${slot.name} is held by ${lock.worktree}, not ${worktree}. Nothing changed.`);
  return lock;
}

/** Create the lock only if there is none: the one step two launches can't both win. */
export async function claim(cfg, slot, worktree, worktreePath, now = Date.now()) {
  await fsp.mkdir(cfg.lockDir, { recursive: true });
  const lock = { worktree, worktree_path: worktreePath, slot: slot.name, status: 'starting', ports: Object.entries(slot.ports).map(([k, v]) => `${k}=${v}`).join(','), timestamp: stamp(now) };
  try {
    const fh = await fsp.open(lockPath(cfg, slot), 'wx');
    try { await fh.writeFile(lockText(lock)); } finally { await fh.close(); }
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

/** Is any process the lock records still running (and still the same process)? */
async function lockHasLiveProcess(lock) {
  const starts = lockStarts(lock);
  for (const pid of lockPids(lock)) if (await sameProcess(pid, starts.get(pid))) return true;
  return false;
}

/** ABSENT, LIVE or STALE. A starting/restarting lock with nothing running is judged by age. */
export async function lockState(cfg, slot, now = Date.now()) {
  const file = lockPath(cfg, slot);
  const lock = await readLock(file);
  if (!lock) return 'ABSENT';
  if (await lockHasLiveProcess(lock)) return 'LIVE';
  if (lock.status === 'starting' || lock.status === 'restarting') {
    const age = (now - (await fsp.stat(file)).mtimeMs) / 1000;
    return age < cfg.staleSec ? 'LIVE' : 'STALE';
  }
  return 'STALE';
}

// ---------------------------------------------------------------------------
// Overlays: per-slot files written into the worktree (say web/.env.local with the slot's
// ports), recorded in a manifest so a revert touches only what Birddog wrote, and backing
// up (then restoring) a file of yours that was already there.

const manifestPath = (cfg, worktreePath) => {
  const norm = path.resolve(worktreePath).toLowerCase();
  const leaf = path.basename(norm).replace(/[^a-z0-9._-]/gi, '_');
  return path.join(cfg.lockDir, '.launch-site', 'overlays', `${leaf}-${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 8)}.json`);
};
async function readManifest(file) {
  try { const d = JSON.parse(await fsp.readFile(file, 'utf8')); return Array.isArray(d.files) ? d.files.filter((f) => typeof f === 'string' && path.isAbsolute(f)) : []; } catch { return []; }
}
const writeManifest = (file, files) => fsp.writeFile(file, JSON.stringify({ files: [...new Set(files)] }, null, 2));

/** Is this file tracked by git? Throws when git can't tell (never guesses "untracked"). */
async function tracked(repo, rel) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, 'ls-files', '--error-unmatch', '--', `:(icase)${rel}`], { windowsHide: true }, (err) => {
      if (!err) return resolve(true);
      if (err.code === 1) return resolve(false);
      reject(new LaunchError('OVERLAY_REFUSED', `git couldn't tell whether ${rel} is tracked in ${repo}; refusing to write it.`));
    });
  });
}

async function gitExclude(repo, rel) {
  const common = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')).trim();
  if (!common) return;
  const file = path.join(common, 'info', 'exclude');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  const entry = rel.replace(/\\/g, '/');
  if (text.split(/\r?\n/).map((l) => l.trim()).includes(entry)) return;
  await fsp.appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`);
}

/** Write every overlay, or none: all checks run before the first write. */
export async function applyOverlays(cfg, slot, worktree, worktreePath, log = () => {}) {
  if (!cfg.overlays.length) return;
  const root = path.resolve(worktreePath);
  const mf = manifestPath(cfg, root);
  const recorded = await readManifest(mf);
  const plan = [];
  for (const o of cfg.overlays) {
    const target = path.resolve(root, fill(o.file, slot, worktree, worktreePath));
    if (!target.startsWith(root + path.sep)) throw new LaunchError('OVERLAY_REFUSED', `${o.file} would land outside the worktree`);
    const rel = path.relative(root, target).replace(/\\/g, '/');
    if (await tracked(root, rel)) throw new LaunchError('OVERLAY_REFUSED', `${rel} is tracked by git; Birddog won't overwrite it`);
    const ours = recorded.includes(target);
    if (!ours && fs.existsSync(target + BACKUP)) throw new LaunchError('OVERLAY_REFUSED', `${rel}${BACKUP} is a backup from an earlier launch that was never restored. Put it back over ${rel} (or delete it), then start again.`);
    plan.push({ target, rel, ours, body: fill(o.body, slot, worktree, worktreePath) });
  }
  await fsp.mkdir(path.dirname(mf), { recursive: true });
  const files = [...recorded];
  for (const p of plan) {
    await fsp.mkdir(path.dirname(p.target), { recursive: true });
    if (!p.ours && fs.existsSync(p.target)) {
      await fsp.copyFile(p.target, p.target + BACKUP);
      await gitExclude(root, p.rel + BACKUP);
      log(`Backed up your ${p.rel} (restored when the slot stops)`);
    }
    if (!p.ours) { files.push(p.target); await writeManifest(mf, files); } // recorded before writing
    await fsp.writeFile(p.target, p.body);
    await gitExclude(root, p.rel);
    log(`Wrote ${p.rel} for slot ${slot.name}`);
  }
}

/** Undo what the manifest says Birddog wrote. True when everything was reverted. */
export async function revertOverlays(cfg, worktreePath, log = () => {}) {
  const mf = manifestPath(cfg, worktreePath);
  const files = await readManifest(mf);
  if (!files.length) { await fsp.rm(mf, { force: true }); return true; }
  const failed = [];
  for (const f of files) {
    try {
      if (fs.existsSync(f + BACKUP)) { await fsp.rename(f + BACKUP, f); log(`Restored your ${path.basename(f)}`); } else await fsp.rm(f, { force: true });
    } catch (e) { failed.push(f); log(`OVERLAY_NOT_REVERTED ${f}: ${e.message}`); }
  }
  if (failed.length) { await writeManifest(mf, failed); return false; }
  await fsp.rm(mf, { force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Before anything is claimed: required files and guards

export async function preflight(cfg, worktreePath) {
  const missing = cfg.require.filter((f) => !fs.existsSync(path.join(worktreePath, f)));
  if (missing.length) throw new LaunchError('MISSING_FILE', `This worktree is missing ${missing.join(', ')}. Nothing was claimed.`);
  const tripped = [];
  for (const g of cfg.guards) {
    const file = path.join(worktreePath, g.file);
    if (!fs.existsSync(file)) continue;
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch (e) { tripped.push(`${g.file}: couldn't be read (${e.code ?? e.message})`); continue; }
    if (new RegExp(g.pattern, 'i').test(text)) tripped.push(`${g.file}: ${g.message}`);
  }
  if (tripped.length) throw new LaunchError('GUARD_TRIPPED', `${tripped.join('; ')}. Nothing was claimed or changed.`);
}

// ---------------------------------------------------------------------------
// The board

export async function board(cfg) {
  return Promise.all(cfg.slots.map(async (slot) => {
    const lock = await readLock(lockPath(cfg, slot));
    const ports = await Promise.all(Object.entries(slot.ports).map(async ([name, port]) => ({ name, port, up: await portOpen(port) })));
    const up = ports.some((p) => p.up);
    return {
      slot: slot.name, free: !lock && !up, ports, lockFile: lockPath(cfg, slot),
      worktree: lock?.worktree ?? null, worktreePath: lock?.worktree_path ?? null, status: lock?.status ?? (up ? 'orphan' : null), since: lock?.timestamp ?? null,
    };
  }));
}

/** Clear locks with nothing running (reverting their overlays first; a lock whose overlays can't be reverted stays). */
export async function sweepStale(cfg, log = () => {}) {
  const cleared = [];
  for (const slot of cfg.slots) {
    if ((await lockState(cfg, slot)) !== 'STALE') continue;
    const lock = await readLock(lockPath(cfg, slot));
    if (lock?.worktree_path && !(await revertOverlays(cfg, lock.worktree_path, log))) { log(`Kept the stale lock on ${slot.name} until its overlays can be reverted`); continue; }
    await fsp.rm(lockPath(cfg, slot), { force: true });
    log(`Cleared a stale lock on ${slot.name}`);
    cleared.push(slot.name);
  }
  return cleared;
}

export async function findSlotFor(cfg, worktree) {
  for (const slot of cfg.slots) if ((await readLock(lockPath(cfg, slot)))?.worktree === worktree) return slot;
  return null;
}

// ---------------------------------------------------------------------------
// Running things

function run(command, { cwd, env, timeoutSec, logFile }) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32' });
    const timer = setTimeout(() => { killTree(child.pid); }, timeoutSec * 1000);
    child.on('exit', (code) => { clearTimeout(timer); fs.closeSync(out); resolve(code ?? 1); });
    child.on('error', () => { clearTimeout(timer); resolve(127); });
  });
}

/** Start a service detached (it outlives this command), logging to logFile. Returns its pid. */
function launch(command, { cwd, env, logFile }) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

const logsDir = (cfg) => path.join(cfg.lockDir, '.launch-site', 'logs');
const serviceEnv = (s, slot, worktree, wtPath) => Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, fill(v, slot, worktree, wtPath)]));

async function tail(file, lines = 15) {
  const t = await fsp.readFile(file, 'utf8').catch(() => '');
  return t.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

/**
 * Wait for every service's port, all at once. A service whose process exits first fails at
 * once; a port answered by a process this launch didn't start fails as FOREIGN_LISTENER.
 * Returns { ok, failed, seconds, portPids }.
 */
async function waitReady(slot, services, pids, log) {
  const start = Date.now();
  const left = new Map(services);
  const failed = [];
  const portPids = {};
  while (left.size) {
    for (const [name, s] of [...left]) {
      const port = slot.ports[s.port];
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      if (await portOpen(port)) {
        const owner = await portOwner(port);
        const ours = s.ownerCheck === 'port' || owner == null ? true : await isOurs(owner, [pids[name]]);
        if (ours === false) {
          failed.push(`FOREIGN_LISTENER: port ${port} (${name}) is held by pid ${owner}, which this launch didn't start`);
        } else {
          if (owner) portPids[`${name}_port_pid`] = owner;
          log(`READY ${name} on port ${port} after ${secs}s${ours === undefined ? " (couldn't check who owns the port)" : ''}`);
        }
        left.delete(name);
        continue;
      }
      if (!alive(pids[name])) { failed.push(`${name} exited before opening port ${port}`); left.delete(name); continue; }
      if (Date.now() - start > s.timeoutSec * 1000) { failed.push(`${name}: port ${port} not open after ${s.timeoutSec}s`); left.delete(name); }
    }
    if (left.size) await sleep(250);
  }
  return { ok: !failed.length, failed, seconds: (Date.now() - start) / 1000, portPids };
}

/**
 * Stop what the lock records (for some services, or all), stop listeners on their ports that
 * our processes started, and leave everything else alone. With `sweepPorts` (cleanup --ports
 * only) whatever listens on the slot's ports is stopped too. Then revert the overlays and
 * release the lock, but only when that all checked out.
 */
async function teardown(cfg, slot, lock, log, { keepLock = false, services, sweepPorts = false } = {}) {
  const starts = lockStarts(lock);
  const keys = pidKeys(lock).filter((k) => !services || services.some((s) => k.startsWith(`${s}_`)));
  const roots = []; // recorded pids that are still the process we started (alive or not, by stamp)
  let killFailed = false;
  for (const k of keys) {
    const pid = Number(lock[k]);
    if (!alive(pid)) { roots.push(pid); continue; } // a dead launcher still names its orphaned children
    if (!(await sameProcess(pid, starts.get(pid)))) { log(`pid ${pid} now belongs to another process (started after this lock recorded it); not stopped`); continue; }
    roots.push(pid);
    if (await killTree(pid)) log(`Stopped ${k.replace(/_(port_)?pid$/, '')} (pid ${pid})`);
    else { log(`STILL_ALIVE pid ${pid} after a kill`); killFailed = true; }
  }
  const names = services ? services.map((s) => cfg.services[s]?.port).filter(Boolean) : Object.keys(slot.ports);
  const ports = [...new Set(names.map((n) => slot.ports[n]))];
  const foreign = [];
  let ourStill = [];
  for (let t = 0; t < 5000; t += 250) {
    ourStill = [];
    foreign.length = 0;
    for (const port of ports) {
      if (!(await portOpen(port))) continue;
      const owner = await portOwner(port);
      const ours = owner ? await isOurs(owner, roots) : undefined;
      if (owner && (ours || sweepPorts)) {
        if (await killTree(owner)) log(`Stopped pid ${owner} on port ${port}${ours ? '' : ' (not started by this slot; cleanup --ports)'}`);
        ourStill.push(port);
      } else if (ours === false) foreign.push({ port, pid: owner });
      else ourStill.push(port); // can't tell who it is: don't call the slot free
    }
    if (!ourStill.length) break;
    await sleep(250);
  }
  for (const f of foreign) log(`FOREIGN_LISTENER port ${f.port} (pid ${f.pid}) wasn't started by this slot; left running`);
  let verified = !ourStill.length && !killFailed;
  if (ourStill.length) log(`Ports still answering: ${ourStill.join(', ')}`);
  if (verified && !keepLock) {
    if (lock.worktree_path && !(await revertOverlays(cfg, lock.worktree_path, log))) { verified = false; log('Kept the lock: an overlay could not be reverted (close the file and stop again).'); }
    if (verified) { await fsp.rm(lockPath(cfg, slot), { force: true }); log(`Released slot ${slot.name}`); }
  }
  if (!verified && !keepLock) log(`Kept the lock on ${slot.name}: it isn't verified free yet.`);
  return { verified, portsStillUp: ourStill, foreign: foreign.map((f) => f.port) };
}

/** Resolve a worktree name or path to { name, path }. "." (or nothing) is the current checkout. */
export async function resolveWorktree(cfg, worktree, cwd = process.cwd()) {
  if (!worktree || worktree === '.') {
    const top = (await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
    if (!top) throw new LaunchError('NO_WORKTREE', `${cwd} is not inside a git checkout`);
    const p = path.resolve(top);
    return { name: path.basename(p), path: p };
  }
  const p = path.isAbsolute(worktree) ? worktree : path.join(cfg.worktreeRoot, worktree);
  if (!fs.existsSync(p)) throw new LaunchError('NO_WORKTREE', `No worktree at ${p}`);
  return { name: path.basename(p), path: path.resolve(p) };
}

async function runAfter(cfg, slot, worktree, worktreePath, log) {
  const failed = [];
  for (const [i, a] of cfg.after.entries()) {
    const logFile = path.join(logsDir(cfg), `${slot.name}-after.log`);
    log(`After step ${i + 1}/${cfg.after.length}: ${a.command}`);
    const code = await run(fill(a.command, slot, worktree, worktreePath), { cwd: path.join(worktreePath, a.cwd), env: {}, timeoutSec: a.timeoutSec, logFile });
    if (code !== 0) { failed.push(i + 1); log(`After step ${i + 1} failed (exit ${code}); the slot stays up. Last lines of ${logFile}:\n${await tail(logFile)}`); }
  }
  return failed;
}

/**
 * Check, claim a slot, write overlays, build, start every service, wait until all are
 * ready, mark the slot live, run the after steps.
 */
export async function startSlot(cfg, { worktree, worktreePath, slot: forced, skipBuild = false, open = false, log = () => {} }) {
  if (!fs.existsSync(worktreePath)) throw new LaunchError('NO_WORKTREE', `No worktree at ${worktreePath}`);
  const already = await findSlotFor(cfg, worktree);
  if (already) throw new LaunchError('ALREADY_RUNNING', `${worktree} already holds slot ${already.name}. Stop or restart it instead.`);
  await preflight(cfg, worktreePath);
  await sweepStale(cfg, log);
  const rows = await board(cfg);
  const pick = forced ? rows.find((r) => r.slot === forced) : rows.find((r) => r.free);
  if (forced && !pick) throw new LaunchError('NO_SLOT', `No slot called ${forced}`);
  if (!pick || !pick.free) throw new LaunchError('NO_SLOT', forced ? `Slot ${forced} is busy (${pick.worktree ?? 'ports in use'})` : 'Every slot is busy. Stop one, or add a slot to launch-site.json.');
  const slot = cfg.slots.find((s) => s.name === pick.slot);
  if (!(await claim(cfg, slot, worktree, worktreePath))) throw new LaunchError('NO_SLOT', `Someone claimed ${slot.name} first. Try again.`);
  log(`Claimed slot ${slot.name} for ${worktree}`);
  const file = lockPath(cfg, slot);
  await fsp.mkdir(logsDir(cfg), { recursive: true });
  const release = async (why) => {
    const reverted = await revertOverlays(cfg, worktreePath, log);
    if (reverted) await fsp.rm(file, { force: true });
    throw new LaunchError('START_FAILED', `${why} ${reverted ? `Released slot ${slot.name}` : `Kept slot ${slot.name} until its overlays can be reverted`}; nothing was started.`);
  };

  try { await applyOverlays(cfg, slot, worktree, worktreePath, log); } catch (e) { await release(e.message); }
  if (!skipBuild) {
    for (const [i, b] of cfg.build.entries()) {
      const logFile = path.join(logsDir(cfg), `${slot.name}-build.log`);
      log(`Building (${i + 1}/${cfg.build.length}): ${b.command}`);
      const code = await run(fill(b.command, slot, worktree, worktreePath), { cwd: path.join(worktreePath, b.cwd), env: {}, timeoutSec: b.timeoutSec, logFile });
      if (code !== 0) await release(`Build step ${i + 1} failed (exit ${code}). Last lines of ${logFile}:\n${await tail(logFile)}`);
      await writeLock(file, { ...(await ownedLock(cfg, slot, worktree)), heartbeat: stamp() });
    }
  }
  for (const [name, port] of Object.entries(slot.ports)) {
    if (await portOpen(port)) await release(`Port ${port} (${name}) is already in use by something else.`);
  }
  const services = Object.entries(cfg.services);
  for (const [name, s] of services) if (!fs.existsSync(path.join(worktreePath, s.cwd))) await release(`Service ${name}: no folder ${path.join(worktreePath, s.cwd)}.`);

  const pids = {};
  let lock = await ownedLock(cfg, slot, worktree);
  for (const [name, s] of services) {
    const logFile = path.join(logsDir(cfg), `${slot.name}-${name}.log`);
    pids[name] = launch(fill(s.command, slot, worktree, worktreePath), { cwd: path.join(worktreePath, s.cwd), env: serviceEnv(s, slot, worktree, worktreePath), logFile });
    // Recorded straight away, so a later failure can always find and stop it.
    lock = await recordPids(file, lock, { [`${name}_pid`]: pids[name] });
    log(`Started ${name} (pid ${pids[name]}), log: ${logFile}`);
  }
  const ready = await waitReady(slot, services, pids, log);
  if (!ready.ok) {
    const logs = await Promise.all(services.map(async ([n]) => `--- ${n} ---\n${await tail(path.join(logsDir(cfg), `${slot.name}-${n}.log`))}`));
    await teardown(cfg, slot, await ownedLock(cfg, slot, worktree), log);
    throw new LaunchError('START_FAILED', `${ready.failed.join('; ')}\n${logs.join('\n')}`);
  }
  lock = await recordPids(file, await ownedLock(cfg, slot, worktree), ready.portPids);
  await writeLock(file, { ...lock, status: 'live' });
  const urls = Object.fromEntries(Object.entries(slot.ports).map(([k, v]) => [k, `http://localhost:${v}`]));
  log(`LIVE slot ${slot.name} for ${worktree} in ${ready.seconds.toFixed(1)}s`);
  const afterFailed = await runAfter(cfg, slot, worktree, worktreePath, log);
  if (open) openUrl(urls.web ?? Object.values(urls).at(-1));
  return { slot: slot.name, worktree, ports: slot.ports, urls, seconds: ready.seconds, afterFailed };
}

export async function stopSlot(cfg, { worktree, log = () => {} }) {
  const slot = await findSlotFor(cfg, worktree);
  if (!slot) throw new LaunchError('NO_LOCK', `${worktree} doesn't hold a slot. Nothing to stop.`);
  return { slot: slot.name, ...(await teardown(cfg, slot, await ownedLock(cfg, slot, worktree), log)) };
}

/** Restart one service (or all), keeping the slot claimed throughout. */
export async function restartSlot(cfg, { worktree, service, log = () => {} }) {
  const slot = await findSlotFor(cfg, worktree);
  if (!slot) throw new LaunchError('NO_LOCK', `${worktree} doesn't hold a slot. Start it instead.`);
  const names = service && service !== 'all' ? [service] : Object.keys(cfg.services);
  for (const n of names) if (!cfg.services[n]) throw new LaunchError('BAD_SERVICE', `No service called ${n}. Services: ${Object.keys(cfg.services).join(', ')}`);
  const file = lockPath(cfg, slot);
  let lock = await ownedLock(cfg, slot, worktree);
  await writeLock(file, { ...lock, status: 'restarting', heartbeat: stamp() }); // a lock with nothing running stays LIVE while restarting
  const down = await teardown(cfg, slot, lock, log, { keepLock: true, services: names });
  if (!down.verified) throw new LaunchError('STOP_FAILED', `Couldn't stop ${names.join(', ')}; the slot is still yours.`);
  if (down.foreign.length) throw new LaunchError('FOREIGN_LISTENER', `Something else now holds port ${down.foreign.join(', ')}; the slot is still yours.`);
  lock = await ownedLock(cfg, slot, worktree);
  for (const n of names) { delete lock[`${n}_pid`]; delete lock[`${n}_port_pid`]; }
  const pids = {};
  for (const n of names) {
    const s = cfg.services[n];
    pids[n] = launch(fill(s.command, slot, worktree, lock.worktree_path), { cwd: path.join(lock.worktree_path, s.cwd), env: serviceEnv(s, slot, worktree, lock.worktree_path), logFile: path.join(logsDir(cfg), `${slot.name}-${n}.log`) });
    lock = await recordPids(file, lock, { [`${n}_pid`]: pids[n] });
    log(`Started ${n} (pid ${pids[n]})`);
  }
  const ready = await waitReady(slot, names.map((n) => [n, cfg.services[n]]), pids, log);
  if (!ready.ok) throw new LaunchError('START_FAILED', `${ready.failed.join('; ')}. The slot is still yours; stop it or try again.`);
  lock = await recordPids(file, await ownedLock(cfg, slot, worktree), ready.portPids);
  await writeLock(file, { ...lock, status: 'live' });
  return { slot: slot.name, restarted: names, seconds: ready.seconds };
}

/**
 * Stop every slot whatever worktree holds it (what the locks record), and revert overlays left
 * by launches that lost their lock. With sweepPorts, also stop anything else listening on slot
 * ports (orphans from a crash): only when you ask for it.
 */
export async function cleanupSlots(cfg, { log = () => {}, sweepPorts = false } = {}) {
  const out = [];
  for (const slot of cfg.slots) {
    const lock = await readLock(lockPath(cfg, slot));
    if (!lock && !sweepPorts) continue;
    out.push({ slot: slot.name, worktree: lock?.worktree ?? null, ...(await teardown(cfg, slot, lock ?? {}, log, { sweepPorts })) });
  }
  const held = new Set();
  for (const slot of cfg.slots) { const l = await readLock(lockPath(cfg, slot)); if (l?.worktree_path) held.add(manifestPath(cfg, l.worktree_path)); }
  const dir = path.join(cfg.lockDir, '.launch-site', 'overlays');
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    const mf = path.join(dir, f);
    if (held.has(mf) || !f.endsWith('.json')) continue;
    const files = await readManifest(mf);
    for (const target of files) {
      if (fs.existsSync(target + BACKUP)) await fsp.rename(target + BACKUP, target).catch(() => {}); else await fsp.rm(target, { force: true });
    }
    await fsp.rm(mf, { force: true });
    log(`Reverted ${files.length} overlay file(s) left by a launch that lost its lock`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI: birddog slot <command>

export const SLOT_HELP = `
  birddog slot: run several copies of your app at once, one per worktree.

    birddog slot status  [--json]
    birddog slot start   [--worktree <name|path>] [--slot <name>] [--skip-build] [--open]
    birddog slot stop    [--worktree <name|path>]
    birddog slot restart [--worktree <name|path>] [--service <name>|all]
    birddog slot cleanup [--ports]      --ports also stops anything else on slot ports

  --worktree defaults to the checkout you're in. Settings: launch-site.json at the top
  of your repo (found from here, or from the main checkout of this worktree), or --config <file>.
`;

const FLAGS = new Set(['json', 'skip-build', 'open', 'ports']);

export async function slotCommand(argv, { out = console.log, err = console.error, cwd = process.cwd() } = {}) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z-]+)$/.exec(rest[i]);
    if (!m) { err(`birddog slot: unexpected "${rest[i]}"`); return 2; }
    if (FLAGS.has(m[1])) opts[m[1]] = true;
    else opts[m[1]] = rest[++i];
  }
  if (!cmd || cmd === 'help' || opts.help) { out(SLOT_HELP); return 0; }
  if (!['status', 'start', 'stop', 'restart', 'cleanup'].includes(cmd)) { err(`birddog slot: unknown command "${cmd}"\n${SLOT_HELP}`); return 2; }
  try {
    const file = opts.config ? path.resolve(cwd, opts.config) : await findLaunchConfig(cwd);
    if (!file) throw new LaunchError('NO_CONFIG', `No ${CONFIG_FILE} here or in your main checkout. See "Launch slots" in Birddog's README, or ask Claude to set one up (the launch-site skill).`);
    const cfg = await loadLaunchConfig(file);
    const log = (m) => out(m);
    if (cmd === 'status') {
      const rows = await board(cfg);
      if (opts.json) { out(JSON.stringify(rows, null, 2)); return 0; }
      for (const r of rows) {
        const ports = r.ports.map((p) => `${p.name}:${p.port}${p.up ? ' up' : ''}`).join('  ');
        out(`[${r.slot}] ${r.free ? 'FREE' : 'BUSY'}  ${ports}${r.worktree ? `  ${r.status} · ${r.worktree} since ${r.since}` : r.status === 'orphan' ? '  something is listening, with no lock' : ''}`);
      }
      return 0;
    }
    if (cmd === 'cleanup') {
      const res = await cleanupSlots(cfg, { log, sweepPorts: !!opts.ports });
      if (!res.length) log('No slot holds a lock.');
      return res.every((r) => r.verified) ? 0 : 1;
    }
    const wt = await resolveWorktree(cfg, opts.worktree, cwd);
    if (cmd === 'start') {
      const r = await startSlot(cfg, { worktree: wt.name, worktreePath: wt.path, slot: opts.slot, skipBuild: !!opts['skip-build'], open: !!opts.open, log });
      out(Object.entries(r.urls).map(([k, u]) => `${k}: ${u}`).join('\n'));
      return 0;
    }
    if (cmd === 'stop') return (await stopSlot(cfg, { worktree: wt.name, log })).verified ? 0 : 1;
    await restartSlot(cfg, { worktree: wt.name, service: opts.service, log });
    return 0;
  } catch (e) {
    err(e instanceof LaunchError ? e.message : `birddog slot: ${e.message}`);
    return 1;
  }
}
