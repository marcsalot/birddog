import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as jira from '../src/sources/jira.mjs';
import { DAY, fakeFetch } from './helpers.mjs';

const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime(); // local noon, 3 Nov 2026
const ymd = (daysFromNow) => {
  const d = new Date(NOW + daysFromNow * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const SPRINT = 'customfield_10020';
const FLAG = 'customfield_10021';

const ticket = (key, fields = {}) => ({
  key,
  fields: {
    summary: `Summary of ${key}`, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'Medium' }, duedate: null, updated: iso(2), issuetype: { name: 'Task' }, project: { name: 'Alpha' },
    issuelinks: [], ...fields,
  },
});
const blockedBy = (key, done = false) => ({
  type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  inwardIssue: { key, fields: { status: { name: done ? 'Done' : 'To Do', statusCategory: { key: done ? 'done' : 'new' } } } },
});

function fakeJira({ site = 'acme.atlassian.net', over = {} } = {}) {
  const pages = {
    '': { issues: [
      ticket('A-1', { duedate: ymd(-2) }),
      ticket('A-2', { [SPRINT]: [{ id: 1, name: 'Old', state: 'closed', endDate: iso(14) }, { id: 2, name: 'Sprint 42', state: 'active', endDate: new Date(NOW + 0.5 * DAY).toISOString() }] }),
      ticket('A-3', { issuelinks: [blockedBy('B-9'), { type: { inward: 'is blocked by' }, outwardIssue: { key: 'C-1' } }] }),
      ticket('A-4', { issuelinks: [blockedBy('B-8', true)], priority: { name: 'Highest' } }),
      ticket('A-5', { [FLAG]: [{ value: 'Impediment' }] }),
    ], nextPageToken: 'p2', isLast: false },
    p2: { issues: [
      ticket('A-6', { updated: iso(10) }),
      ticket('A-7', { status: { name: 'Blocked', statusCategory: { key: 'indeterminate' } } }),
      ticket('A-8', { duedate: ymd(2) }),
      ticket('A-9', { [SPRINT]: [{ id: 2, name: 'Sprint 42', state: 'active', endDate: new Date(NOW + 2.5 * DAY).toISOString() }] }),
    ], isLast: true },
  };
  const routes = {
    '/rest/api/3/myself': { body: { displayName: 'Marcus F', emailAddress: 'me@acme.com' } },
    '/rest/api/3/field': { body: [
      { id: 'summary', name: 'Summary', custom: false },
      { id: SPRINT, name: 'Sprint', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
      { id: FLAG, name: 'Flagged', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes' } },
    ] },
    '/rest/api/3/search/jql': (u) => ({ body: pages[u.searchParams.get('nextPageToken') ?? ''] }),
    ...over,
  };
  return fakeFetch((u) => {
    assert.equal(u.host, site);
    const r = routes[u.pathname];
    return typeof r === 'function' ? r(u) : r;
  });
}

const config = (site = 'https://acme.atlassian.net') => ({ site, email: 'me@acme.com' });
const ctx = (fetchImpl, token = 'atl-token') => ({ now: NOW, fetch: fetchImpl, secret: async (n) => (n === 'jira-token' ? token : null) });

describe('Jira source', () => {
  it('normalizes the site address and validates settings', () => {
    assert.equal(jira.normalizeSite('acme'), 'https://acme.atlassian.net');
    assert.equal(jira.normalizeSite(' Acme.Atlassian.net '), 'https://acme.atlassian.net');
    assert.equal(jira.normalizeSite('https://acme.atlassian.net/browse/A-1?x=1'), 'https://acme.atlassian.net');
    assert.throws(() => jira.normalizeSite('http://acme.atlassian.net'), /https/);
    assert.throws(() => jira.normalizeSite(''), /Enter your Jira site/);
    assert.throws(() => jira.normalizeSettings({ site: 'acme', email: 'nope' }), /email/);
    assert.deepEqual(jira.normalizeSettings({ site: 'acme', email: ' me@acme.com ', token: 'x' }), { site: 'https://acme.atlassian.net', email: 'me@acme.com', auth: 'token' });
    assert.equal(jira.enabledByDefault, false);
    assert.deepEqual({ ...jira.secretFields }, { token: 'jira-token' });
  });

  it('ranks assigned tickets: overdue, sprint ending, blocked, due soon, priority', async () => {
    const f = fakeJira();
    let summary;
    const items = await jira.collect(config(), { ...ctx(f), summary: (s) => { summary = s; } });
    const by = Object.fromEntries(items.map((i) => [i.meta.fields.Ticket, i]));
    const rule = (k) => by[k].meta.rule.id;

    assert.equal(items.length, 9, 'both pages are read');
    assert.equal(rule('A-1'), 'jira-overdue');
    assert.equal(by['A-1'].urgency, 'now');
    assert.equal(by['A-1'].why, '**Overdue** · was due **1 day ago** and is still In Progress');
    assert.equal(rule('A-2'), 'jira-sprint-ending');
    assert.equal(by['A-2'].why, 'Sprint **Sprint 42** ends **today** · still In Progress');
    assert.equal(rule('A-3'), 'jira-blocked');
    assert.equal(by['A-3'].why, '**Blocked** by B-9 · chase it or pick up something else');
    assert.equal(rule('A-4'), 'jira-high-priority', 'a blocker that is done no longer blocks');
    assert.equal(by['A-5'].why, '**Flagged** as an impediment · find out what it needs');
    assert.equal(rule('A-6'), 'jira-assigned');
    assert.equal(by['A-6'].urgency, 'later');
    assert.equal(by['A-6'].why, '**In Progress** · last updated **10 days** ago');
    assert.equal(by['A-7'].why, 'Status is **Blocked** · find out what it is waiting for');
    assert.equal(by['A-8'].why, 'Due **in 2 days** · In Progress');
    assert.equal(rule('A-9'), 'jira-sprint-ending-soon');

    assert.equal(by['A-1'].url, 'https://acme.atlassian.net/browse/A-1');
    assert.equal(by['A-1'].id, 'jira:acme.atlassian.net:A-1');
    assert.equal(by['A-1'].title, 'A-1 · Summary of A-1');
    assert.equal(summary, 'acme.atlassian.net · 9 open tickets · 3 blocked');
  });

  it('signs in with email + token over Basic auth and only reads', async () => {
    const f = fakeJira();
    await jira.collect(config(), ctx(f));
    const expected = `Basic ${Buffer.from('me@acme.com:atl-token').toString('base64')}`;
    assert.ok(f.calls.every((c) => c.method === 'GET' && c.headers.authorization === expected));
    const search = f.calls.find((c) => c.url.pathname === '/rest/api/3/search/jql').url.searchParams;
    assert.equal(search.get('jql'), jira.DEFAULT_JQL);
    assert.match(search.get('fields'), new RegExp(`${SPRINT},${FLAG}$`));
  });

  it('explains what is missing or wrong', async () => {
    await assert.rejects(jira.collect({}, ctx(fakeJira())), /Connect Jira in setup/);
    await assert.rejects(jira.collect(config(), ctx(fakeJira(), null)), /No Jira API token/);
    const denied = fakeJira({ site: 'denied.atlassian.net', over: { '/rest/api/3/field': { status: 401 }, '/rest/api/3/search/jql': { status: 401 } } });
    await assert.rejects(jira.collect(config('https://denied.atlassian.net'), ctx(denied)), /rejected the email or API token/);
    const t = await jira.test(config('https://denied.atlassian.net'), ctx(fakeJira({ site: 'denied.atlassian.net', over: { '/rest/api/3/myself': { status: 401 } } })));
    assert.equal(t.ok, false);
    const offline = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(jira.collect(config('https://offline.atlassian.net'), ctx(offline)), /not reachable/);
  });

  it('keeps going without the Sprint and Flagged fields', async () => {
    const f = fakeJira({ site: 'nofields.atlassian.net', over: { '/rest/api/3/field': { status: 500 } } });
    const warnings = [];
    const items = await jira.collect(config('https://nofields.atlassian.net'), { ...ctx(f), warn: (w) => warnings.push(w) });
    assert.equal(items.length, 9);
    assert.ok(warnings.some((w) => /Sprint and Flagged/.test(w)));
  });

  it('test() says who you are signed in as', async () => {
    const r = await jira.test(config(), ctx(fakeJira()));
    assert.deepEqual([r.ok, r.message], [true, 'Connected to acme.atlassian.net as Marcus F']);
  });

  it('due dates count to the end of the local day', () => {
    assert.ok(jira.dueDaysLeft(ymd(0), NOW) > 0 && jira.dueDaysLeft(ymd(0), NOW) < 1);
    assert.ok(jira.dueDaysLeft(ymd(-1), NOW) < 0);
    assert.equal(jira.dueDaysLeft(null, NOW), null);
  });
});
