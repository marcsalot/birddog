// The first-run screen: which folders of repos could Birddog scan, and how many
// repos are in each? The best guess is preselected, so most people need one click.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CANDIDATE_ROOTS, expandHome, tildify } from './config.mjs';
import { findRepos } from './sources/git.mjs';

const MAX_CANDIDATES = 8;
const COUNT_TIMEOUT_MS = 4000;

async function isDir(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

/** Count repos under a folder, giving up (count: null) if the folder is huge. */
async function countRepos(abs, maxDepth) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), COUNT_TIMEOUT_MS); });
  try {
    const n = await Promise.race([findRepos(abs, maxDepth).then((r) => r.length), timeout]);
    return n;
  } finally { clearTimeout(timer); }
}

/**
 * Folders to offer on the first-run screen.
 * @param {object} o
 * @param {string[]} o.roots     what config.json scans now (detected on first run)
 * @param {boolean} [o.container] in Docker only the mounted folders make sense
 * @param {string} [o.cwd]        where `birddog` was started
 * @param {number} [o.maxDepth]
 * @param {string[]} [o.candidates] usual code folders to look for (tests pass their own)
 * @returns {Promise<{ folders: {path:string, repos:number|null, configured:boolean, selected:boolean}[], home: string }>}
 */
export async function repoFolders({ roots = [], container = false, cwd = process.cwd(), maxDepth = 3, candidates = CANDIDATE_ROOTS } = {}) {
  const wanted = [...roots];
  if (container) wanted.push('/repos');
  else {
    wanted.push(...candidates);
    if (cwd && path.resolve(cwd) !== os.homedir()) wanted.push(tildify(path.resolve(cwd)));
  }
  const seen = new Set();
  const folders = [];
  for (const p of wanted) {
    if (folders.length >= MAX_CANDIDATES) break;
    const abs = expandHome(p);
    if (!(await isDir(abs))) continue;
    const real = (await fs.realpath(abs).catch(() => abs)).toLowerCase();
    if (seen.has(real)) continue;
    seen.add(real);
    const configured = roots.some((r) => expandHome(r) === abs);
    folders.push({ path: tildify(abs), abs, configured, selected: configured });
  }
  await Promise.all(folders.map(async (f) => { f.repos = await countRepos(f.abs, maxDepth); }));
  // Nothing preselected has repos? Preselect the folders that do.
  if (!folders.some((f) => f.selected && f.repos)) {
    const withRepos = folders.filter((f) => f.repos);
    if (withRepos.length) for (const f of folders) f.selected = withRepos.includes(f);
  }
  return { folders: folders.map(({ abs: _abs, ...f }) => f), home: container ? '/repos' : '~' };
}
