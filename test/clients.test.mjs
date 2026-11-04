// Built-in public OAuth clients: precedence, what setup shows, refresh, revoke,
// and that no secret or token ever reaches an API response or a log. Fake providers only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { BUILT_IN, builtInSecret, NO_BUILT_IN, resolveClientId } from '../src/auth/clients.mjs';
import { createGithubAuth } from '../src/auth/github.mjs';
import { createOAuth } from '../src/auth/oauth.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import * as cal from '../src/sources/cal.mjs';
import * as linear from '../src/sources/linear.mjs';
import * as pagerduty from '../src/sources/pagerduty.mjs';
import { tmpDir } from './helpers.mjs';

const GOOGLE_SECRET = 'GOCSPX-built-in-desktop-secret';
const FAKE_BUILT_IN = {
  github: { clientId: 'Ov23-birddog', host: 'https://github.com' },
  gitlab: { clientId: 'gl-birddog', host: 'https://gitlab.com' },
  microsoft: { clientId: 'ms-birddog' },
  google: { clientId: 'g-birddog.apps.googleusercontent.com', clientSecret: GOOGLE_SECRET, verified: false },
  linear: { clientId: 'lin-birddog' },
  pagerduty: { clientId: 'pd-birddog' },
  atlassian: { clientId: 'must-be-ignored' }, // never built in, even if someone adds one
};

const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });

/** Google, Linear and PagerDuty token endpoints with PKCE, plus their identity/API calls. */
function fakeProviders() {
  const codes = new Map();
  const calls = [];
  const state = { failRefresh: false, expiresIn: 3600 };
  let n = 0;
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ url: u, headers: init.headers ?? {}, body });
    const p = { 'oauth2.googleapis.com': 'google', 'api.linear.app': 'linear', 'identity.pagerduty.com': 'pagerduty' }[u.host];
    if (p && /\/token$/.test(u.pathname)) {
      if (p === 'google' && body.client_secret !== GOOGLE_SECRET && body.client_id === FAKE_BUILT_IN.google.clientId) return json({ error: 'invalid_client' }, 401);
      if (p !== 'google' && body.client_secret) return json({ error: 'a public client sends no secret' }, 400);
      if (body.grant_type === 'authorization_code') {
        const c = codes.get(body.code); codes.delete(body.code);
        if (!c || crypto.createHash('sha256').update(body.code_verifier).digest('base64url') !== c.code_challenge) return json({ error: 'invalid_grant' }, 400);
      } else if (body.grant_type === 'refresh_token') {
        if (state.failRefresh) return json({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400);
      }
      n++;
      return json({ access_token: `${p}-at-${n}`, refresh_token: `${p}-rt-${n}`, expires_in: state.expiresIn, scope: 'read' });
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') return json({});
    if (u.host === 'api.linear.app' && u.pathname === '/oauth/revoke') return json({}, String(init.headers?.authorization).startsWith('Bearer linear-at-') ? 200 : 401);
    if (u.host === 'api.linear.app' && u.pathname === '/graphql') {
      if (!String(init.headers?.authorization).startsWith('Bearer linear-at-')) return json({ errors: [{ message: 'auth' }] }, 401);
      return json({ data: { viewer: { name: 'Sam', email: 'sam@acme.test', assignedIssues: { nodes: [] } } } });
    }
    if (u.host === 'www.googleapis.com') return json({ id: 'sam@gmail.test', items: [] });
    return json({ error: 'not found' }, 404);
  };
  fn.approve = (authorizeUrl) => {
    const q = Object.fromEntries(new URL(authorizeUrl).searchParams);
    const code = crypto.randomBytes(6).toString('hex');
    codes.set(code, q);
    return { code, state: q.state, query: q };
  };
  fn.calls = calls;
  fn.state = state;
  return fn;
}

