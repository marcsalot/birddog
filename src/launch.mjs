// Launch slots: run several copies of the same app at once, one per git worktree,
// each in its own "slot" (a named set of ports plus a lock file), so they never
// collide and anyone (you, Claude, Birddog's Worktrees page) can see what is live.
//
//   birddog slot status                       every slot: ports, lock, free or not
//   birddog slot start  [--worktree X]        claim the first free slot, build, start, wait until ready
//   birddog slot stop   [--worktree X]        stop the slot this worktree holds
//   birddog slot restart --service api        restart one service, leave the rest running
//   birddog slot cleanup                      stop every slot Birddog's locks record
//
// Settings live in launch-site.json at the top of your repo (see README "Launch slots").
//
// Rules that keep parallel launches safe:
//   - A slot is free only with no lock AND none of its ports answering.
//   - Claiming creates the lock exclusively (O_EXCL): two launches can't both win.
//   - Every change checks that the caller's worktree holds the lock (OWNER_MISMATCH).
//   - Stopping kills only the process trees the lock records, then checks the ports
//     are quiet before it lets go of the lock. A port held by something the lock
//     doesn't record is reported, never killed.
//
// Lock files are plain key=value lines (worktree, worktree_path, slot, status,
// <service>_pid, ports, timestamp, heartbeat), the format Birddog's Worktrees page reads.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export const CONFIG_FILE = 'launch-site.json';
const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_STALE_SEC = 300;
const PORT_NAME = /^[a-z][a-z0-9_]{0,19}$/i;

export class LaunchError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

