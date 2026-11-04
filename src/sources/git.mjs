// Local git source.
//
// Scans configured folders for repositories and reports:
//   • uncommitted changes      (work that could be lost)
//   • unpushed commits         (work that exists only on this machine)
//   • merged local branches    (safe to delete)
//   • stale local branches     (no commits for `staleDays`, or the remote branch is gone)
//
// Read-only: it only runs `git status`, `for-each-ref`, `log`, `branch --merged`,
// `symbolic-ref` and `remote`. It never fetches, so it is fast and works offline.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expandHome, tildify } from '../config.mjs';
import { createItem } from '../items.mjs';
import { ago, plural, rank } from '../rules.mjs';

export const id = 'git';
export const name = 'Local git';
export const description = 'Uncommitted work, unpushed commits and branches to tidy in your local repos.';

const DAY = 86_400_000;
const GIT_TIMEOUT_MS = 10_000;
const CONCURRENCY = 6;
const MAX_BRANCH_LOGS = 40;
const PROTECTED = new Set(['main', 'master', 'develop', 'development', 'trunk']);
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'target', 'out', 'Library', 'Pods',
  '__pycache__', 'venv', 'bower_components',
]);

// ---------------------------------------------------------------------------
// Running git

export function runGit(cwd, args, { timeout = GIT_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        ...env,
        GIT_OPTIONAL_LOCKS: '0', // never take the index lock while you are working
        GIT_TERMINAL_PROMPT: '0', // never hang on a credential prompt
        LC_ALL: 'C',
      },
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const why = err.killed
        ? `timed out after ${timeout / 1000}s`
        : (String(stderr).trim().split('\n')[0] || err.message);
      const e = new Error(`git ${args[0]} in ${tildify(cwd)}: ${why}`);
      e.code = err.code;
      reject(e);
    });
  });
}

// ---------------------------------------------------------------------------
// Parsing (pure functions, unit tested)

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out) {
  const res = { oid: null, head: null, upstream: null, ahead: 0, behind: 0, changed: [], untracked: [] };
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) {
      const [, key, ...rest] = rec.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') res.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') res.head = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') res.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) { res.ahead = +m[1]; res.behind = +m[2]; }
      }
      continue;
    }
    const parts = rec.split(' ');
    switch (rec[0]) {
      case '1': res.changed.push({ xy: parts[1], path: parts.slice(8).join(' ') }); break;
      case '2': res.changed.push({ xy: parts[1], path: parts.slice(9).join(' ') }); i++; break; // next record is the old path
      case 'u': res.changed.push({ xy: parts[1], path: parts.slice(10).join(' '), conflict: true }); break;
      case '?': res.untracked.push(rec.slice(2)); break;
      default: break; // '!' ignored files
    }
  }
  return res;
}

export const REF_FORMAT = '%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:unix)%00%(objectname)';

/** Parse `git for-each-ref --format=REF_FORMAT refs/heads`. */
export function parseRefs(out) {
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, upstream, track, date, sha] = line.split('\0');
    return { name, upstream: upstream || null, ...parseTrack(track), date: Number(date) * 1000, sha };
  });
}

export function parseTrack(track = '') {
  if (track.includes('gone')) return { ahead: 0, behind: 0, gone: true };
  return {
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    gone: false,
  };
}

/** Turn a git remote URL into a browser URL, or null for local / unknown remotes. */
export function remoteToWeb(remote) {
  if (!remote) return null;
  let host, repoPath;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(remote); // git@github.com:owner/repo.git
  if (scp && !/^[a-z]+:\/\//i.test(remote)) {
    [, host, repoPath] = scp;
  } else {
    try {
      const u = new URL(remote);
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(u.protocol)) return null;
      host = u.hostname;
      repoPath = u.pathname;
    } catch { return null; }
  }
  repoPath = repoPath.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
  if (!host || !repoPath) return null;
  return `https://${host}/${repoPath}`;
}

export function branchUrl(web, branch) {
  if (!web || !branch) return web;
  const b = branch.split('/').map(encodeURIComponent).join('/');
  const host = new URL(web).hostname;
  if (host === 'github.com' || host.startsWith('github.')) return `${web}/tree/${b}`;
  if (host.includes('gitlab')) return `${web}/-/tree/${b}`;
  if (host === 'bitbucket.org') return `${web}/src/${b}`;
  return web;
}

