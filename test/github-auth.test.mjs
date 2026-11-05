import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createGithubAuth } from '../src/auth/github.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { tmpDir } from './helpers.mjs';

/** Fake github.com + api.github.com. `script` lists the answers to successive token polls. */
function fakeGithub(script) {
  const polls = [...script];
  const seen = [];
  return {
    seen,
    async fetch(url, init = {}) {
      const u = new URL(url);
      seen.push(`${init.method ?? 'GET'} ${u.pathname}`);
      const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
      if (u.pathname === '/login/device/code') {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('client_id'), 'Iv1.test');
        return json({ device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      }
      if (u.pathname === '/login/oauth/access_token') return json(polls.shift() ?? { error: 'authorization_pending' });
      if (u.pathname === '/user') {
        if (init.headers.authorization !== 'Bearer gho_secret' && init.headers.authorization !== 'Bearer gho_cli') return json({}, 401);
        return json({ login: 'octocat', name: 'Mona' });
      }
      return json({}, 404);
    },
  };
}

async function setup({ clientId = 'Iv1.test', script = [], cliToken } = {}) {
  const dir = await tmpDir();
  const secrets = await createSecretStore({ dir, backend: 'file' });
  const gh = fakeGithub(script);
  const auth = createGithubAuth({
    dir, secrets, fetchImpl: gh.fetch, cliToken, sleep: async () => {}, env: {}, builtIn: {},
    getConfig: () => ({ sources: { github: clientId ? { clientId } : {} } }),
  });
  return { dir, secrets, gh, auth };
}

// Wait on the clock, not a tick count: the device flow writes real files, which can
// take many event-loop turns when the machine is busy (CI, parallel test files).
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('timed out');
};

describe('GitHub sign-in', () => {
  it('device flow: shows a code, waits, then stores the token in the secret store', async () => {
    const { auth, secrets, dir } = await setup({ script: [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'gho_secret' }] });
    const dev = await auth.startDevice();
    assert.equal(dev.userCode, 'WDJB-MJHT');
    assert.equal(dev.status, 'waiting');
    await until(async () => (await auth.status()).connected);
    const s = await auth.status();
    assert.equal(s.login, 'octocat');
    assert.equal(s.method, 'device');
    assert.equal(await secrets.get('github-token'), 'gho_secret');
    assert.equal(await auth.token(), 'gho_secret');
    assert.doesNotMatch(await fs.readFile(path.join(dir, 'connections.json'), 'utf8'), /gho_/, 'token is not in connections.json');
  });

  it('device flow: reports when you cancel on GitHub', async () => {
    const { auth } = await setup({ script: [{ error: 'access_denied' }] });
    await auth.startDevice();
    await until(async () => (await auth.status()).device.status !== 'waiting');
    const s = await auth.status();
    assert.equal(s.connected, false);
    assert.match(s.device.error, /cancelled/);
  });

  it('device flow needs a client id', async () => {
    const { auth } = await setup({ clientId: null });
    assert.equal((await auth.status()).deviceFlowAvailable, false);
    await assert.rejects(auth.startDevice(), /One-click GitHub sign-in isn't available.*sources.github.clientId/);
  });

  it('gh CLI: uses gh\'s token and stores no copy', async () => {
    let asked = 0;
    const { auth, secrets } = await setup({ cliToken: async (host) => { asked++; assert.equal(host, 'github.com'); return 'gho_cli'; } });
    const s = await auth.useGhCli();
    assert.equal(s.login, 'octocat');
    assert.equal(s.method, 'gh-cli');
    assert.equal(await secrets.get('github-token'), null);
    assert.equal(await auth.token(), 'gho_cli');
    assert.equal(asked, 2);
  });

  it('gh CLI: explains what to do when gh is not signed in', async () => {
    const { auth } = await setup({ cliToken: async () => { throw new Error('gh is not signed in to github.com. Run "gh auth login" first.'); } });
    await assert.rejects(auth.useGhCli(), /gh auth login/);
  });

  it('disconnect forgets the token', async () => {
    const { auth, secrets } = await setup({ script: [{ access_token: 'gho_secret' }] });
    await auth.startDevice();
    await until(async () => (await auth.status()).connected);
    await auth.disconnect();
    assert.equal((await auth.status()).connected, false);
    assert.equal(await secrets.get('github-token'), null);
    assert.equal(await auth.token(), null);
  });
});

describe('secret store (file backend)', () => {
  it('stores with mode 600 and validates names', async () => {
    const dir = await tmpDir();
    const s = await createSecretStore({ dir, backend: 'file' });
    await s.set('a-token', 'v');
    assert.equal(await s.get('a-token'), 'v');
    assert.equal((await fs.stat(path.join(dir, 'secrets.json'))).mode & 0o777, 0o600);
    await s.delete('a-token');
    assert.equal(await s.get('a-token'), null);
    await assert.rejects(s.get('../etc'), /bad secret name/);
    await assert.rejects(s.set('x', ''), /non-empty/);
  });
});
