// Worktrees and slots: where each ticket is being worked on, run and tested.
//
//   Worktrees  every `git worktree` of your repos: branch, ticket, uncommitted work,
//              ahead/behind the main branch, and the slot it runs in.
//   Dev slots  the local places you run the app (a set of ports each). A slot is
//              "running" when something listens on its ports, or when its lock file
//              (written by your own launch scripts, if you have them) names a live
//              process. You can also claim a slot for a worktree by hand.
//   QA slots   numbered shared test environments (QA 1 … QA 12). With a URL pattern
//              and a version path, Birddog asks each one which branch it runs; you
//              can also note who has a slot and for which ticket.
//
// Read-only for git: Birddog runs `git worktree list`, `status`, `log` and
// `rev-list`, never anything that changes a repo. Commands like "new worktree for
// this ticket" are offered for you to copy and run. Slot claims live in this
// machine's config folder (slots.json); they are your notes, not a shared lock.

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { expandHome, tildify } from './config.mjs';
import { findRepos, parseStatus, runGit, shellQuote } from './sources/git.mjs';
import { CONFIG_FILE as LAUNCH_FILE, loadLaunchConfig, lockPath as launchLockPath } from './launch.mjs';
import { readJson, writeJson } from './store.mjs';

export const DEFAULT_TICKET_PATTERN = '[A-Z][A-Z0-9]+-\\d+';
const MAX_DEV_SLOTS = 12;
const MAX_QA_SLOTS = 40;
const MAX_REPOS = 30;
const CACHE_MS = 20_000;
const QA_CACHE_MS = 60_000;
const QA_TIMEOUT_MS = 4_000;

// ---------------------------------------------------------------------------
// Settings

const isHttp = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };

