// Where Birddog keeps its files, and the user's config.
//
//   ~/.config/birddog/config.json   what to scan (you can edit this by hand)
//   ~/.config/birddog/state.json    done / snooze state and UI preferences
//   ~/.config/birddog/cache.json    last good data from each source
//
// Set BIRDDOG_HOME to use a different folder (handy for tests and demos).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './store.mjs';

export const DEFAULT_PORT = 4747;

export function configDir(env = process.env) {
  if (env.BIRDDOG_HOME) return path.resolve(env.BIRDDOG_HOME);
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'birddog');
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

export function tildify(p) {
  const home = os.homedir();
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

/** Folders where people usually keep code. The first run scans whichever exist. */
export const CANDIDATE_ROOTS = [
  '~/code', '~/Code', '~/src', '~/dev', '~/projects', '~/Projects', '~/Developer',
  '~/repos', '~/git', '~/work', '~/workspace', '~/Documents/GitHub',
];

export function defaultConfig() {
  return {
    port: DEFAULT_PORT,
    refreshMinutes: 5,
    sources: {
      git: { enabled: true, roots: ['~/code'], maxDepth: 3, staleDays: 30 },
    },
    // Optional single sign-on in front of the dashboard (OpenID Connect).
    // Off by default: on 127.0.0.1 only you can reach Birddog anyway.
    auth: {
      enabled: false,
      issuer: '',
      clientId: '',
      clientSecret: '',
      scopes: 'openid email profile',
      allowedEmails: [],
      allowedDomains: [],
      publicUrl: '',
      sessionDays: 7,
    },
  };
}

async function isDir(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

/**
 * Pick sensible scan folders on first run so the list is useful right away.
 * Falls back to the current folder when none of the usual places exist.
 */
export async function detectRoots(cwd = process.cwd()) {
  const found = [];
  const seen = new Set();
  for (const candidate of CANDIDATE_ROOTS) {
    const abs = expandHome(candidate);
    if (!(await isDir(abs))) continue;
    const real = await fs.realpath(abs).catch(() => abs);
    const key = real.toLowerCase(); // macOS folders are case-insensitive
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  if (found.length) return found;
  if (cwd && path.resolve(cwd) !== os.homedir()) return [tildify(path.resolve(cwd))];
  return ['~/code'];
}

function merge(defaults, value) {
  if (Array.isArray(defaults) || typeof defaults !== 'object' || defaults === null) {
    return value === undefined ? defaults : value;
  }
  const out = { ...defaults };
  for (const [k, v] of Object.entries(value ?? {})) out[k] = merge(defaults[k], v);
  return out;
}

export async function loadConfig(dir = configDir(), { cwd } = {}) {
  const file = path.join(dir, 'config.json');
  const raw = await readJson(file, null);
  if (raw === null) {
    const config = defaultConfig();
    config.sources.git.roots = await detectRoots(cwd);
    await writeJson(file, config);
    return { config, file, created: true };
  }
  return { config: merge(defaultConfig(), raw), file, created: false };
}

export async function saveConfig(dir, config) {
  await writeJson(path.join(dir, 'config.json'), config);
}
