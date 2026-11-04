// Container mode: secrets from environment variables / Docker secret files, never written.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createSecretStore, ReadOnlySecretsError } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import * as githubSource from '../src/sources/github.mjs';
import * as jiraSource from '../src/sources/jira.mjs';
import { fakeFetch, tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };

describe('environment secret store', () => {
  it('reads plain variables, aliases and *_FILE secrets, and never writes', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'jira'), 'atl-from-file\n');
    const env = { GH_TOKEN: 'gho_alias', BIRDDOG_JIRA_TOKEN_FILE: path.join(dir, 'jira') };
    const s = await createSecretStore({ dir, backend: 'env', env });
    assert.equal(s.readOnly, true);
    assert.equal(s.secure, true);
    assert.equal(s.warning, null);
    assert.equal(await s.get('github-token'), 'gho_alias');
    assert.equal(await s.get('jira-token'), 'atl-from-file');
    assert.equal(await s.get('cal-url'), null);
    assert.deepEqual(s.describe('jira-token'), { variable: 'BIRDDOG_JIRA_TOKEN', from: 'BIRDDOG_JIRA_TOKEN_FILE' });
    assert.deepEqual(s.describe('cal-url'), { variable: 'BIRDDOG_CAL_URL', from: null });
    await assert.rejects(s.set('jira-token', 'x'), (e) => e instanceof ReadOnlySecretsError && /set BIRDDOG_JIRA_TOKEN \(or BIRDDOG_JIRA_TOKEN_FILE/.test(e.message));
    await assert.rejects(s.delete('cal-url'), /unset BIRDDOG_CAL_URL/);
    assert.deepEqual(await fs.readdir(dir), ['jira'], 'nothing was written');
    const broken = await createSecretStore({ dir, backend: 'env', env: { BIRDDOG_CAL_URL_FILE: '/nope/missing' } });
    await assert.rejects(broken.get('cal-url'), /BIRDDOG_CAL_URL_FILE points at \/nope\/missing/);
  });

  it('a container refuses the plain-text file fallback', async () => {
    const dir = await tmpDir();
    await assert.rejects(createSecretStore({ dir, backend: 'file', env: { BIRDDOG_CONTAINER: '1' } }), /not allowed in a container/);
    const s = await createSecretStore({ dir, backend: undefined, env: { BIRDDOG_CONTAINER: '1' } });
    assert.equal(s.kind, 'environment variables');
  });
});

describe('Birddog with environment secrets (Docker)', () => {
  const env = { GITHUB_TOKEN: 'gho_env', BIRDDOG_JIRA_TOKEN: 'atl-env' };
  const fetchImpl = fakeFetch((u, init) => {
    if (u.host === 'api.github.com') {
      assert.equal(init.headers.authorization, 'Bearer gho_env');
      if (u.pathname === '/user') return { body: { login: 'octocat' } };
      if (u.pathname === '/search/issues') return { body: { total_count: 0, items: [] } };
      if (u.pathname === '/notifications') return { body: [] };
    }
    if (u.host === 'acme.atlassian.net') {
      if (init.headers.authorization !== `Basic ${Buffer.from('me@acme.com:atl-env').toString('base64')}`) return { status: 401 };
      if (u.pathname === '/rest/api/3/myself') return { body: { displayName: 'M' } };
      if (u.pathname === '/rest/api/3/field') return { body: [] };
      if (u.pathname === '/rest/api/3/search/jql') return { body: { isLast: true, issues: [] } };
    }
    return undefined;
  });

  async function start() {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ sources: { jira: { site: 'https://acme.atlassian.net', email: 'me@acme.com', token: 'typed-into-config' } } }));
    const warnings = [];
    const secrets = await createSecretStore({ dir, backend: 'env', env });
    const app = await createBirddog({ dir, sources: [githubSource, jiraSource], autoRefresh: false, secrets, fetchImpl, log: { ...quiet, warn: (w) => warnings.push(w) }, allowRemote: true });
    const port = await app.start(0);
    const call = async (p, method = 'GET', body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    return { dir, app, call, warnings };
  }

  it('GitHub signs in from GITHUB_TOKEN; setup says where secrets come from, never what they are', async () => {
    const { app, call, warnings, dir } = await start();
    try {
      const setup = (await call('/api/setup')).json;
      assert.equal(setup.container, true);
      assert.deepEqual(setup.secretsFrom, {
        'github-token': { variable: 'GITHUB_TOKEN', from: 'GITHUB_TOKEN' },
        'jira-token': { variable: 'BIRDDOG_JIRA_TOKEN', from: 'BIRDDOG_JIRA_TOKEN' },
      });
      assert.equal(setup.connections.github.connected, true);
      assert.equal(setup.connections.github.method, 'env');
      assert.equal(setup.connections.github.login, 'octocat');
      assert.doesNotMatch(JSON.stringify(setup), /gho_env|atl-env|typed-into-config/);
      const snap = await app.refresh();
      assert.equal(snap.sources.find((s) => s.id === 'github').status, 'ok');
      assert.ok(warnings.some((w) => /sources\.jira\.token is in config\.json in plain text.*BIRDDOG_JIRA_TOKEN/.test(w)), 'warns instead of moving it');
      assert.equal(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8').catch(() => null), null, 'no secrets file');
    } finally { await app.close(); }
  });

  it('Jira uses BIRDDOG_JIRA_TOKEN; typing a token in setup explains where it has to go', async () => {
    const { app, call } = await start();
    try {
      const typed = await call('/api/sources/jira', 'PUT', { site: 'acme', email: 'me@acme.com', token: 'pasted' });
      assert.equal(typed.status, 400);
      assert.match(typed.json.error, /set BIRDDOG_JIRA_TOKEN/);
      const ok = await call('/api/sources/jira', 'PUT', { site: 'acme', email: 'me@acme.com' });
      assert.equal(ok.json.sources.find((s) => s.id === 'jira').status.status, 'ok');
      const off = await call('/api/sources/jira', 'DELETE', {});
      assert.equal(off.json.sources.find((s) => s.id === 'jira').enabled, false);
    } finally { await app.close(); }
  });

  it('outside container mode, listening beyond loopback still needs login', async () => {
    const dir = await tmpDir();
    const app = await createBirddog({ dir, sources: [], autoRefresh: false, log: quiet, secrets: await createSecretStore({ dir, backend: 'file' }) });
    await assert.rejects(app.start(0, '0.0.0.0'), /Refusing to listen on 0\.0\.0\.0 without login/);
    await app.close().catch(() => {});
  });
});