/** Clean workspace settings from the UI or config.json. Throws TypeError with a message for people. */
export function normalizeWorkspace(input = {}) {
  let repos = input.repos ?? [];
  if (typeof repos === 'string') repos = repos.split(/[\n,]/);
  if (!Array.isArray(repos)) throw new TypeError('repos must be a list of folders');
  repos = [...new Set(repos.map((r) => String(r).trim()).filter(Boolean).map((r) => tildify(expandHome(r))))];
  if (repos.length > MAX_REPOS || repos.some((r) => r.length > 1024)) throw new TypeError('Too many or too long repo paths');

  const ticketPattern = String(input.ticketPattern ?? DEFAULT_TICKET_PATTERN).trim() || DEFAULT_TICKET_PATTERN;
  if (ticketPattern.length > 200) throw new TypeError('The ticket pattern is too long');
  try { new RegExp(ticketPattern, 'g'); } catch { throw new TypeError(`"${ticketPattern}" is not a valid pattern`); }
  if (new RegExp(ticketPattern).test('')) throw new TypeError('The ticket pattern must not match empty text');

  const branchPrefix = String(input.branchPrefix ?? 'feature/').trim();
  if (branchPrefix.length > 60 || !/^[\w./-]*$/.test(branchPrefix)) throw new TypeError('The branch prefix may use letters, digits, ".", "_", "/" and "-"');

  let devIn = input.devSlots ?? [1, 2, 3].map((n) => ({ label: `Dev ${n}` }));
  if (typeof devIn === 'number') devIn = Array.from({ length: devIn }, (_, i) => ({ label: `Dev ${i + 1}` }));
  if (!Array.isArray(devIn)) throw new TypeError('devSlots must be a list');
  if (devIn.length > MAX_DEV_SLOTS) throw new TypeError(`Up to ${MAX_DEV_SLOTS} dev slots`);
  const ids = new Set();
  const devSlots = devIn.map((s, n) => {
    const label = String(s?.label ?? `Dev ${n + 1}`).replace(/\s+/g, ' ').trim() || `Dev ${n + 1}`;
    if (label.length > 30) throw new TypeError(`Slot ${n + 1}: the name is too long`);
    let id = String(s?.id ?? '').trim() || `dev${n + 1}`;
    if (!/^[a-z0-9-]{1,30}$/.test(id) || ids.has(id)) id = `dev${n + 1}`;
    ids.add(id);
    let ports = s?.ports ?? [];
    if (typeof ports === 'string') ports = ports.split(/[\s,]+/).filter(Boolean);
    if (typeof ports === 'number') ports = [ports];
    if (!Array.isArray(ports)) throw new TypeError(`${label}: ports must be a list`);
    ports = [...new Set(ports.map(Number))];
    if (ports.length > 6 || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new TypeError(`${label}: ports are numbers from 1 to 65535 (up to 6)`);
    const url = String(s?.url ?? '').trim() || (ports.length ? `http://localhost:${ports[0]}` : '');
    if (url && !isHttp(url)) throw new TypeError(`${label}: the URL must start with http:// or https://`);
    const lockFile = String(s?.lockFile ?? '').trim();
    if (lockFile.length > 1024) throw new TypeError(`${label}: the lock file path is too long`);
    return { id, label, ports, url, lockFile: lockFile ? tildify(expandHome(lockFile)) : '' };
  });

  const q = input.qa ?? {};
  const count = Number(q.count ?? 0);
  if (!Number.isInteger(count) || count < 0 || count > MAX_QA_SLOTS) throw new TypeError(`The number of QA slots is 0 to ${MAX_QA_SLOTS}`);
  const pattern = String(q.pattern ?? '').trim();
  if (pattern && (!/\{n+\}/.test(pattern) || !isHttp(pattern.replace(/\{n+\}/g, '1')))) throw new TypeError('The QA URL pattern is an http(s) address with {n} where the slot number goes, like https://qa{n}.example.com');
  const versionPath = String(q.versionPath ?? '').trim();
  if (versionPath && (!versionPath.startsWith('/') || versionPath.length > 200 || /\s/.test(versionPath))) throw new TypeError('The version path starts with "/", like /api/version');
  const label = String(q.label ?? 'QA {n}').trim() || 'QA {n}';
  if (label.length > 30 || !label.includes('{n}')) throw new TypeError('The QA slot name needs {n}, like "QA {n}"');
  const launchSite = String(input.launchSite ?? '').trim();
  if (launchSite.length > 1024) throw new TypeError('The launch-site.json path is too long');
  return { repos, ticketPattern, branchPrefix, devSlots, launchSite: launchSite ? tildify(expandHome(launchSite)) : '', qa: { count, pattern, versionPath, label } };
}

/** Settings with defaults; bad config falls back to defaults rather than breaking the page. */
export function workspaceSettings(config = {}) {
  try { return normalizeWorkspace(config.workspace ?? {}); } catch { return normalizeWorkspace({}); }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)

/** Ticket keys in some text ("feature/PROJ-123-login" → ["PROJ-123"]), upper-cased, unique, in order. */
export function ticketKeys(text, pattern = DEFAULT_TICKET_PATTERN) {
  if (!text) return [];
  const re = new RegExp(pattern, 'gi');
  return [...new Set([...String(text).matchAll(re)].map((m) => m[0].toUpperCase()))];
}

/** Parse `git worktree list --porcelain`. The first entry is the main worktree. */
export function parseWorktreeList(out) {
  const list = [];
  let cur = null;
  for (const line of String(out).split('\n')) {
    if (!line.trim()) { if (cur) list.push(cur); cur = null; continue; }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') { if (cur) list.push(cur); cur = { path: val, head: null, branch: null, bare: false, detached: false, locked: false, prunable: false }; continue; }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'bare') cur.bare = true;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) list.push(cur);
  return list.map((w, i) => ({ ...w, main: i === 0 }));
}

/** A slot lock file: JSON, or key=value lines (# comments allowed). Keys are lower-cased. */
export function parseLock(text) {
  const t = String(text ?? '').trim();
  if (!t) return {};
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      return Object.fromEntries(Object.entries(o).filter(([, v]) => ['string', 'number'].includes(typeof v)).map(([k, v]) => [k.toLowerCase(), String(v)]));
    } catch { return {}; }
  }
  const out = {};
  for (const line of t.split(/\r?\n/)) {
    const m = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1].toLowerCase()] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/** What a lock file says: the worktree, branch, ticket, process ids and when it last checked in. */