// ---------------------------------------------------------------------------
// Config

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
  const services = {};
  for (const [name, s] of Object.entries(raw.services ?? {})) {
    if (!/^[a-z][a-z0-9]{0,19}$/.test(name)) throw new LaunchError('BAD_CONFIG', `Service "${name}": use lowercase letters and digits`);
    if (typeof s?.command !== 'string' || !s.command.trim()) throw new LaunchError('BAD_CONFIG', `Service ${name} needs a "command"`);
    const port = String(s.port ?? name);
    for (const slot of slots) if (!(port in slot.ports)) throw new LaunchError('BAD_CONFIG', `Service ${name} waits on port "${port}", which slot ${slot.name} doesn't define`);
    const cwd = String(s.cwd ?? '.');
    if (path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) throw new LaunchError('BAD_CONFIG', `Service ${name}: "cwd" is a folder inside the worktree`);
    const env = {};
    for (const [k, v] of Object.entries(s.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new LaunchError('BAD_CONFIG', `Service ${name}: "${k}" is not an environment variable name`);
      env[k] = String(v);
    }
    const timeoutSec = Number(s.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
    if (!(timeoutSec > 0 && timeoutSec <= 1800)) throw new LaunchError('BAD_CONFIG', `Service ${name}: timeoutSec is 1 to 1800`);
    services[name] = { command: s.command, cwd, env, port, timeoutSec };
  }
  const build = (raw.build ?? []).map((b, i) => {
    if (typeof b?.command !== 'string' || !b.command.trim()) throw new LaunchError('BAD_CONFIG', `Build step ${i + 1} needs a "command"`);
    const cwd = String(b.cwd ?? '.');
    if (path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) throw new LaunchError('BAD_CONFIG', `Build step ${i + 1}: "cwd" is a folder inside the worktree`);
    return { command: b.command, cwd, timeoutSec: Number(b.timeoutSec ?? 600) };
  });
  const staleSec = Number(raw.staleStartingSec ?? DEFAULT_STALE_SEC);
  return { file: path.join(base, CONFIG_FILE), base, worktreeRoot, lockDir, slots, services, build, staleSec };
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

const git = (cwd, args) => new Promise((res, rej) => execFile('git', ['-C', cwd, ...args], { timeout: 10_000, windowsHide: true }, (e, out) => (e ? rej(e) : res(out))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (t = Date.now()) => new Date(t).toISOString().slice(0, 19);

/** Replace {name} placeholders (ports, slot, worktree, worktree_path); other braces are left alone. */
export function fill(text, slot, worktree = '', worktreePath = '') {
  const values = { ...Object.fromEntries(Object.entries(slot.ports).map(([k, v]) => [k, String(v)])), slot: slot.name, worktree, worktree_path: worktreePath };
  return String(text).replace(/\{([a-z_][a-z0-9_]*)\}/gi, (m, k) => (k in values ? values[k] : m));
}

export function portOpen(port, { host = '127.0.0.1', timeout = 400 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export function alive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Kill a process and everything it started. Resolves true when it's gone. */
export async function killTree(pid, { graceMs = 4000 } = {}) {
  const n = Number(pid);
  if (!alive(n)) return true;
  if (process.platform === 'win32') {
    await new Promise((r) => execFile('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true }, () => r()));
  } else {
    // Services start in their own process group (detached), so -pid reaches the whole tree.
    const signal = (sig) => { try { process.kill(-n, sig); } catch { try { process.kill(n, sig); } catch { /* gone */ } } };
    signal('SIGTERM');
    for (let t = 0; t < graceMs && alive(n); t += 100) await sleep(100);
    if (alive(n)) signal('SIGKILL');
  }
  for (let t = 0; t < 3000 && alive(n); t += 100) await sleep(100);
  return !alive(n);
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

export const lockPids = (lock) => Object.entries(lock ?? {}).filter(([k, v]) => /_pid$|^pid$/.test(k) && /^\d+$/.test(v)).map(([, v]) => Number(v));

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

/** ABSENT, LIVE or STALE. A starting/restarting lock with nothing running is judged by age. */
export async function lockState(cfg, slot, now = Date.now()) {
  const file = lockPath(cfg, slot);
  const lock = await readLock(file);
  if (!lock) return 'ABSENT';
  if (lockPids(lock).some(alive)) return 'LIVE';
  if (lock.status === 'starting' || lock.status === 'restarting') {
    const age = (now - (await fsp.stat(file)).mtimeMs) / 1000;
    return age < cfg.staleSec ? 'LIVE' : 'STALE';
  }
  return 'STALE';
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

export async function sweepStale(cfg, log = () => {}) {
  const cleared = [];
  for (const slot of cfg.slots) {
    if ((await lockState(cfg, slot)) !== 'STALE') continue;
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

async function tail(file, lines = 15) {
  const t = await fsp.readFile(file, 'utf8').catch(() => '');
  return t.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

/** Wait for every service's port, all at once. A service whose process exits first fails at once. */
async function waitReady(slot, services, pids, log) {
  const start = Date.now();
  const left = new Map(services.map(([name, s]) => [name, s]));
  const failed = [];
  while (left.size) {
    for (const [name, s] of [...left]) {
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      if (await portOpen(slot.ports[s.port])) { log(`READY ${name} on port ${slot.ports[s.port]} after ${secs}s`); left.delete(name); continue; }
      if (!alive(pids[name])) { failed.push(`${name} exited before opening port ${slot.ports[s.port]}`); left.delete(name); continue; }
      if (Date.now() - start > s.timeoutSec * 1000) { failed.push(`${name}: port ${slot.ports[s.port]} not open after ${s.timeoutSec}s`); left.delete(name); }
    }
    if (left.size) await sleep(250);
  }
  return { ok: !failed.length, failed, seconds: (Date.now() - start) / 1000 };
}

/** Kill what the lock records, check the slot's ports are quiet, and only then release the lock. */
async function teardown(cfg, slot, lock, log, { keepLock = false, services } = {}) {
  const keys = Object.keys(lock).filter((k) => /_pid$/.test(k) && (!services || services.some((s) => k.startsWith(`${s}_`))));
  for (const k of keys) {
    const pid = Number(lock[k]);
    if (!alive(pid)) continue;
    if (await killTree(pid)) log(`Stopped ${k.replace(/_pid$/, '')} (pid ${pid})`);
    else log(`STILL_ALIVE pid ${pid} after a kill`);
  }
  const portNames = services ? services.map((s) => cfg.services[s]?.port).filter(Boolean) : Object.keys(slot.ports);
  let still = [];
  for (let t = 0; t < 5000; t += 250) {
    still = [];
    for (const n of portNames) if (await portOpen(slot.ports[n])) still.push(slot.ports[n]);
    if (!still.length) break;
    await sleep(250);
  }
  const stillPids = keys.map((k) => Number(lock[k])).filter(alive);
  const verified = !still.length && !stillPids.length;
  if (still.length) log(`Ports still answering: ${still.join(', ')}. If Birddog didn't start what's on them, it's left alone.`);
  if (verified && !keepLock) { await fsp.rm(lockPath(cfg, slot), { force: true }); log(`Released slot ${slot.name}`); }
  if (!verified) log(`Kept the lock on ${slot.name}: it isn't verified free yet.`);
  return { verified, portsStillUp: still };
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

/**
 * Claim a slot, build, start every service, wait until all are ready, mark the slot live.
 * Anything that fails releases the claim (before launch) or tears down what was started.
 */
export async function startSlot(cfg, { worktree, worktreePath, slot: forced, skipBuild = false, log = () => {} }) {
  if (!fs.existsSync(worktreePath)) throw new LaunchError('NO_WORKTREE', `No worktree at ${worktreePath}`);
  const already = await findSlotFor(cfg, worktree);
  if (already) throw new LaunchError('ALREADY_RUNNING', `${worktree} already holds slot ${already.name}. Stop or restart it instead.`);
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
  const release = async (why) => { await fsp.rm(file, { force: true }); throw new LaunchError('START_FAILED', `${why} Released slot ${slot.name}; nothing was started.`); };

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
  const pids = {};
  for (const [name, s] of services) {
    const cwd = path.join(worktreePath, s.cwd);
    if (!fs.existsSync(cwd)) {
      if (Object.keys(pids).length) break;
      await release(`Service ${name}: no folder ${cwd}.`);
    }
    const logFile = path.join(logsDir(cfg), `${slot.name}-${name}.log`);
    pids[name] = launch(fill(s.command, slot, worktree, worktreePath), { cwd, env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, fill(v, slot, worktree, worktreePath)])), logFile });
    // Recorded straight away, so a later failure can always find and stop it.
    await writeLock(file, { ...(await ownedLock(cfg, slot, worktree)), [`${name}_pid`]: pids[name], heartbeat: stamp() });
    log(`Started ${name} (pid ${pids[name]}), log: ${logFile}`);
  }
  const started = services.filter(([n]) => pids[n]);
  const ready = started.length === services.length ? await waitReady(slot, started, pids, log) : { ok: false, failed: ['a service folder is missing'], seconds: 0 };
  if (!ready.ok) {
    const lock = await ownedLock(cfg, slot, worktree);
    const logs = await Promise.all(started.map(async ([n]) => `--- ${n} ---\n${await tail(path.join(logsDir(cfg), `${slot.name}-${n}.log`))}`));
    await teardown(cfg, slot, lock, log);
    throw new LaunchError('START_FAILED', `${ready.failed.join('; ')}\n${logs.join('\n')}`);
  }
  await writeLock(file, { ...(await ownedLock(cfg, slot, worktree)), status: 'live', heartbeat: stamp() });
  const urls = Object.fromEntries(Object.entries(slot.ports).map(([k, v]) => [k, `http://localhost:${v}`]));
  log(`LIVE slot ${slot.name} for ${worktree} in ${ready.seconds.toFixed(1)}s`);
  return { slot: slot.name, worktree, ports: slot.ports, urls, seconds: ready.seconds };
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
  lock = await ownedLock(cfg, slot, worktree);
  const pids = {};
  for (const n of names) {
    const s = cfg.services[n];
    const logFile = path.join(logsDir(cfg), `${slot.name}-${n}.log`);
    pids[n] = launch(fill(s.command, slot, worktree, lock.worktree_path), { cwd: path.join(lock.worktree_path, s.cwd), env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, fill(v, slot, worktree, lock.worktree_path)])), logFile });
    lock = { ...lock, [`${n}_pid`]: pids[n] };
    await writeLock(file, lock);
    log(`Started ${n} (pid ${pids[n]})`);
  }
  const ready = await waitReady(slot, names.map((n) => [n, cfg.services[n]]), pids, log);
  if (!ready.ok) throw new LaunchError('START_FAILED', `${ready.failed.join('; ')}. The slot is still yours; stop it or try again.`);
  await writeLock(file, { ...(await ownedLock(cfg, slot, worktree)), status: 'live', heartbeat: stamp() });
  return { slot: slot.name, restarted: names, seconds: ready.seconds };
}

/** Stop every slot whatever worktree holds it (only what the locks record), and clear stale locks. */
export async function cleanupSlots(cfg, { log = () => {} } = {}) {
  const out = [];
  for (const slot of cfg.slots) {
    const lock = await readLock(lockPath(cfg, slot));
    if (!lock) continue;
    out.push({ slot: slot.name, worktree: lock.worktree, ...(await teardown(cfg, slot, lock, log)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI: birddog slot <command>

export const SLOT_HELP = `
  birddog slot: run several copies of your app at once, one per worktree.

    birddog slot status [--json]
    birddog slot start   [--worktree <name|path>] [--slot <name>] [--skip-build]
    birddog slot stop    [--worktree <name|path>]
    birddog slot restart [--worktree <name|path>] [--service <name>|all]
    birddog slot cleanup

  --worktree defaults to the checkout you're in. Settings: launch-site.json at the top
  of your repo (found from here, or from the main checkout of this worktree), or --config <file>.
`;

export async function slotCommand(argv, { out = console.log, err = console.error, cwd = process.cwd() } = {}) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z-]+)$/.exec(rest[i]);
    if (!m) { err(`birddog slot: unexpected "${rest[i]}"`); return 2; }
    if (['json', 'skip-build'].includes(m[1])) opts[m[1]] = true;
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
      const res = await cleanupSlots(cfg, { log });
      if (!res.length) log('No slot holds a lock.');
      return res.every((r) => r.verified) ? 0 : 1;
    }
    const wt = await resolveWorktree(cfg, opts.worktree, cwd);
    if (cmd === 'start') {
      const r = await startSlot(cfg, { worktree: wt.name, worktreePath: wt.path, slot: opts.slot, skipBuild: !!opts['skip-build'], log });
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
