import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkAuthConfig, createOidc, isAllowed } from '../src/auth/oidc.mjs';
import { createSessions } from '../src/auth/session.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { fakeIdp } from './fake-idp.mjs';
import { fakeItem, tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const KEY = 'k'.repeat(40);

describe('sessions', () => {
  it('round-trips a signed cookie', () => {
    const s = createSessions({ key: KEY });
    const cookie = s.issue({ sub: '1', email: 'a@b.c', name: 'A' }).split(';')[0];
    assert.deepEqual(s.read(`other=1; ${cookie}`), { sub: '1', email: 'a@b.c', name: 'A' });
  });

  it('rejects forged, foreign and expired cookies', () => {
    let clock = 0;
    const s = createSessions({ key: KEY, ttlMs: 1000, now: () => clock });
    const cookie = s.issue({ sub: '1', email: 'a@b.c' }).split(';')[0];
    const [name, value] = cookie.split('=');
    const [payload, mac] = value.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: '1', email: 'boss@b.c', exp: 1e15 })).toString('base64url');
    assert.equal(s.read(`${name}=${forged}.${mac}`), null);
    assert.equal(createSessions({ key: 'x'.repeat(40) }).read(cookie), null);
    assert.equal(s.read(`${name}=${payload}`), null);
    clock = 2000;
    assert.equal(s.read(cookie), null);
  });

  it('uses a __Host- cookie with Secure over https', () => {
    const s = createSessions({ key: KEY, secure: true });
    assert.match(s.issue({ sub: '1', email: 'a@b.c' }), /^__Host-birddog=.*; Secure$/);
    assert.match(s.clear(), /Max-Age=0/);
  });
});

describe('auth config', () => {
  it('requires issuer, client id and an allow list', () => {
    assert.deepEqual(checkAuthConfig({ enabled: false }), []);
    const problems = checkAuthConfig({ enabled: true });
    assert.equal(problems.length, 3);
    assert.match(problems[2], /otherwise any account/);
  });

  it('matches allowed emails and domains, case-insensitively', () => {
    const auth = { allowedEmails: ['Me@Example.com'], allowedDomains: ['@team.dev'] };
    assert.equal(isAllowed(auth, { email: 'me@example.com' }), true);
    assert.equal(isAllowed(auth, { email: 'x@TEAM.dev' }), true);
    assert.equal(isAllowed(auth, { email: 'x@evilteam.dev' }), false);
    assert.equal(isAllowed(auth, { email: null }), false);
  });
});

describe('OIDC flow', () => {
  const redirectUri = 'http://127.0.0.1:4747/auth/callback';

  async function signIn(idpOpts, user) {
    const idp = fakeIdp(idpOpts);
    const oidc = createOidc({ issuer: idp.issuer, clientId: idp.clientId, fetchImpl: idp.fetch });
    const url = await oidc.loginUrl({ redirectUri, returnTo: '/later' });
    const { code, state, query } = idp.authorize(url, user);
    return { idp, oidc, query, result: () => oidc.callback({ code, state }) };
  }

  it('sends PKCE, state and nonce, and returns the verified user', async () => {
    const { query, result } = await signIn();
    assert.equal(query.code_challenge_method, 'S256');
    assert.equal(query.response_type, 'code');
    assert.ok(query.state && query.nonce);
    const { user, returnTo } = await result();
    assert.deepEqual(user, { sub: 'u1', email: 'me@example.com', name: 'Me' });
    assert.equal(returnTo, '/later');
  });

  it('accepts ES256 tokens too', async () => {
    const { result } = await signIn({ alg: 'ES256' });
    assert.equal((await result()).user.email, 'me@example.com');
  });

  it('a state can only be used once', async () => {
    const { result } = await signIn();
    await result();
    await assert.rejects(result(), /expired or was already used/);
  });

  for (const [what, tamper, msg] of [
    ['wrong audience', (c) => ({ ...c, aud: 'someone-else' }), /different app/],
    ['wrong issuer', (c) => ({ ...c, iss: 'https://evil.test' }), /wrong issuer/],
    ['expired', (c) => ({ ...c, exp: 1000 }), /expired/],
    ['wrong nonce', (c) => ({ ...c, nonce: 'replayed' }), /nonce/],
  ]) {
    it(`rejects an ID token with ${what}`, async () => {
      const { result } = await signIn({ tamper });
      await assert.rejects(result(), msg);
    });
  }

  it('rejects a token signed by someone else', async () => {
    const idp = fakeIdp();
    const other = fakeIdp();
    const oidc = createOidc({
      issuer: idp.issuer,
      clientId: idp.clientId,
      // Discovery from the real provider, but the token endpoint is answered by an impostor.
      fetchImpl: (url, init) => (new URL(url).pathname === '/token' ? other.fetch(url, init) : idp.fetch(url, init)),
    });
    const url = await oidc.loginUrl({ redirectUri });
    const { state } = idp.authorize(url);
    const { code } = other.authorize(url);
    await assert.rejects(oidc.callback({ code, state }), /signature is invalid/);
  });

  it('refuses unverified emails and provider errors', async () => {
    const { result } = await signIn({}, { sub: 'u2', email: 'x@example.com', email_verified: false });
    await assert.rejects(result(), /not verified/);
    const idp = fakeIdp();
    const oidc = createOidc({ issuer: idp.issuer, clientId: idp.clientId, fetchImpl: idp.fetch });
    await assert.rejects(oidc.callback({ error: 'access_denied' }), /cancelled or refused/);
  });
});

