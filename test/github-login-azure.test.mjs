// Sign in with GitHub for the dashboard, and Azure DevOps through Microsoft Entra.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createGithubLogin, githubApi } from '../src/auth/github-login.mjs';
import { checkAuthConfig, isAllowed } from '../src/auth/oidc.mjs';
import { PROVIDERS } from '../src/auth/oauth.mjs';
import { createSessions } from '../src/auth/session.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import * as azure from '../src/sources/azure.mjs';
import { fakeFetch, fakeItem, tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };

/** A fake github.com: one account per code, org memberships, and what it was sent. */
function fakeGithub(accounts) {
  const sent = [];
  let lastCode = null;
  const fetch = fakeFetch((u, init) => {
    sent.push({ url: u.href, init });
    if (u.pathname === '/login/oauth/access_token') {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('client_secret'), 'shh');
      assert.ok(body.get('code_verifier'), 'PKCE verifier sent');
      lastCode = body.get('code');
      return { body: accounts[lastCode] ? { access_token: `tok-${lastCode}` } : { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } };
    }
    const a = accounts[String(init.headers?.authorization ?? '').replace('Bearer tok-', '')];
    if (!a) return { status: 401, body: {} };
    if (u.pathname.endsWith('/user')) return { body: { id: a.id, login: a.login, name: a.name } };
    if (u.pathname.endsWith('/user/emails')) return { body: a.emails };
    const m = /\/user\/memberships\/orgs\/([^/]+)$/.exec(u.pathname);
    if (m) return (a.orgs ?? []).includes(decodeURIComponent(m[1])) ? { body: { state: 'active' } } : { status: 404, body: { message: 'Not Found' } };
    return undefined;
  });
  return { fetch, sent };
}

const ACCOUNTS = {
  sam: { id: 1, login: 'Sam-Dev', name: 'Sam', emails: [{ email: 'old@x.example', primary: false, verified: true }, { email: 'sam@acme.example', primary: true, verified: true }], orgs: ['acme'] },
  kai: { id: 2, login: 'kai', name: null, emails: [{ email: 'kai@else.example', primary: true, verified: false }], orgs: [] },
};

describe('Sign in with GitHub (dashboard login)', () => {
  it('builds the authorize URL with PKCE, and read:org only when organizations are allowed', async () => {
    const plain = createGithubLogin({ clientId: 'cid', clientSecret: 'shh' });
    const u = new URL(await plain.loginUrl({ redirectUri: 'https://bd.example.com/auth/callback' }));
    assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(u.searchParams.get('scope'), 'read:user user:email');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    const withOrgs = createGithubLogin({ clientId: 'cid', clientSecret: 'shh', allowedOrgs: ['acme'], webUrl: 'https://github.example.com/' });
    const u2 = new URL(await withOrgs.loginUrl({ redirectUri: 'x' }));
    assert.equal(u2.origin, 'https://github.example.com');
    assert.match(u2.searchParams.get('scope'), /read:org/);
    assert.equal(githubApi('https://github.example.com'), 'https://github.example.com/api/v3');
    assert.equal(githubApi('https://github.com'), 'https://api.github.com');
  });

  it('signs in: the primary verified email, the login, and the allowed orgs you belong to', async () => {
    const gh = fakeGithub(ACCOUNTS);
    const login = createGithubLogin({ clientId: 'cid', clientSecret: async () => 'shh', allowedOrgs: ['acme', 'other'], fetchImpl: gh.fetch });
    const state = new URL(await login.loginUrl({ redirectUri: 'r', returnTo: '/later' })).searchParams.get('state');
    const { user, returnTo } = await login.callback({ code: 'sam', state });
    assert.deepEqual(user, { sub: 'github:1', login: 'Sam-Dev', email: 'sam@acme.example', name: 'Sam', orgs: ['acme'] });
    assert.equal(returnTo, '/later');
    await assert.rejects(login.callback({ code: 'sam', state }), /expired or was already used/);
    const s2 = new URL(await login.loginUrl({ redirectUri: 'r' })).searchParams.get('state');
    const kai = (await login.callback({ code: 'kai', state: s2 })).user;
    assert.equal(kai.email, null, 'an unverified email is never used');
    const s3 = new URL(await login.loginUrl({ redirectUri: 'r' })).searchParams.get('state');
    await assert.rejects(login.callback({ code: 'nope', state: s3 }), /incorrect or expired/);
    await assert.rejects(login.callback({ error: 'access_denied', state: s3 }), /cancelled or refused/);
  });

  it('allows by GitHub username, organization, email or domain', () => {
    const auth = { provider: 'github', allowedLogins: ['sam-dev'], allowedOrgs: ['Acme'], allowedEmails: [], allowedDomains: ['team.example'] };
    assert.equal(isAllowed(auth, { login: 'SAM-DEV', orgs: [] }), true);
    assert.equal(isAllowed(auth, { login: 'kai', orgs: ['acme'] }), true);
    assert.equal(isAllowed(auth, { login: 'kai', orgs: [], email: 'kai@team.example' }), true);
    assert.equal(isAllowed(auth, { login: 'kai', orgs: ['other'], email: null }), false);
    assert.equal(isAllowed({ allowedLogins: ['kai'] }, { login: 'kai' }), false, 'logins count only for the GitHub provider');
  });

  it('checks the config: no issuer needed, an allow list required', () => {
    assert.deepEqual(checkAuthConfig({ enabled: true, provider: 'github', clientId: 'x', allowedOrgs: ['acme'] }), []);
    assert.match(checkAuthConfig({ enabled: true, provider: 'github', clientId: 'x' }).join(' '), /allowedLogins, auth.allowedOrgs/);
    assert.match(checkAuthConfig({ enabled: true, provider: 'github', clientId: 'x', allowedLogins: ['a'], githubUrl: 'http://gh' }).join(' '), /githubUrl/);
  });

  it('keeps the login and orgs in the signed session cookie', () => {
    const s = createSessions({ key: 'k'.repeat(48), ttlMs: 60_000 });
    const cookie = s.issue({ sub: 'github:1', login: 'sam', email: null, name: 'Sam', orgs: ['acme'] }).split(';')[0];
    assert.deepEqual(s.read(cookie), { sub: 'github:1', email: null, name: 'Sam', login: 'sam', orgs: ['acme'] });
    assert.deepEqual(s.read(s.issue({ sub: 'u', email: 'a@b.c', name: 'A' }).split(';')[0]), { sub: 'u', email: 'a@b.c', name: 'A' });
  });

  describe('end to end', () => {
    let app; let port; let dir;
    const req = async (p, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual', headers });
      return { status: res.status, location: res.headers.get('location'), cookie: res.headers.get('set-cookie'), text: await res.text() };
    };
    before(async () => {
      dir = await tmpDir();
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ auth: { enabled: true, provider: 'github', clientId: 'cid', allowedOrgs: ['acme'] } }));
      const secrets = await createSecretStore({ dir, backend: 'file' });
      await secrets.set('oidc-client-secret', 'shh');
      const src = { id: 'fake', name: 'Fake', test: async () => ({ ok: true }), collect: async () => [fakeItem()] };
      app = await createBirddog({ dir, sources: [src], autoRefresh: false, log: quiet, secrets, fetchImpl: fakeGithub(ACCOUNTS).fetch });
      port = await app.start(0);
    });
    after(() => app.close());

    const signIn = async (code) => {
      const toGh = await req('/auth/login?returnTo=%2F');
      assert.equal(toGh.status, 302);
      const state = new URL(toGh.location).searchParams.get('state');
      return req(`/auth/callback?code=${code}&state=${state}`);
    };

    it('lets an org member in, with a session the API accepts', async () => {
      const cb = await signIn('sam');
      assert.equal(cb.status, 302);
      const cookie = cb.cookie.split(';')[0];
      const me = JSON.parse((await req('/api/me', { cookie })).text);
      assert.equal(me.user.login, 'Sam-Dev');
      assert.equal((await req('/api/items', { cookie })).status, 200);
    });

    it('turns away someone outside the org, naming the setting to change', async () => {
      const cb = await signIn('kai');
      assert.equal(cb.status, 403);
      assert.match(cb.text, /@kai/);
      assert.match(cb.text, /allowedLogins/);
      assert.equal(cb.cookie, null);
    });
  });
});

