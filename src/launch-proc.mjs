// Processes and ports for launch slots, on macOS, Linux and Windows.
//
//   portOpen(port)          does anything accept connections on 127.0.0.1:port?
//   portOwner(port)         the pid listening there: a number, null (nobody), or undefined (can't tell)
//   procStamp(pid)          when a process started, as an opaque string: a pid plus its stamp names
//                           one process even after the OS hands the pid to someone else
//   isOurs(pid, roots)      is pid one of roots, or started by one of them? true / false / undefined
//   killTree(pid)           stop a process and everything it started
//
// Lookups shell out to what each OS has: lsof and ps on macOS and Linux (plus /proc on
// Linux), netstat and PowerShell on Windows. When a tool is missing the answer is
// "undefined", and callers treat that as "can't tell" rather than "free" or "ours".

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';

const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exec(cmd, args, { timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : err.code === 'ENOENT' ? 'ENOENT' : 1) : 0, out: String(stdout ?? '') });
    });
  });
}
const powershell = (script) => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000 });

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

/** When the process started (opaque string), or null when it's gone or the OS won't say. */
export async function procStamp(pid) {
  const n = Number(pid);
  if (!alive(n)) return null;
  if (process.platform === 'linux') {
    const t = await fsp.readFile(`/proc/${n}/stat`, 'utf8').catch(() => null);
    if (!t) return null;
    return t.slice(t.lastIndexOf(')') + 2).split(' ')[19] ?? null; // field 22: start time in clock ticks
  }
  const r = WIN
    ? await powershell(`(Get-Process -Id ${n} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`)
    : await exec('ps', ['-o', 'lstart=', '-p', String(n)]);
  const s = r.out.trim();
  return r.ok && s ? s.replace(/\s+/g, ' ') : null;
}

/** Same pid and, when we know it, the same start stamp: the same process. */
export async function sameProcess(pid, stamp) {
  if (!alive(pid)) return false;
  if (!stamp) return true;
  const now = await procStamp(pid);
  return !now || now === stamp; // an unreadable stamp counts as the same (safe for "is it running")
}

/** Who listens on a local TCP port: pid, null (nobody), or undefined (can't tell). */
export async function portOwner(port) {
  if (WIN) {
    const r = await exec('netstat.exe', ['-ano']);
    if (!r.ok) return undefined;
    for (const line of r.out.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/);
      if (f[0] !== 'TCP' || f[3] !== 'LISTENING') continue;
      if (f[1].endsWith(`:${port}`)) return Number(f[4]);
    }
    return null;
  }
  const r = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (r.code === 'ENOENT') return undefined;
  const pid = Number(r.out.split('\n').find(Boolean));
  if (pid) return pid;
  // lsof found nothing it can see: nobody, unless the port answers (then it's someone else's user).
  return (await portOpen(port)) ? undefined : null;
}

/** pid → parent pid for every process (and process group on macOS / Linux), or null. */
async function processTable() {
  if (WIN) {
    const r = await powershell('Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }');
    if (!r.ok) return null;
    const t = new Map();
    for (const l of r.out.split(/\r?\n/)) { const [p, pp] = l.trim().split(/\s+/).map(Number); if (p) t.set(p, { ppid: pp, pgid: null }); }
    return t;
  }
  const r = await exec('ps', ['-A', '-o', 'pid=,ppid=,pgid=']);
  if (!r.ok) return null;
  const t = new Map();
  for (const l of r.out.split('\n')) { const [p, pp, pg] = l.trim().split(/\s+/).map(Number); if (p) t.set(p, { ppid: pp, pgid: pg }); }
  return t;
}

/**
 * Is pid one of roots or started by one of them? Services start in their own process group
 * (on macOS / Linux the group id is the launcher's pid), so a child that outlived its launcher
 * still counts. undefined when the process table can't be read.
 */
export async function isOurs(pid, roots) {
  const want = new Set(roots.map(Number).filter(Boolean));
  if (!pid || !want.size) return false;
  if (want.has(Number(pid))) return true;
  const table = await processTable();
  if (!table) return undefined;
  const row = table.get(Number(pid));
  if (row?.pgid && want.has(row.pgid)) return true;
  let cur = Number(pid);
  for (let i = 0; i < 32; i++) {
    const r = table.get(cur);
    if (!r || !r.ppid || r.ppid === cur) return false;
    if (want.has(r.ppid)) return true;
    cur = r.ppid;
  }
  return false;
}

/** Stop a process and everything it started. Resolves true when it's gone. */
export async function killTree(pid, { graceMs = 4000 } = {}) {
  const n = Number(pid);
  if (!alive(n)) return true;
  if (WIN) {
    await exec('taskkill.exe', ['/PID', String(n), '/T', '/F']);
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

/** Open a URL in the default browser. */
export function openUrl(url) {
  if (!/^https?:\/\//.test(url)) return;
  if (WIN) execFile('cmd.exe', ['/d', '/c', 'start', '""', url], { windowsHide: true }, () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
}