describe('built-in OAuth clients', () => {
  it('precedence: environment, then config.json, then the built-in app', () => {
    const b = FAKE_BUILT_IN;
    assert.deepEqual(resolveClientId('linear', { env: { BIRDDOG_LINEAR_CLIENT_ID: 'from-env' }, configured: 'from-config', builtIn: b }).from, 'env');
    assert.deepEqual(resolveClientId('linear', { env: {}, configured: 'from-config', builtIn: b }), { clientId: 'from-config', from: 'config', variable: 'BIRDDOG_LINEAR_CLIENT_ID' });
    assert.deepEqual(resolveClientId('linear', { env: {}, builtIn: b }).clientId, 'lin-birddog');
    assert.equal(resolveClientId('linear', { env: {}, builtIn: {} }).clientId, null);
    // The built-in app only exists on the provider's main cloud.
    assert.equal(resolveClientId('gitlab', { env: {}, host: 'https://gitlab.com/', builtIn: b }).from, 'built-in');
    assert.equal(resolveClientId('gitlab', { env: {}, host: 'https://git.acme.test', builtIn: b }).clientId, null);
  });

  it('the built-in secret goes only with the built-in client ID', () => {
    assert.equal(builtInSecret('google', 'built-in', FAKE_BUILT_IN), GOOGLE_SECRET);
    assert.equal(builtInSecret('google', 'config', FAKE_BUILT_IN), null);
    assert.equal(builtInSecret('linear', 'built-in', FAKE_BUILT_IN), null);
  });

  it('ships no confidential secrets: only Google may have one, and Atlassian/Slack have no app', () => {
    for (const [p, c] of Object.entries(BUILT_IN)) if (p !== 'google') assert.equal(c.clientSecret, undefined, p);
    assert.equal(BUILT_IN.atlassian, undefined);
    assert.equal(BUILT_IN.slack, undefined);
    assert.ok(NO_BUILT_IN.atlassian && NO_BUILT_IN.slack);
  });

  it('status: one-click when an ID is available, fallback otherwise; never the secret', async () => {
    const dir = await tmpDir();
    const secrets = await createSecretStore({ dir, backend: 'file' });
    const make = (builtIn, config = {}) => createOAuth({ dir, secrets, getConfig: () => ({ oauth: config }), fetchImpl: fakeProviders(), env: {}, builtIn });
    const on = make(FAKE_BUILT_IN);
    const g = await on.status('google');
    assert.deepEqual([g.configured, g.builtIn, g.unverified, g.hasSecret], [true, true, true, true]);
    assert.doesNotMatch(JSON.stringify(g), /GOCSPX/);
    const at = await on.status('atlassian');
    assert.deepEqual([at.configured, at.builtIn], [false, false], 'a built-in Atlassian ID is ignored');
    assert.match(at.noBuiltIn, /confidential client secret/);
    const off = await make({}).status('linear');
    assert.deepEqual([off.configured, off.builtIn], [false, false]);
    const own = await make(FAKE_BUILT_IN, { google: { clientId: 'mine' } }).status('google');
    assert.deepEqual([own.builtIn, own.unverified, own.hasSecret], [false, false, false], 'your own app: no built-in secret, no Google notice');
    assert.equal((await make({ ...FAKE_BUILT_IN, google: { ...FAKE_BUILT_IN.google, verified: true } }).status('google')).unverified, false);
  });

  it('GitHub device flow uses the built-in app on github.com only', async () => {
    const dir = await tmpDir();
    const secrets = await createSecretStore({ dir, backend: 'file' });
    const gh = (sources) => createGithubAuth({ dir, secrets, getConfig: () => ({ sources }), env: {}, builtIn: FAKE_BUILT_IN, fetchImpl: async () => json({}) });
    const s = await gh({}).status();
    assert.deepEqual([s.deviceFlowAvailable, s.builtIn], [true, true]);
    const ghe = await gh({ github: { webUrl: 'https://ghe.acme.test', apiUrl: 'https://ghe.acme.test/api/v3' } }).status();
    assert.equal(ghe.deviceFlowAvailable, false);
    const mine = await gh({ github: { clientId: 'mine' } }).status();
    assert.deepEqual([mine.deviceFlowAvailable, mine.builtIn], [true, false]);
  });

  it('Linear and PagerDuty: PKCE with no secret; Google: PKCE plus its desktop secret', async () => {
    const dir = await tmpDir();
    const secrets = await createSecretStore({ dir, backend: 'file' });
    const f = fakeProviders();
    const o = createOAuth({ dir, secrets, getConfig: () => ({}), fetchImpl: f, env: {}, builtIn: FAKE_BUILT_IN });
    for (const p of ['linear', 'pagerduty', 'google']) {
      const { url } = await o.start(p, `http://127.0.0.1:4747/auth/oauth/${p}/callback`);
      const { code, state, query } = f.approve(url);
      assert.equal(query.client_id, FAKE_BUILT_IN[p].clientId);
      assert.equal(query.code_challenge_method, 'S256');
      if (p === 'linear') assert.equal(query.scope, 'read');
      await o.callback(p, { code, state });
      const exchange = f.calls.findLast((c) => c.body.grant_type === 'authorization_code');
      assert.equal(!!exchange.body.client_secret, p === 'google', `${p} secret`);
      assert.ok((await o.status(p)).connected);
    }
  });

  it('refresh renews with the built-in client; a refused refresh says "Sign in again"', async () => {
    const dir = await tmpDir();
    const secrets = await createSecretStore({ dir, backend: 'file' });
    const f = fakeProviders();
    let t = Date.now();
    const o = createOAuth({ dir, secrets, getConfig: () => ({}), fetchImpl: f, env: {}, builtIn: FAKE_BUILT_IN, now: () => t });
    const { url } = await o.start('linear', 'http://127.0.0.1:4747/auth/oauth/linear/callback');
    const { code, state } = f.approve(url);
    await o.callback('linear', { code, state });
    const first = await o.accessToken('linear');
    t += 2 * 3600_000;
    const second = await o.accessToken('linear');
    assert.notEqual(first, second);
    const r = f.calls.findLast((c) => c.body.grant_type === 'refresh_token');
    assert.deepEqual([r.body.client_id, r.body.client_secret], ['lin-birddog', undefined]);
    f.state.failRefresh = true;
    t += 2 * 3600_000;
    await assert.rejects(o.accessToken('linear'), /Sign in again/);
  });

  it('revoke: Linear revokes with the token as Bearer, PagerDuty points to its settings', async () => {
    const dir = await tmpDir();
    const secrets = await createSecretStore({ dir, backend: 'file' });
    const f = fakeProviders();
    const o = createOAuth({ dir, secrets, getConfig: () => ({}), fetchImpl: f, env: {}, builtIn: FAKE_BUILT_IN });
    for (const p of ['linear', 'pagerduty']) {
      const { url } = await o.start(p, `http://127.0.0.1:4747/auth/oauth/${p}/callback`);
      const { code, state } = f.approve(url);
      await o.callback(p, { code, state });
    }
    const lin = await o.disconnect('linear');
    assert.equal(lin.revoked, true);
    const pd = await o.disconnect('pagerduty');
    assert.deepEqual([pd.revoked, !!pd.manage], [false, true]);
    assert.equal(await secrets.get('oauth-linear'), null);
    assert.equal(await secrets.get('oauth-pagerduty'), null);
  });

  it('through the server: sign in, stale with "Sign in again" when renewal fails, and no secret or token in any response or log', async () => {
    const dir = await tmpDir();
    const secrets = await createSecretStore({ dir, backend: 'file' });
    const f = fakeProviders();
    const logged = [];
    const log = { warn: (...a) => logged.push(a.join(' ')), error: (...a) => logged.push(a.join(' ')), log: (...a) => logged.push(a.join(' ')) };
    const app = await createBirddog({ dir, sources: [cal, linear, pagerduty], autoRefresh: false, log, secrets, fetchImpl: f, builtInClients: FAKE_BUILT_IN });
    const port = await app.start(0);
    const base = `http://127.0.0.1:${port}`;
    const call = async (p, method = 'GET', body) => fetch(`${base}${p}`, { method, redirect: 'manual', headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const bodies = [];
    const get = async (p) => { const t = await (await call(p)).text(); bodies.push(t); return JSON.parse(t); };
    try {
      const list = await get('/api/oauth');
      const lin = list.providers.find((p) => p.id === 'linear');
      assert.deepEqual([lin.configured, lin.builtIn, lin.connected], [true, true, false]);
      assert.equal(list.providers.find((p) => p.id === 'google').unverified, true);

      const { url } = await (await call('/api/oauth/linear/start', 'POST', {})).json();
      const { code, state } = f.approve(url);
      const back = await call(`/auth/oauth/linear/callback?code=${code}&state=${state}`);
      assert.equal(back.headers.get('location'), '/?connected=linear');
      assert.deepEqual([app.config.sources.linear.enabled, app.config.sources.linear.auth], [true, 'oauth']);
      assert.equal((await get('/api/oauth')).providers.find((p) => p.id === 'linear').account, 'sam@acme.test');

      await app.refresh();
      const ok = (await get('/api/items')).sources.find((s) => s.id === 'linear');
      assert.deepEqual([ok.status, ok.signIn], ['ok', 'linear']);

      // The access token dies and the provider refuses the refresh.
      const tokens = JSON.parse(await secrets.get('oauth-linear'));
      await secrets.set('oauth-linear', JSON.stringify({ ...tokens, expires_at: 0 }));
      f.state.failRefresh = true;
      await app.refresh();
      const stale = (await get('/api/items')).sources.find((s) => s.id === 'linear');
      assert.equal(stale.status, 'stale');
      assert.equal(stale.signIn, 'linear');
      assert.match(stale.error, /Sign in again/);

      await get('/api/setup');
      const everything = bodies.join('\n') + logged.join('\n');
      assert.doesNotMatch(everything, /GOCSPX/, 'the Google desktop secret');
      assert.doesNotMatch(everything, /linear-(at|rt)-\d/, 'access or refresh tokens');
    } finally { await app.close(); }
  });
});