describe('Azure DevOps through Microsoft Entra', () => {
  it('signs in on the Microsoft app with the read-only Azure DevOps scopes', () => {
    const p = PROVIDERS.azuredevops;
    assert.equal(p.app, 'microsoft');
    assert.deepEqual(p.scopes.filter((s) => s.startsWith('499b84ac')), ['499b84ac-1321-427f-aa17-267ca6975798/vso.code', '499b84ac-1321-427f-aa17-267ca6975798/vso.work']);
    assert.equal(azure.setup.oauth, 'azuredevops');
  });

  it('uses the sign-in token as Bearer, and a PAT as Basic', async () => {
    const seen = [];
    const fetch = fakeFetch((u, init) => {
      seen.push(init.headers.authorization);
      if (u.pathname.endsWith('/_apis/connectionData')) return { body: { authenticatedUser: { id: 'me', providerDisplayName: 'Sam' } } };
      if (u.pathname.endsWith('/pullrequests')) return { body: { value: [] } };
      if (u.pathname.endsWith('/wiql')) return { body: { workItems: [] } };
      return undefined;
    });
    const config = { ...azure.normalizeSettings({ organization: 'https://dev.azure.com/Contoso', project: 'Payments', auth: 'oauth' }) };
    assert.deepEqual(config, { organization: 'contoso', project: 'Payments', auth: 'oauth' });
    await azure.collect(config, { fetch, now: 0, oauth: { accessToken: async (p) => { assert.equal(p, 'azuredevops'); return 'entra'; } } });
    assert.ok(seen.every((h) => h === 'Bearer entra'));
    seen.length = 0;
    await azure.collect({ organization: 'contoso', project: 'Payments' }, { fetch, now: 0, secret: async () => 'pat' });
    assert.ok(seen.every((h) => h === `Basic ${Buffer.from(':pat').toString('base64')}`));
    await assert.rejects(azure.collect({ organization: 'contoso', project: 'P' }, { fetch, now: 0, secret: async () => null }), /Sign in with Azure DevOps, or add a personal access token/);
    assert.equal('auth' in azure.normalizeSettings({ organization: 'contoso', project: 'P' }), false, 'a form without auth keeps what was saved');
  });
});