export function shellQuote(s) {
  if (/^[\w@%+=:,./~-]+$/.test(s)) return s;
  if (s.startsWith('~/')) return `~/${shellQuote(s.slice(2))}`; // keep ~ expandable
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Finding repositories

export async function findRepos(root, maxDepth = 3) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === '.git')) { found.push(dir); return; }
    if (depth >= maxDepth) return;
    await Promise.all(entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => walk(path.join(dir, e.name), depth + 1)));
  }
  await walk(root, 0);
  return found.sort();
}

async function scanRoots(config, warn) {
  const roots = (config.roots?.length ? config.roots : ['~/code']).map((r) => ({ label: r, abs: expandHome(r) }));
  const existing = [];
  for (const r of roots) {
    try {
      if ((await fs.stat(r.abs)).isDirectory()) existing.push(r);
      else warn(`${r.label} is not a folder`);
    } catch { warn(`${r.label} does not exist`); }
  }
  if (!existing.length) {
    throw new Error(`None of the scan folders exist (${roots.map((r) => r.label).join(', ')}). Pick a folder in setup.`);
  }
  const repos = new Map();
  for (const r of existing) {
    for (const repo of await findRepos(r.abs, config.maxDepth ?? 3)) {
      if (repos.has(repo)) continue;
      const rel = path.relative(r.abs, repo);
      repos.set(repo, { dir: repo, name: rel || path.basename(repo) });
    }
  }
  return { roots: existing, repos: [...repos.values()] };
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Inspecting one repository

const hash = (...parts) => crypto.createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 12);

