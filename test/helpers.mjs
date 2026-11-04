import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DAY = 86_400_000;

export async function tmpDir(prefix = 'birddog-test-') {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
};

/** Run git in a test repo with a clean, predictable config. */
export function git(cwd, args, { at } = {}) {
  const env = { ...process.env, ...GIT_ENV };
  if (at !== undefined) {
    const stamp = `@${Math.floor(at / 1000)} +0000`;
    env.GIT_AUTHOR_DATE = stamp;
    env.GIT_COMMITTER_DATE = stamp;
  }
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export const commit = (cwd, msg, at) => git(cwd, ['commit', '--allow-empty', '-q', '-m', msg], { at });

export function fakeItem(over = {}) {
  return {
    id: 'fake:1', source: 'fake', kind: 'thing', title: 'A thing', url: null,
    why: 'Because **reasons**', urgency: 'today', updatedAt: new Date(0).toISOString(), meta: {},
    ...over,
  };
}

/**
 * A fake fetch for API sources. `handler(url, init)` returns { status?, body?, headers? }
 * or undefined for a 404. Every call is recorded in `calls`.
 */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {} });
    const r = (await handler(u, init)) ?? { status: 404, body: { message: 'Not Found' } };
    const status = r.status ?? 200;
    const headers = new Headers(r.headers ?? {});
    return { ok: status < 400, status, headers, text: async () => (r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body))), json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