/** Raw HTTP so we can set Host and Cookie headers. */
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('server with login turned on', () => {
  let app;
  let port;
  let idp;
  let dir;
  const src = {
    id: 'fake', name: 'Fake', test: async () => ({ ok: true }), collect: async () => [fakeItem({ id: 'fake:1' })],
  };

  async function login(user) {
    const start = await request(port, { path: '/later?x=1' });
    assert.equal(start.status, 302);
    const toIdp = await request(port, { path: start.headers.location });
    assert.equal(toIdp.status, 302);
    assert.ok(toIdp.headers.location.startsWith(`${idp.issuer}/authorize?`));
    const { code, state, redirectUri } = idp.authorize(toIdp.headers.location, user);
    assert.equal(redirectUri, `http://127.0.0.1:${port}/auth/callback`);
    return request(port, { path: `/auth/callback?code=${code}&state=${state}` });
  }

  before(async () => {
    dir = await tmpDir();
    idp = fakeIdp();
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({
      auth: { enabled: true, issuer: idp.issuer, clientId: idp.clientId, allowedEmails: ['me@example.com'], allowedDomains: ['team.dev'] },
    }));
    const secrets = await createSecretStore({ dir, backend: 'file' });
    app = await createBirddog({ dir, sources: [src], autoRefresh: false, log: quiet, secrets, fetchImpl: idp.fetch });
    port = await app.start(0);
    await app.refresh();
  });
  after(() => app.close());

  it('sends pages to sign-in and refuses the API without a session', async () => {
    const page = await request(port, { path: '/' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/auth/login?returnTo=%2F');
    assert.equal((await request(port, { path: '/api/items' })).status, 401);
    assert.equal((await request(port, { path: '/api/health' })).status, 200, 'health stays public for the CLI');
  });

  it('signs in, returns to the page you wanted, and unlocks the API', async () => {
    const cb = await login();
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.location, '/later?x=1');
    const cookie = cb.headers['set-cookie'][0].split(';')[0];
    assert.match(cb.headers['set-cookie'][0], /HttpOnly; SameSite=Lax/);
    const items = await request(port, { path: '/api/items', headers: { cookie } });
    assert.equal(items.status, 200);
    assert.equal(items.json.items.length, 1);
    const me = await request(port, { path: '/api/me', headers: { cookie } });
    assert.deepEqual(me.json, { authEnabled: true, user: { sub: 'u1', email: 'me@example.com', name: 'Me' } });
  });

  it('lets in allowed domains and turns away everyone else', async () => {
    assert.equal((await login({ sub: 'u3', email: 'pat@team.dev' })).status, 302);
    const denied = await login({ sub: 'u4', email: 'stranger@gmail.com' });
    assert.equal(denied.status, 403);
    assert.match(denied.text, /not allowed to use this Birddog/);
    assert.equal(denied.headers['set-cookie'], undefined);
  });

  it('shows a friendly page when sign-in fails', async () => {
    const res = await request(port, { path: '/auth/callback?code=x&state=bogus' });
    assert.equal(res.status, 400);
    assert.match(res.text, /Sign-in did not work/);
  });

  it('never redirects off-site after sign-in', async () => {
    const res = await request(port, { path: '/auth/login?returnTo=//evil.example/' });
    const { code, state } = idp.authorize(res.headers.location);
    const cb = await request(port, { path: `/auth/callback?code=${code}&state=${state}` });
    assert.equal(cb.headers.location, '/');
  });

  it('signs out', async () => {
    const res = await request(port, { method: 'POST', path: '/auth/logout', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.match(res.headers['set-cookie'][0], /Max-Age=0/);
  });

  it('kept the session key in the secret store, not in config.json', async () => {
    assert.ok((await app.secrets.get('session-key')).length >= 32);
    assert.doesNotMatch(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), /session/);
  });
});

describe('listening beyond localhost', () => {
  it('is refused unless login is on', async () => {
    const dir = await tmpDir();
    const secrets = await createSecretStore({ dir, backend: 'file' });
    const app = await createBirddog({ dir, sources: [], autoRefresh: false, log: quiet, secrets });
    await assert.rejects(app.start(0, '0.0.0.0'), /without login/);
  });

  it('refuses to start with login half set up', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ auth: { enabled: true, issuer: 'https://idp.test', clientId: 'x' } }));
    const secrets = await createSecretStore({ dir, backend: 'file' });
    await assert.rejects(createBirddog({ dir, sources: [], autoRefresh: false, log: quiet, secrets }), /allowedEmails or auth.allowedDomains/);
  });

  it('accepts the Host from auth.publicUrl', async () => {
    const dir = await tmpDir();
    const idp = fakeIdp();
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({
      auth: { enabled: true, issuer: idp.issuer, clientId: idp.clientId, allowedEmails: ['me@example.com'], publicUrl: 'https://bd.example.com' },
    }));
    const secrets = await createSecretStore({ dir, backend: 'file' });
    const app = await createBirddog({ dir, sources: [], autoRefresh: false, log: quiet, secrets, fetchImpl: idp.fetch });
    const port = await app.start(0);
    try {
      const res = await request(port, { path: '/auth/login', headers: { host: 'bd.example.com' } });
      assert.equal(res.status, 302);
      assert.equal(new URL(res.headers.location).searchParams.get('redirect_uri'), 'https://bd.example.com/auth/callback');
      assert.equal((await request(port, { path: '/', headers: { host: 'other.example.com' } })).status, 403);
    } finally { await app.close(); }
  });
});
