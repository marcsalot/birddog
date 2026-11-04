// Sign-in flows for sources, against fake providers (no network).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { appleClientSecret, createOAuth } from '../src/auth/oauth.mjs';
import { createOidc } from '../src/auth/oidc.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import * as cal from '../src/sources/cal.mjs';
import { caldavClient, davResponses, googleOccurrences, graphOccurrences } from '../src/sources/calendar-apis.mjs';
import * as jira from '../src/sources/jira.mjs';
import { fakeIdp } from './fake-idp.mjs';
import { tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const json = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body) });

/** One fake for Google, Microsoft and Atlassian: enforces PKCE, rotates refresh tokens. */
function fakeProviders({ now = () => Date.now() } = {}) {
  const codes = new Map();
  const calls = [];
  let n = 0;
  const issue = (provider) => ({ access_token: `${provider}-at-${++n}`, refresh_token: `${provider}-rt-${n}`, expires_in: 3600, scope: 'x' });
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const tokenFor = { 'oauth2.googleapis.com': 'google', 'login.microsoftonline.com': 'microsoft', 'auth.atlassian.com': 'atlassian' }[u.host];
    if (tokenFor && /token$/.test(u.pathname)) {
      const p = typeof init.body === 'string' ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
      if (tokenFor === 'atlassian' && !p.client_secret) return json({ error: 'invalid_client' }, 401);
      if (tokenFor === 'microsoft' && p.client_secret) return json({ error: 'public clients send no secret' }, 400);
      if (p.grant_type === 'authorization_code') {
        const c = codes.get(p.code);
        codes.delete(p.code);
        if (!c) return json({ error: 'invalid_grant' }, 400);
        if (crypto.createHash('sha256').update(p.code_verifier).digest('base64url') !== c.code_challenge) return json({ error: 'invalid_grant', error_description: 'PKCE failed' }, 400);
        if (p.redirect_uri !== c.redirect_uri) return json({ error: 'invalid_grant' }, 400);
        return json(issue(tokenFor));
      }
      if (p.grant_type === 'refresh_token') return p.refresh_token === 'dead' ? json({ error: 'invalid_grant' }, 400) : json(issue(tokenFor));
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') return json({});
    if (u.host === 'www.googleapis.com' && u.pathname.endsWith('/calendarList/primary')) return json({ id: 'me@gmail.test' });
    if (u.host === 'www.googleapis.com' && u.pathname.endsWith('/events')) {
      const t = now();
      return json({ items: [
        { id: 'g1', summary: 'Standup', start: { dateTime: new Date(t + 10 * 60_000).toISOString() }, end: { dateTime: new Date(t + 25 * 60_000).toISOString() }, hangoutLink: 'https://meet.google.com/abc-defg-hij' },
        { id: 'g2', summary: 'Declined thing', start: { dateTime: new Date(t + 3600_000).toISOString() }, end: { dateTime: new Date(t + 7200_000).toISOString() }, attendees: [{ self: true, responseStatus: 'declined' }] },
        { id: 'g3', status: 'cancelled', start: { dateTime: new Date(t).toISOString() } },
      ] });
    }
    if (u.host === 'graph.microsoft.com' && u.pathname === '/v1.0/me') return json({ mail: 'me@contoso.test' });
    if (u.host === 'api.atlassian.com' && u.pathname === '/oauth/token/accessible-resources') return json([{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work'] }]);
    if (u.host === 'api.atlassian.com' && u.pathname.startsWith('/ex/jira/cloud-1/rest/api/3/')) {
      if (!String(init.headers?.authorization).startsWith('Bearer atlassian-at-')) return json({}, 401);
      if (u.pathname.endsWith('/field')) return json([]);
      if (u.pathname.endsWith('/search/jql')) return json({ isLast: true, issues: [{ key: 'A-1', fields: { summary: 'Do it', status: { name: 'To Do' }, updated: new Date().toISOString() } }] });
    }
    return json({ error: 'not found' }, 404);
  };
  /** Pretend the user approved at the provider; returns the callback query string. */
  fn.approve = (authorizeUrl) => {
    const q = Object.fromEntries(new URL(authorizeUrl).searchParams);
    const code = crypto.randomBytes(6).toString('hex');
    codes.set(code, q);
    return { code, state: q.state, query: q };
  };
  fn.calls = calls;
  return fn;
}

async function oauthFor({ config = {}, secrets, env = {}, now } = {}) {
  const dir = await tmpDir();
  const store = secrets ?? await createSecretStore({ dir, backend: 'file' });
  const f = fakeProviders({ now });
  const o = createOAuth({ dir, secrets: store, getConfig: () => ({ oauth: config }), fetchImpl: f, env, now });
  return { o, f, dir, store };
}

describe('OAuth sign-in for sources', () => {
  it('builds an authorization URL with PKCE (S256), state and the provider\'s extras', async () => {
    const { o } = await oauthFor({ config: { google: { clientId: 'g-id' }, atlassian: { clientId: 'a-id' }, microsoft: { clientId: 'm-id', tenant: 'contoso.test' } } });
    const g = new URL((await o.start('google', 'http://127.0.0.1:4747/auth/oauth/google/callback')).url);
    assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    const q = Object.fromEntries(g.searchParams);
    assert.equal(q.code_challenge_method, 'S256');
    assert.equal(q.code_challenge.length, 43);
    assert.ok(q.state.length >= 32);
    assert.deepEqual([q.client_id, q.response_type, q.access_type, q.scope], ['g-id', 'code', 'offline', 'https://www.googleapis.com/auth/calendar.readonly']);
    const m = new URL((await o.start('microsoft', 'http://127.0.0.1:1/x')).url);
    assert.equal(m.pathname, '/contoso.test/oauth2/v2.0/authorize');
    assert.match(m.searchParams.get('scope'), /offline_access .*Calendars\.Read/);
    await assert.rejects(o.start('atlassian', 'http://127.0.0.1:1/x'), /client secret/);
  });

  it('needs your own client ID, and refuses in Docker where tokens cannot be stored', async () => {
    const { o } = await oauthFor();
    await assert.rejects(o.start('google', 'http://x/y'), /client ID: set oauth\.google\.clientId in config\.json or BIRDDOG_GOOGLE_CLIENT_ID/);
    const ro = await createSecretStore({ dir: await tmpDir(), backend: 'env', env: {} });
    const { o: docker } = await oauthFor({ secrets: ro, env: { BIRDDOG_GOOGLE_CLIENT_ID: 'g' } });
    await assert.rejects(docker.start('google', 'http://x/y'), /read-only here \(Docker\)/);
    assert.equal((await docker.status('google')).canStore, false);
    await assert.rejects(o.start('nope', 'x'), /No sign-in flow/);
  });

  it('exchanges the code (PKCE checked), keeps tokens in the keychain only, and rejects replayed states', async () => {
    const { o, f, dir, store } = await oauthFor({ config: { google: { clientId: 'g-id' } } });
    const { url } = await o.start('google', 'http://127.0.0.1:4747/auth/oauth/google/callback');
    const { code, state } = f.approve(url);
    const info = await o.callback('google', { code, state }, async () => ({ account: 'me@gmail.test' }));
    assert.equal(info.account, 'me@gmail.test');
    const saved = JSON.parse(await store.get('oauth-google'));
    assert.match(saved.access_token, /^google-at-/);
    assert.ok(saved.refresh_token);
    assert.doesNotMatch(await fs.readFile(path.join(dir, 'connections.json'), 'utf8'), /google-(at|rt)-/, 'no tokens in connections.json');
    await assert.rejects(o.callback('google', { code, state }), /expired or was already used/);
    await assert.rejects(o.callback('google', { error: 'access_denied' }), /cancelled or refused/);
    const s = await o.status('google');
    assert.deepEqual([s.connected, s.account, s.configured], [true, 'me@gmail.test', true]);
  });

  it('renews an expiring token once (refresh tokens rotate), and asks to sign in again when renewal fails', async () => {
    let t = Date.now();
    const { o, f, store } = await oauthFor({ config: { microsoft: { clientId: 'm' } }, now: () => t });
    const { url } = await o.start('microsoft', 'http://127.0.0.1:1/cb');
    await o.callback('microsoft', f.approve(url));
    const first = await o.accessToken('microsoft');
    assert.equal(await o.accessToken('microsoft'), first, 'still fresh');
    t += 3600_000;
    const [a, b] = await Promise.all([o.accessToken('microsoft'), o.accessToken('microsoft')]);
    assert.equal(a, b);
    assert.notEqual(a, first);
    assert.equal(f.calls.filter((c) => /token$/.test(c.url.pathname) && String(c.body).includes('refresh_token')).length, 1, 'one refresh for two callers');
    const saved = JSON.parse(await store.get('oauth-microsoft'));
    assert.match(saved.refresh_token, /microsoft-rt-2/, 'the rotated refresh token is kept');
    await store.set('oauth-microsoft', JSON.stringify({ ...saved, refresh_token: 'dead', expires_at: 0 }));
    await assert.rejects(o.accessToken('microsoft'), /Sign in again in setup/);
  });

  it('disconnect revokes where the provider allows it (Google) and always forgets the tokens', async () => {
    const { o, f, store } = await oauthFor({ config: { google: { clientId: 'g' }, microsoft: { clientId: 'm' } } });
    for (const p of ['google', 'microsoft']) { const { url } = await o.start(p, 'http://127.0.0.1:1/cb'); await o.callback(p, f.approve(url)); }
    const g = await o.disconnect('google');
    assert.equal(g.revoked, true);
    assert.ok(f.calls.some((c) => c.url.pathname === '/revoke' && /token=google-rt-/.test(String(c.body))));
    const m = await o.disconnect('microsoft');
    assert.deepEqual([m.revoked, typeof m.manage], [false, 'string']);
    assert.equal(await store.get('oauth-google'), null);
    assert.equal((await o.status('microsoft')).connected, false);
  });
});

describe('sign-in, end to end through the server', () => {
  async function server() {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ oauth: { google: { clientId: 'g-id' }, atlassian: { clientId: 'a-id' } } }));
    const secrets = await createSecretStore({ dir, backend: 'file' });
    await secrets.set('atlassian-client-secret', 'shh');
    const f = fakeProviders();
    const app = await createBirddog({ dir, sources: [cal, jira], autoRefresh: false, log: quiet, secrets, fetchImpl: f });
    const port = await app.start(0);
    const base = `http://127.0.0.1:${port}`;
    const call = async (p, method = 'GET', body) => fetch(`${base}${p}`, { method, redirect: 'manual', headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    return { app, f, call, base, secrets };
  }

  it('Google: start → provider → callback switches the Calendar on and reads events', async () => {
    const { app, f, call, base } = await server();
    try {
      const list = await (await call('/api/oauth')).json();
      const g = list.providers.find((p) => p.id === 'google');
      assert.deepEqual([g.configured, g.connected, g.redirectUri], [true, false, `${base}/auth/oauth/google/callback`]);
      assert.doesNotMatch(JSON.stringify(list), /shh/);
      const { url } = await (await call('/api/oauth/google/start', 'POST', {})).json();
      const { code, state } = f.approve(url);
      const back = await call(`/auth/oauth/google/callback?code=${code}&state=${state}`);
      assert.equal(back.status, 302);
      assert.equal(back.headers.get('location'), '/?connected=google');
      assert.equal(app.config.sources.cal.provider, 'google');
      assert.equal(app.config.sources.cal.enabled, true);
      const snap = await app.refresh();
      const items = snap.items.filter((i) => i.source === 'cal');
      assert.deepEqual(items.map((i) => i.url), ['https://meet.google.com/abc-defg-hij'], 'declined and cancelled events are left out');
      assert.equal(items[0].urgency, 'now');
      const bad = await call(`/auth/oauth/google/callback?code=nope&state=${state}`);
      assert.equal(bad.status, 400);
      assert.match(await bad.text(), /expired or was already used/);
      const off = await (await call('/api/oauth/google', 'DELETE', {})).json();
      assert.equal(off.revoked, true);
      assert.equal(app.config.sources.cal.enabled, false, 'the source that used it is switched off');
    } finally { await app.close(); }
  });

  it('Atlassian: the Jira source uses the cloud API with a Bearer token', async () => {
    const { app, f, call } = await server();
    try {
      const { url } = await (await call('/api/oauth/atlassian/start', 'POST', {})).json();
      assert.equal(new URL(url).searchParams.get('audience'), 'api.atlassian.com');
      const { code, state } = f.approve(url);
      assert.equal((await call(`/auth/oauth/atlassian/callback?code=${code}&state=${state}`)).status, 302);
      assert.deepEqual([app.config.sources.jira.auth, app.config.sources.jira.site], ['oauth', 'https://acme.atlassian.net']);
      const snap = await app.refresh();
      const item = snap.items.find((i) => i.source === 'jira');
      assert.equal(item.url, 'https://acme.atlassian.net/browse/A-1', 'links still point at your site');
      assert.ok(f.calls.some((c) => c.url.host === 'api.atlassian.com' && c.url.pathname === '/ex/jira/cloud-1/rest/api/3/search/jql'));
    } finally { await app.close(); }
  });
});

describe('calendar back ends', () => {
  it('Google and Microsoft events become the same occurrences', async () => {
    const now = Date.now();
    const g = await googleOccurrences({ fetchImpl: fakeProviders({ now: () => now }), token: 't', from: now, to: now + 86_400_000 });
    assert.deepEqual(g.map((o) => [o.uid, o.declined, o.joinUrl]), [['g1', false, 'https://meet.google.com/abc-defg-hij'], ['g2', true, null]]);
    const graph = async () => json({ value: [
      { id: 'm1', subject: 'Review', start: { dateTime: '2026-11-04T15:00:00.0000000' }, end: { dateTime: '2026-11-04T15:30:00.0000000' }, onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/x' }, organizer: { emailAddress: { name: 'Ana' } }, type: 'occurrence' },
      { id: 'm2', subject: 'Gone', isCancelled: true, start: { dateTime: '2026-11-04T16:00:00' }, end: { dateTime: '2026-11-04T17:00:00' } },
      { id: 'm3', subject: 'Holiday', isAllDay: true, start: { dateTime: '2026-11-05T00:00:00' }, end: { dateTime: '2026-11-06T00:00:00' } },
    ] });
    const m = await graphOccurrences({ fetchImpl: graph, token: 't', from: now, to: now + 1 });
    assert.equal(m.length, 2);
    assert.equal(new Date(m[0].start).toISOString(), '2026-11-04T15:00:00.000Z');
    assert.deepEqual([m[0].joinUrl, m[0].organizer, m[0].recurring], ['https://teams.microsoft.com/l/x', 'Ana', true]);
    assert.equal(m[1].allDay, true);
    assert.equal(new Date(m[1].start).getDate(), 5, 'all-day dates stay on their local day');
  });

  it('iCloud CalDAV: discovers calendars, follows iCloud redirects, never sends the password elsewhere', async () => {
    const seen = [];
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:i1\nSUMMARY:Dentist &amp; cleanup\nDTSTART:20261104T150000Z\nDTEND:20261104T160000Z\nEND:VEVENT\nEND:VCALENDAR';
    const res = (status, xml, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), text: async () => xml });
    const dav = async (url, init) => {
      const u = new URL(url);
      seen.push([init.method, u.host, u.pathname, init.headers.authorization]);
      if (u.host === 'caldav.icloud.com') return res(301, '', { location: 'https://p42-caldav.icloud.com/' });
      if (u.pathname === '/') return res(207, '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>');
      if (u.pathname === '/123/principal/') return res(207, '<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/123/principal/</href><propstat><prop><C:calendar-home-set><href>https://p42-caldav.icloud.com/123/calendars/</href></C:calendar-home-set></prop></propstat></response></multistatus>');
      if (u.pathname === '/123/calendars/' && init.method === 'PROPFIND') return res(207, `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response><d:href>/123/calendars/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
        <d:response><d:href>/123/calendars/home/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Home</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>
        <d:response><d:href>/123/calendars/tasks/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Reminders</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response></d:multistatus>`);
      if (u.pathname === '/123/calendars/home/' && init.method === 'REPORT') {
        assert.match(init.body, /<c:time-range start="\d{8}T\d{6}Z" end="\d{8}T\d{6}Z"\/>/);
        return res(207, `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/123/calendars/home/i1.ics</d:href><d:propstat><d:prop><c:calendar-data>${ics}</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`);
      }
      return res(404, '');
    };
    const c = caldavClient({ fetchImpl: dav, username: 'me@icloud.com', password: 'abcd-efgh-ijkl-mnop' });
    const cals = await c.calendars({ from: Date.now(), to: Date.now() + 86_400_000 });
    assert.equal(cals.length, 1);
    assert.equal(cals[0].label, 'caldav.icloud.com · Home');
    assert.match(cals[0].text, /SUMMARY:Dentist & cleanup/, 'XML entities decoded');
    assert.ok(seen.every(([, host]) => host.endsWith('icloud.com')));
    assert.ok(!seen.some(([, , p]) => p === '/123/calendars/tasks/'), 'task lists are not read');

    const evil = caldavClient({ fetchImpl: async () => res(302, '', { location: 'https://evil.example/' }), username: 'a@b.c', password: 'p' });
    await assert.rejects(evil.calendars({ from: 0, to: 1 }), /refusing to send your password there/);
    const denied = caldavClient({ fetchImpl: async () => res(401, ''), username: 'a@b.c', password: 'p' });
    await assert.rejects(denied.calendars({ from: 0, to: 1 }), /app-specific password/);
    assert.deepEqual(davResponses('<x:response><x:href>/a/</x:href></x:response>').map((r) => r.href), ['/a/']);
    assert.throws(() => caldavClient({ fetchImpl: dav, baseUrl: 'http://cal.example/', username: 'a', password: 'b' }), /https/);
  });

  it('the Calendar card saves iCloud as provider caldav with the password in the keychain', () => {
    assert.deepEqual(cal.normalizeSettings({ provider: 'caldav', caldavUser: ' me@icloud.com ' }), { provider: 'caldav', caldavUser: 'me@icloud.com' });
    assert.throws(() => cal.normalizeSettings({ provider: 'yahoo' }), /provider must be one of/);
    assert.deepEqual({ ...cal.secretFields }, { url: 'cal-url', caldavPassword: 'caldav-password' });
  });
});

describe('Sign in with Apple (optional dashboard login)', () => {
  it('signs a short-lived ES256 client secret Apple can verify', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const now = Date.parse('2026-11-04T12:00:00Z');
    const jwt = appleClientSecret({ teamId: 'TEAM123456', keyId: 'KEY1234567', clientId: 'com.example.birddog', privateKey: pem, now });
    const [h, p, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.deepEqual(claims, { iss: 'TEAM123456', iat: now / 1000, exp: now / 1000 + 600, aud: 'https://appleid.apple.com', sub: 'com.example.birddog' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
    assert.throws(() => appleClientSecret({ teamId: 'T' }), /needs auth\.appleTeamId/);
  });

  it('asks for form_post, sends a fresh secret per sign-in, and refuses unverified emails sent as strings', async () => {
    const idp = fakeIdp({ issuer: 'https://appleid.test', alg: 'ES256', clientId: 'com.example.birddog' });
    let secrets = 0;
    const oidc = createOidc({ issuer: idp.issuer, clientId: idp.clientId, fetchImpl: idp.fetch, scopes: 'openid email name', responseMode: 'form_post', clientSecret: () => `jwt-${++secrets}` });
    const url = await oidc.loginUrl({ redirectUri: 'https://birddog.example.com/auth/callback' });
    assert.equal(new URL(url).searchParams.get('response_mode'), 'form_post');
    const ok = idp.authorize(url, { sub: 'apple-1', email: 'me@icloud.com', email_verified: 'true' });
    const { user } = await oidc.callback({ code: ok.code, state: ok.state });
    assert.equal(user.email, 'me@icloud.com');
    assert.equal(secrets, 1);
    const unverified = idp.authorize(await oidc.loginUrl({ redirectUri: 'https://birddog.example.com/auth/callback' }), { sub: 'apple-2', email: 'x@icloud.com', email_verified: 'false' });
    await assert.rejects(oidc.callback({ code: unverified.code, state: unverified.state }), /not verified/);
  });

  it('the server accepts Apple\'s form post back, and only from Apple', async () => {
    const idp = fakeIdp({ issuer: 'https://appleid.apple.com', alg: 'ES256', clientId: 'com.example.birddog' });
    const dir = await tmpDir();
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const secrets = await createSecretStore({ dir, backend: 'file' });
    await secrets.set('apple-private-key', privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify({ enabled: true, provider: 'apple', clientId: idp.clientId, appleTeamId: 'TEAM123456', appleKeyId: 'KEY1234567', allowedEmails: ['me@icloud.com'], publicUrl: 'https://birddog.example.com' }));
    const app = await createBirddog({ dir, sources: [], autoRefresh: false, log: quiet, secrets, fetchImpl: idp.fetch });
    const port = await app.start(0);
    const post = (body, origin) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/auth/callback', headers: { host: 'birddog.example.com', origin, 'content-type': 'application/x-www-form-urlencoded' } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
      req.on('error', reject);
      req.end(body);
    });
    try {
      const login = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/auth/login', headers: { host: 'birddog.example.com' } }, (res) => { res.resume(); resolve(res.headers.location); }));
      assert.equal(new URL(login).searchParams.get('response_mode'), 'form_post');
      const { code, state } = idp.authorize(login, { sub: 'a1', email: 'me@icloud.com', email_verified: 'true' });
      const tokenBody = () => idp.calls.length;
      const before = tokenBody();
      assert.equal((await post(`code=${code}&state=${state}`, 'https://evil.example')).statusCode, 403, 'other sites cannot post here');
      const res = await post(`code=${code}&state=${state}`, 'https://appleid.apple.com');
      assert.equal(res.statusCode, 302);
      assert.match(res.headers['set-cookie'][0], /HttpOnly/);
      assert.ok(idp.calls.length > before);
    } finally { await app.close(); }
  });
});