async function defaultBase(dir, branches) {
  const remoteHead = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    .then((s) => s.trim()).catch(() => '');
  if (remoteHead) return { ref: remoteHead, name: remoteHead.replace(/^[^/]+\//, '') };
  const local = new Set(branches.map((b) => b.name));
  for (const n of ['main', 'master', 'trunk', 'develop']) if (local.has(n)) return { ref: n, name: n };
  return null;
}

async function fileAges(dir, files, now) {
  const times = [];
  await Promise.all(files.slice(0, 200).map(async (f) => {
    try { times.push((await fs.stat(path.join(dir, f))).mtimeMs); } catch { /* deleted file */ }
  }));
  if (!times.length) return { oldest: now, newest: now };
  return { oldest: Math.min(...times), newest: Math.max(...times) };
}

/** Collect raw facts about one repo. Exported for tests. */
export async function inspectRepo(dir, { staleDays = 30, now = Date.now() } = {}) {
  const [statusOut, refsOut, remotesOut] = await Promise.all([
    runGit(dir, ['status', '--porcelain=v2', '--branch', '-z']),
    runGit(dir, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads']),
    runGit(dir, ['remote']),
  ]);
  const status = parseStatus(statusOut);
  const branches = parseRefs(refsOut);
  const remotes = remotesOut.split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] ?? null;
  const remoteUrl = remote ? (await runGit(dir, ['remote', 'get-url', remote]).catch(() => '')).trim() : '';
  const web = remoteToWeb(remoteUrl);
  const base = await defaultBase(dir, branches);
  const baseSha = base ? (await runGit(dir, ['rev-parse', '--verify', '--quiet', base.ref]).catch(() => '')).trim() : '';

  let merged = [];
  if (base) {
    const out = await runGit(dir, ['branch', '--merged', base.ref, '--format=%(refname:short)']).catch(() => '');
    const mergedNames = new Set(out.split('\n').filter(Boolean));
    merged = branches.filter((b) => mergedNames.has(b.name)
      && b.name !== base.name && b.name !== status.head && !PROTECTED.has(b.name) && b.sha !== baseSha);
  }
  const mergedSet = new Set(merged.map((b) => b.name));

  const staleCut = now - staleDays * DAY;
  const stale = branches.filter((b) => !mergedSet.has(b.name) && b.name !== status.head
    && b.name !== base?.name && !PROTECTED.has(b.name) && (b.gone || b.date < staleCut));
  const staleSet = new Set(stale.map((b) => b.name));

  // Unpushed: commits reachable from the branch but from no remote-tracking ref.
  // Only meaningful when the repo has a remote at all.
  const unpushed = [];
  if (remote) {
    const candidates = branches.filter((b) => !staleSet.has(b.name) && !mergedSet.has(b.name)
      && (b.upstream ? b.ahead > 0 : true)).slice(0, MAX_BRANCH_LOGS);
    await mapLimit(candidates, 4, async (b) => {
      const out = await runGit(dir, ['log', '--format=%H%x00%ct%x00%s', `refs/heads/${b.name}`, '--not', '--remotes', '--max-count=500'])
        .catch(() => '');
      const commits = out.split('\n').filter(Boolean).map((l) => {
        const [sha, ct, subject] = l.split('\0');
        return { sha, at: Number(ct) * 1000, subject };
      });
      if (commits.length) unpushed.push({ branch: b, commits });
    });
  }

  return { dir, status, branches, remote, web, base, merged, stale, unpushed };
}

// ---------------------------------------------------------------------------
// Turning facts into items

export async function repoItems(repo, facts, { now = Date.now(), staleDays = 30 } = {}) {
  const items = [];
  const { dir, status, web } = facts;
  const where = tildify(dir);
  const cd = `git -C ${shellQuote(where)}`;
  const branchLabel = status.head ?? 'detached HEAD';

  // Uncommitted
  const tracked = status.changed.length;
  const untracked = status.untracked.length;
  if (tracked || untracked) {
    const ages = await fileAges(dir, tracked ? status.changed.map((c) => c.path) : status.untracked, now);
    const signal = { tracked, untracked, ageDays: (now - ages.oldest) / DAY };
    const r = rank('uncommitted', signal);
    const files = [...status.changed.map((c) => c.path), ...status.untracked];
    items.push(createItem({
      id: `git:uncommitted:${hash(dir)}`,
      source: id,
      kind: 'uncommitted',
      title: tracked
        ? `${repo.name} · uncommitted changes in ${plural(tracked + untracked, 'file')}`
        : `${repo.name} · ${plural(untracked, 'untracked file')}`,
      url: web,
      why: r.why,
      urgency: r.urgency,
      updatedAt: ages.newest,
      meta: {
        rule: r.rule,
        path: where,
        command: `${cd} status`,
        fingerprint: hash(...files.sort(), ...status.changed.map((c) => c.xy)),
        fields: {
          Repo: where,
          Branch: branchLabel,
          'Changed files': tracked,
          'New files': untracked,
          'Oldest edit': `${ago(signal.ageDays)} ago`,
          Files: files.slice(0, 6).join(', ') + (files.length > 6 ? ` +${files.length - 6} more` : ''),
        },
      },
    }));
  }

  // Unpushed, one item per branch
  for (const { branch, commits } of facts.unpushed) {
    const oldest = Math.min(...commits.map((c) => c.at));
    const newest = Math.max(...commits.map((c) => c.at));
    const signal = { count: commits.length, ageDays: (now - oldest) / DAY, hasUpstream: !!branch.upstream };
    const r = rank('unpushed', signal);
    items.push(createItem({
      id: `git:unpushed:${hash(dir, branch.name)}`,
      source: id,
      kind: 'unpushed',
      title: `${repo.name} · ${plural(commits.length, 'unpushed commit')} on ${branch.name}`,
      url: branch.upstream ? branchUrl(web, branch.name) : web,
      why: r.why,
      urgency: r.urgency,
      updatedAt: newest,
      meta: {
        rule: r.rule,
        path: where,
        command: branch.upstream
          ? `${cd} push`
          : `${cd} push -u ${facts.remote} ${shellQuote(branch.name)}`,
        fingerprint: branch.sha,
        fields: {
          Repo: where,
          Branch: branch.name,
          Upstream: branch.upstream ?? 'none yet',
          'Unpushed commits': commits.length,
          'Latest commit': commits[0].subject,
          'Oldest commit': `${ago(signal.ageDays)} ago`,
        },
      },
    }));
  }

  // Merged branches, one item per repo
  if (facts.merged.length) {
    const names = facts.merged.map((b) => b.name);
    const r = rank('merged-branches', { count: names.length, base: facts.base.name });
    items.push(createItem({
      id: `git:merged:${hash(dir)}`,
      source: id,
      kind: 'merged-branches',
      title: `${repo.name} · ${plural(names.length, 'merged branch', 'merged branches')} safe to delete`,
      url: web,
      why: r.why,
      urgency: r.urgency,
      updatedAt: Math.max(...facts.merged.map((b) => b.date)),
      meta: {
        rule: r.rule,
        path: where,
        command: `${cd} branch -d ${names.map(shellQuote).join(' ')}`,
        fingerprint: names.join('\n'),
        fields: { Repo: where, 'Merged into': facts.base.name, Branches: names.join(', ') },
      },
    }));
  }

  // Stale branches, one item per repo
  if (facts.stale.length) {
    const oldest = Math.min(...facts.stale.map((b) => b.date));
    const gone = facts.stale.filter((b) => b.gone).length;
    const signal = { count: facts.stale.length, gone, oldestDays: (now - oldest) / DAY, staleDays };
    const r = rank('stale-branches', signal);
    items.push(createItem({
      id: `git:stale:${hash(dir)}`,
      source: id,
      kind: 'stale-branches',
      title: `${repo.name} · ${plural(facts.stale.length, 'stale branch', 'stale branches')}`,
      url: web,
      why: r.why,
      urgency: r.urgency,
      updatedAt: Math.max(...facts.stale.map((b) => b.date)),
      meta: {
        rule: r.rule,
        path: where,
        command: `${cd} branch -vv`,
        fingerprint: facts.stale.map((b) => `${b.name}@${b.sha}`).join('\n'),
        fields: {
          Repo: where,
          Branches: facts.stale.map((b) => `${b.name} (${b.gone ? 'remote gone' : ago((now - b.date) / DAY)})`).join(', '),
          Threshold: `no commits for ${staleDays} days, or remote branch deleted`,
        },
      },
    }));
  }

  return items;
}

// ---------------------------------------------------------------------------
// Plugin interface

/** Settings the setup screen may change. Returns a clean patch or throws. */
export function normalizeSettings(input = {}) {
  let roots = input.roots;
  if (typeof roots === 'string') roots = roots.split(/[\n,]/);
  if (!Array.isArray(roots)) throw new TypeError('roots must be a list of folders');
  roots = roots.map((r) => String(r).trim()).filter(Boolean);
  if (!roots.length) throw new TypeError('Add at least one folder to scan');
  if (roots.length > 20 || roots.some((r) => r.length > 1024)) throw new TypeError('Too many or too long folder paths');
  return { roots: [...new Set(roots.map((r) => tildify(expandHome(r))))] };
}

export async function test(config = {}) {
  let version;
  try {
    version = (await runGit(process.cwd(), ['--version'])).trim().replace(/^git version /, '');
  } catch {
    return { ok: false, message: 'git is not installed or not on your PATH.' };
  }
  const warnings = [];
  try {
    const { roots, repos } = await scanRoots(config, (w) => warnings.push(w));
    const where = roots.map((r) => r.label).join(', ');
    return {
      ok: repos.length > 0,
      repos: repos.length,
      version,
      message: repos.length
        ? `Found ${plural(repos.length, 'repo')} in ${where}${warnings.length ? ` (${warnings.join('; ')})` : ''}`
        : `No git repos found in ${where}. Try a parent folder, or raise maxDepth.`,
    };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const warn = ctx.warn ?? (() => {});
  const staleDays = config.staleDays ?? 30;
  const { repos } = await scanRoots(config, warn);
  let failures = 0;
  const perRepo = await mapLimit(repos, CONCURRENCY, async (repo) => {
    try {
      const facts = await inspectRepo(repo.dir, { staleDays, now });
      return await repoItems(repo, facts, { now, staleDays });
    } catch (err) {
      failures++;
      warn(err.message);
      return [];
    }
  });
  if (repos.length && failures === repos.length) {
    throw new Error(`Could not read any of ${plural(repos.length, 'repo')}. First error is in the log.`);
  }
  ctx.summary?.(`${plural(repos.length, 'repo')} scanned`);
  return perRepo.flat();
}