export function lockFacts(kv) {
  const pids = Object.entries(kv).filter(([k]) => k === 'pid' || k.endsWith('_pid') || k.endsWith('pid')).map(([, v]) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
  const when = kv.heartbeat ?? kv.updated ?? kv.updated_at ?? kv.started ?? kv.started_at ?? null;
  const at = when ? (/^\d{9,13}$/.test(when) ? Number(when) * (when.length <= 10 ? 1000 : 1) : Date.parse(when)) : NaN;
  // launch-site locks keep the worktree's name in "worktree" and its folder in "worktree_path".
  const looksLikePath = (v) => typeof v === 'string' && /[\\/]/.test(v);
  return {
    worktree: kv.worktree_path ?? kv.path ?? kv.cwd ?? kv.dir ?? (looksLikePath(kv.worktree) ? kv.worktree : null),
    name: kv.worktree && !looksLikePath(kv.worktree) ? kv.worktree : null,
    status: kv.status ?? null,
    branch: kv.branch ?? null,
    ticket: kv.ticket ?? null,
    pids,
    heartbeatAt: Number.isFinite(at) ? at : null,
  };
}

/** Is a process running? true / false; null when we can't tell. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM' ? true : e.code === 'ESRCH' ? false : null; }
}

/** Does something accept connections on this local port? */
export function probePort(port, { host = '127.0.0.1', timeout = 400 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** "https://qa{n}.example.com" + 7 → "https://qa7.example.com"; {nn} pads to two digits. */
export const fillN = (pattern, n) => String(pattern).replace(/\{(n+)\}/g, (_, w) => String(n).padStart(w.length, '0'));

/** The useful parts of a version endpoint's JSON, whatever it calls them. */
export function versionInfo(body) {
  if (!body || typeof body !== 'object') return null;
  const flat = { ...body, ...(typeof body.build === 'object' ? body.build : {}), ...(typeof body.git === 'object' ? body.git : {}) };
  const pick = (...keys) => { for (const k of keys) { const v = flat[k]; if (typeof v === 'string' || typeof v === 'number') return String(v); } return null; };
  const info = {
    branch: pick('branch', 'gitBranch', 'sourceBranch', 'branchName', 'ref')?.replace(/^refs\/heads\//, '') ?? null,
    sha: pick('gitSha', 'sha', 'commit', 'commitId', 'commitSha', 'revision')?.slice(0, 12) ?? null,
    build: pick('buildId', 'buildNumber', 'build', 'version', 'number'),
    deployedAt: pick('deployedAt', 'buildDate', 'builtAt', 'timestamp', 'date'),
  };
  return Object.values(info).some(Boolean) ? info : null;
}

const q = (p) => shellQuote(tildify(p));

/** The command that starts a worktree for a ticket, next to the repo: ../<repo>-<KEY>. */
export function newWorktreeCommand({ repo, key, prefix = 'feature/', base = 'origin/main' }) {
  const dir = path.join(path.dirname(repo), `${path.basename(repo)}-${key}`);
  return `git -C ${q(repo)} worktree add -b ${shellQuote(`${prefix}${key}`)} ${q(dir)} ${shellQuote(base)}`;
}

// ---------------------------------------------------------------------------
// Reading git (swappable, so the demo and tests can stand in)

async function defaultBase(dir) {
  const head = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).then((s) => s.trim()).catch(() => '');
  if (head) return head;
  for (const n of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await runGit(dir, ['rev-parse', '--verify', '--quiet', n]).then(() => true).catch(() => false)) return n;
  }
  return null;
}

export const realGit = {
  findRepos: async (roots, maxDepth) => (await Promise.all(roots.map((r) => findRepos(expandHome(r), maxDepth)))).flat(),
  worktrees: async (repo) => parseWorktreeList(await runGit(repo, ['worktree', 'list', '--porcelain'])),
  base: defaultBase,
  async inspect(dir, base) {
    const [st, last, ab] = await Promise.all([
      runGit(dir, ['status', '--porcelain=v2', '--branch', '-z']).then(parseStatus),
      runGit(dir, ['log', '-1', '--format=%ct%x00%s']).catch(() => ''),
      base ? runGit(dir, ['rev-list', '--left-right', '--count', `${base}...HEAD`]).catch(() => '') : '',
    ]);
    const [ct, subject] = last.trim().split('\0');
    const [behind, ahead] = ab.trim().split(/\s+/).map(Number);
    return {
      changed: st.changed.length, untracked: st.untracked.length, conflicts: st.changed.filter((c) => c.conflict).length,
      upstream: st.upstream, unpushed: st.upstream ? st.ahead : null,
      ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null,
      lastCommitAt: ct ? new Date(Number(ct) * 1000).toISOString() : null, lastSubject: subject ?? null,
    };
  },
  readFile: (file) => fs.readFile(expandHome(file), 'utf8'),
  exists: (file) => existsSync(file),
};

// ---------------------------------------------------------------------------
// Linking tickets across the board, worktrees and slots

/** For each ticket key: its worktrees, dev slots and QA slots. */
export function ticketLinks(ws) {
  const links = {};
  const at = (key) => (links[key] ??= { worktrees: [], dev: [], qa: [] });
  for (const r of ws.repos ?? []) for (const w of r.worktrees) if (w.ticket) at(w.ticket).worktrees.push({ path: w.display, branch: w.branch, dirty: w.changed + w.untracked });
  for (const s of ws.devSlots ?? []) if (s.ticket) at(s.ticket).dev.push({ id: s.id, label: s.label, state: s.state });
  for (const s of ws.qaSlots ?? []) {
    if (s.deployedTicket) at(s.deployedTicket).qa.push({ n: s.n, label: s.label, how: 'deployed' });
    if (s.claim?.ticket && s.claim.ticket !== s.deployedTicket) at(s.claim.ticket).qa.push({ n: s.n, label: s.label, how: 'claimed' });
  }
  return links;
}

/** Ticket key → { lane, status, summary, url } from a loaded board. */
export function ticketIndex(board) {
  const out = {};
  for (const l of board?.lanes ?? []) for (const c of l.cards) out[c.key] = { lane: l.id, laneLabel: l.label, status: c.status, summary: c.summary, url: c.url };
  return out;
}

// ---------------------------------------------------------------------------
// The service

export class SlotError extends Error {}

export function createWorkspace({ dir, getConfig, fetchImpl = fetch, now = () => Date.now(), git = realGit, probe = probePort, alive = pidAlive }) {
  const claimsFile = path.join(dir, 'slots.json');
  let cache = null;
  let qaCache = null;
  let inflight = null;
  let devIds = null; // slot ids last shown (from settings or launch-site.json)

  const loadClaims = async () => {
    const d = await readJson(claimsFile, { dev: {}, qa: {} });
    return { dev: d.dev && typeof d.dev === 'object' ? d.dev : {}, qa: d.qa && typeof d.qa === 'object' ? d.qa : {} };
  };

  async function repoList(settings, warn) {
    const explicit = settings.repos.length > 0;
    let candidates = settings.repos.map(expandHome);
    if (!explicit) {
      const g = getConfig().sources?.git ?? {};
      candidates = await git.findRepos(g.roots?.length ? g.roots : ['~/code'], g.maxDepth ?? 3).catch(() => []);
    }
    const groups = new Map(); // main worktree path → worktrees
    for (const repo of candidates.slice(0, 200)) {
      let wts;
      try { wts = await git.worktrees(repo); } catch (e) { if (explicit) warn(e.message); continue; }
      const main = wts[0]?.path;
      if (!main || groups.has(main)) continue;
      if (!explicit && wts.length < 2) continue; // auto mode: only repos that use worktrees
      groups.set(main, wts);
      if (groups.size >= MAX_REPOS) break;
    }
    return [...groups.entries()];
  }

  async function qaSlots(settings, claims) {
    const { count, pattern, versionPath, label } = settings.qa;
    const key = JSON.stringify(settings.qa);
    const fresh = qaCache && qaCache.key === key && now() - qaCache.at < QA_CACHE_MS;
    const probes = fresh ? qaCache.probes : await Promise.all(Array.from({ length: count }, async (_, i) => {
      const n = i + 1;
      if (!pattern || !versionPath) return { state: 'unknown' };
      const url = fillN(pattern, n).replace(/\/+$/, '') + versionPath;
      try {
        const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'birddog' }, signal: AbortSignal.timeout(QA_TIMEOUT_MS) });
        if (!res.ok) return { state: 'down', error: `HTTP ${res.status}` };
        const info = versionInfo(await res.json().catch(() => null));
        return info ? { state: 'up', ...info } : { state: 'up', error: 'No branch or build in the version reply' };
      } catch (e) {
        return { state: 'down', error: e.name === 'TimeoutError' ? 'No answer in 4 s' : 'Not reachable' };
      }
    }));
    if (!fresh) qaCache = { key, at: now(), probes };
    return probes.map((p, i) => {
      const n = i + 1;
      const deployedTicket = p.branch ? ticketKeys(p.branch, settings.ticketPattern)[0] ?? null : null;
      return { n, label: fillN(label, n), url: pattern ? fillN(pattern, n) : null, ...p, deployedTicket, claim: claims.qa[n] ?? null };
    });
  }

  async function load() {
    const config = getConfig();
    const settings = workspaceSettings(config);
    const warnings = [];
    const warn = (w) => warnings.push(w);
    const claims = await loadClaims();
    const keyOf = (s) => ticketKeys(s, settings.ticketPattern)[0] ?? null;

    const repos = [];
    for (const [main, wts] of await repoList(settings, warn)) {
      const base = await git.base(main).catch(() => null);
      const worktrees = await Promise.all(wts.filter((w) => !w.bare).map(async (w) => {
        let facts = { changed: 0, untracked: 0, conflicts: 0, upstream: null, unpushed: null, ahead: null, behind: null, lastCommitAt: null, lastSubject: null };
        let error = null;
        if (!w.prunable) {
          try { facts = await git.inspect(w.path, base); } catch (e) { error = e.message; }
        }
        const ticket = keyOf(w.branch) ?? keyOf(path.basename(w.path));
        return {
          path: w.path, display: tildify(w.path), repo: tildify(main), main: w.main, branch: w.branch, head: w.head?.slice(0, 12) ?? null,
          detached: w.detached, locked: w.locked, prunable: w.prunable, ticket, ...facts, error,
          commands: {
            open: `code ${q(w.path)}`,
            cd: `cd ${q(w.path)}`,
            ...(w.main ? {} : { remove: `git -C ${q(main)} worktree remove ${q(w.path)}` }),
            ...(w.prunable ? { prune: `git -C ${q(main)} worktree prune` } : {}),
          },
        };
      }));
      repos.push({ path: main, display: tildify(main), name: path.basename(main), base, worktrees });
    }
    const byPath = new Map(repos.flatMap((r) => r.worktrees.map((w) => [path.resolve(w.path), w])));

    // Dev slots come from launch-site.json when there is one (set, or found in a repo's main checkout).
    let slotDefs = settings.devSlots;
    let launch = null;
    const launchFile = settings.launchSite ? expandHome(settings.launchSite) : repos.map((r) => path.join(r.path, LAUNCH_FILE)).find((f) => git.exists?.(f));
    if (launchFile) {
      try {
        launch = await loadLaunchConfig(launchFile);
        slotDefs = launch.slots.map((x) => ({ id: x.name, label: x.name, ports: Object.values(x.ports), url: `http://localhost:${x.ports.web ?? Object.values(x.ports).at(-1)}`, lockFile: launchLockPath(launch, x) }));
      } catch (e) { warn(`${tildify(launchFile)}: ${e.message}`); }
    }

    devIds = slotDefs.map((x) => x.id);
    const devSlots = await Promise.all(slotDefs.map(async (s) => {
      const claim = claims.dev[s.id] ?? null;
      let lock = null;
      if (s.lockFile) {
        try { lock = lockFacts(parseLock(await git.readFile(s.lockFile))); } catch { lock = null; }
      }
      const listening = (await Promise.all(s.ports.map((p) => probe(p).catch(() => false)))).filter(Boolean).length;
      const pidStates = lock ? lock.pids.map(alive) : [];
      const pidsDead = pidStates.length > 0 && pidStates.every((x) => x === false);
      const state = lock ? (pidsDead && !listening ? 'stale' : ['starting', 'restarting'].includes(lock.status) && !listening ? 'starting' : 'running')
        : listening ? 'running' : claim ? 'claimed' : 'free';
      const worktreePath = lock?.worktree ?? claim?.worktree ?? null;
      const wt = worktreePath ? byPath.get(path.resolve(expandHome(worktreePath))) : null;
      const ticket = (lock?.ticket && keyOf(lock.ticket)) ?? keyOf(lock?.branch) ?? keyOf(lock?.name) ?? claim?.ticket ?? wt?.ticket ?? null;
      return {
        id: s.id, label: s.label, ports: s.ports, url: s.url || null, state, listening,
        from: lock ? 'lock file' : listening ? 'ports' : claim ? 'you' : null,
        worktree: worktreePath ? tildify(expandHome(worktreePath)) : null, branch: lock?.branch ?? wt?.branch ?? null, ticket,
        heartbeatAt: lock?.heartbeatAt ? new Date(lock.heartbeatAt).toISOString() : null,
        claim, lockFile: s.lockFile || null,
        ...(launch ? { commands: lock ? { stop: `birddog slot stop --worktree ${q(worktreePath ?? lock.name ?? '')}`, restart: `birddog slot restart --worktree ${q(worktreePath ?? lock.name ?? '')}` } : {} } : {}),
      };
    }));
    // A worktree knows the dev slot it runs in.
    for (const s of devSlots) {
      const w = s.worktree ? byPath.get(path.resolve(expandHome(s.worktree))) : null;
      if (w) w.slot = { id: s.id, label: s.label, state: s.state };
    }

    // With launch slots, a worktree that isn't running gets a "start it in a slot" command.
    if (launch) {
      const running = new Set(devSlots.map((d) => d.worktree && path.resolve(expandHome(d.worktree))).filter(Boolean));
      for (const r of repos) for (const w of r.worktrees) if (!running.has(path.resolve(w.path))) w.commands.slot = `birddog slot start --worktree ${q(w.path)}`;
    }

    const qa = await qaSlots(settings, claims);
    const ws = { settings, repos, devSlots, launchSite: launch ? tildify(launch.file) : null, qaSlots: qa, warnings, refreshedAt: new Date(now()).toISOString() };
    return { ...ws, links: ticketLinks(ws) };
  }

  function validTicket(t, settings) {
    if (t == null || t === '') return null;
    const k = ticketKeys(String(t), settings.ticketPattern)[0];
    if (!k || String(t).trim().toUpperCase() !== k) throw new SlotError(`"${String(t).slice(0, 40)}" doesn't look like a ticket key (like PROJ-123)`);
    return k;
  }
  const text = (v, max, what) => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    if (s.length > max) throw new SlotError(`${what} can be up to ${max} characters`);
    return s || null;
  };

  return {
    async get({ fresh = false } = {}) {
      if (fresh) { cache = null; qaCache = null; }
      if (cache && now() - cache.at < CACHE_MS) return cache.data;
      inflight ??= load().then((data) => { cache = { at: now(), data }; return data; }).finally(() => { inflight = null; });
      return inflight;
    },
    /** Claim a slot: kind "dev" (worktree, ticket, note) or "qa" (ticket, owner, note). */
    async claim(kind, id, body = {}) {
      const settings = workspaceSettings(getConfig());
      const claims = await loadClaims();
      let rec;
      if (kind === 'dev') {
        if (!(devIds ?? settings.devSlots.map((s) => s.id)).includes(id)) throw new SlotError(`No dev slot "${id}"`);
        const worktree = text(body.worktree, 1024, 'The worktree path');
        rec = { worktree: worktree ? tildify(expandHome(worktree)) : null, ticket: validTicket(body.ticket, settings), note: text(body.note, 200, 'The note') };
        if (!rec.worktree && !rec.ticket) throw new SlotError('Pick a worktree or enter a ticket for this slot');
      } else if (kind === 'qa') {
        const n = Number(id);
        if (!Number.isInteger(n) || n < 1 || n > settings.qa.count) throw new SlotError(`No QA slot ${String(id).slice(0, 10)}`);
        rec = { ticket: validTicket(body.ticket, settings), owner: text(body.owner, 60, 'The name'), note: text(body.note, 200, 'The note') };
        if (!rec.ticket && !rec.owner) throw new SlotError('Enter a ticket or who has this slot');
        id = String(n);
      } else throw new SlotError('kind is "dev" or "qa"');
      rec.at = new Date(now()).toISOString();
      claims[kind] = { ...claims[kind], [id]: rec };
      await writeJson(claimsFile, claims);
      cache = null;
      return rec;
    },
    async release(kind, id) {
      if (kind !== 'dev' && kind !== 'qa') throw new SlotError('kind is "dev" or "qa"');
      const claims = await loadClaims();
      const { [String(id)]: gone, ...rest } = claims[kind];
      if (!gone) throw new SlotError('That slot has no claim');
      claims[kind] = rest;
      await writeJson(claimsFile, claims);
      cache = null;
      return { ok: true };
    },
    clear() { cache = null; qaCache = null; },
  };
}
