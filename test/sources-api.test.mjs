// The GitHub and Jira sources wired through the real server, with fake APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import * as calSource from '../src/sources/cal.mjs';
import * as githubSource from '../src/sources/github.mjs';
import * as jiraSource from '../src/sources/jira.mjs';
import { fakeFetch, tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };

const fakeApis = () => fakeFetch((u, init) => {
  if (u.host === 'api.github.com') {
    assert.equal(init.headers.authorization, 'Bearer gho_cli');
    if (u.pathname === '/user') return { body: { login: 'octocat', name: 'Mona' } };
    if (u.pathname === '/search/issues') {
      const items = u.searchParams.get('q').includes('assignee:@me')
        ? [{ number: 7, title: 'Assigned thing', html_url: 'https://github.com/acme/api/issues/7', repository_url: 'https://api.github.com/repos/acme/api', updated_at: new Date().toISOString(), labels: [] }]
        : [];
      return { body: { total_count: items.length, items } };
    }
    if (u.pathname === '/notifications') return { body: [] };
  }
  if (u.host === 'cal.example.com' && u.pathname === '/private-abc/basic.ics') {
    const t = new Date(Date.now() + 5 * 60_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    return { text: `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:Soon\nDTSTART:${t}\nDURATION:PT30M\nEND:VEVENT\nEND:VCALENDAR` };
  }
  if (u.host === 'acme.atlassian.net') {
    const good = init.headers.authorization === `Basic ${Buffer.from('me@acme.com:atl-good').toString('base64')}`;
    if (!good) return { status: 401, body: { errorMessages: ['Unauthorized'] } };
    if (u.pathname === '/rest/api/3/myself') return { body: { displayName: 'Marcus F' } };
    if (u.pathname === '/rest/api/3/field') return { body: [] };
    if (u.pathname === '/rest/api/3/search/jql') {
      return { body: { isLast: true, issues: [{ key: 'A-1', fields: { summary: 'Do it', status: { name: 'To Do' }, updated: new Date().toISOString() } }] } };
    }
  }
  return undefined;
});

describe('GitHub and Jira through the API', () => {
  let dir; let app; let secrets;
  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}${p}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const source = async (id) => (await call('/api/items')).json.sources.find((s) => s.id === id);

  before(async () => {
    dir = await tmpDir();
    secrets = await createSecretStore({ dir, backend: 'file' });
    app = await createBirddog({
      dir, sources: [githubSource, jiraSource, calSource], autoRefresh: false, log: quiet, secrets,
      fetchImpl: fakeApis(), cliToken: async () => 'gho_cli',
    });
    await app.start(0);
    await app.refresh();
  });
  after(() => app.close());

  it('GitHub is stale with a "sign in" message until you connect, then fills in', async () => {
    const before = await source('github');
    assert.equal(before.status, 'stale');
    assert.match(before.error, /Sign in to GitHub in setup/);

    await call('/api/connections/github/gh-cli', { method: 'POST', body: {} });
    const { json } = await call('/api/refresh', { method: 'POST', body: {} });
    const gh = json.sources.find((s) => s.id === 'github');
    assert.equal(gh.status, 'ok');
    assert.equal(gh.summary, '@octocat · 0 review requests · 0 PRs needing work · 0 mentions · 1 assigned issue');
    assert.ok(json.items.some((i) => i.id === 'github:issue:acme/api#7'));
    const t = await call('/api/sources/github/test', { method: 'POST', body: {} });
    assert.equal(t.json.message, 'Connected to github.com as @octocat');
  });

  it('Jira stays off until connected', async () => {
    assert.equal(await source('jira'), undefined);
    const setup = (await call('/api/setup')).json.sources.find((s) => s.id === 'jira');
    assert.equal(setup.enabled, false);
    assert.deepEqual(setup.secrets, { token: false });
  });

  it('Jira test uses the draft token without saving it', async () => {
    const bad = await call('/api/sources/jira/test', { method: 'POST', body: { site: 'acme', email: 'me@acme.com', token: 'atl-bad' } });
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.message, /rejected the email or API token/);
    const good = await call('/api/sources/jira/test', { method: 'POST', body: { site: 'acme', email: 'me@acme.com', token: 'atl-good' } });
    assert.deepEqual([good.json.ok, good.json.message], [true, 'Connected to acme.atlassian.net as Marcus F']);
    assert.equal(await secrets.get('jira-token'), null);
    const invalid = await call('/api/sources/jira/test', { method: 'POST', body: { site: 'http://acme.atlassian.net', email: 'me@acme.com' } });
    assert.match(invalid.json.message, /https/);
  });

  it('saving Jira puts the token in the secret store, never in config.json', async () => {
    const saved = await call('/api/sources/jira', { method: 'PUT', body: { site: 'acme.atlassian.net', email: 'me@acme.com', token: ' atl-good ' } });
    assert.equal(saved.status, 200);
    const j = saved.json.sources.find((s) => s.id === 'jira');
    assert.equal(j.enabled, true);
    assert.deepEqual(j.secrets, { token: true });
    assert.equal(j.status.status, 'ok');
    assert.deepEqual(j.settings, { site: 'https://acme.atlassian.net', email: 'me@acme.com', enabled: true });
    assert.equal(await secrets.get('jira-token'), 'atl-good');
    const raw = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    assert.doesNotMatch(raw, /atl-good/);
    assert.ok((await call('/api/items')).json.items.some((i) => i.id === 'jira:acme.atlassian.net:A-1'));

    // A blank token on a later save keeps the saved one.
    await call('/api/sources/jira', { method: 'PUT', body: { site: 'acme', email: 'me@acme.com', token: '' } });
    assert.equal(await secrets.get('jira-token'), 'atl-good');
  });

  it('disconnecting Jira deletes the token and switches it off', async () => {
    const res = await call('/api/sources/jira', { method: 'DELETE', body: {} });
    const j = res.json.sources.find((s) => s.id === 'jira');
    assert.equal(j.enabled, false);
    assert.deepEqual(j.secrets, { token: false });
    assert.equal(await secrets.get('jira-token'), null);
    assert.equal(await source('jira'), undefined);
  });

  it('calendar: the iCal link is a secret; webcal links work', async () => {
    const saved = await call('/api/sources/cal', { method: 'PUT', body: { url: 'webcal://cal.example.com/private-abc/basic.ics', file: '', email: '' } });
    assert.equal(saved.status, 200);
    const c = saved.json.sources.find((s) => s.id === 'cal');
    assert.equal(c.status.status, 'ok');
    assert.deepEqual(c.secrets, { url: true });
    assert.doesNotMatch(JSON.stringify(saved.json), /private-abc/);
    assert.equal(await secrets.get('cal-url'), 'https://cal.example.com/private-abc/basic.ics');
    assert.doesNotMatch(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), /private-abc/);
    const items = (await call('/api/items')).json.items.filter((i) => i.source === 'cal');
    assert.equal(items.length, 1);
    assert.equal(items[0].urgency, 'now');
    const bad = await call('/api/sources/cal', { method: 'PUT', body: { url: 'http://cal.example.com/x.ics' } });
    assert.equal(bad.status, 400);
  });
});
