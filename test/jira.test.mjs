import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as jira from '../src/sources/jira.mjs';
import { buildGitActivity } from '../src/collector.mjs';
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
    const by = Object.fromEntries(items.filter((i) => i.kind === 'ticket').map((i) => [i.meta.fields.Ticket, i]));
    const rule = (k) => by[k].meta.rule.id;

    assert.equal(Object.keys(by).length, 9, 'both pages are read');
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
    assert.equal(items.filter((i) => i.kind === 'ticket').length, 9);
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

// ---------------------------------------------------------------------------
// Unblock signal tests

describe('buildUnblockItems', () => {
  const fieldIds = { sprint: null, flagged: null };

  /** Fake jira client where blockerStatuses maps key → { name, cat } */
  function fakeClient(blockerStatuses) {
    return {
      site: 'https://acme.atlassian.net',
      host: 'acme.atlassian.net',
      async get(path) {
        const m = /\/rest\/api\/3\/issue\/([^?]+)/.exec(path);
        if (m) {
          const key = decodeURIComponent(m[1]);
          const s = blockerStatuses[key];
          if (!s) return { fields: { status: { name: 'Unknown', statusCategory: { key: 'new' } } } };
          return { fields: { status: { name: s.name, statusCategory: { key: s.cat } } } };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    };
  }

  it('emits no items when no tickets are blocked', async () => {
    const issues = [ticket('A-1')]; // no issuelinks
    const result = await jira.buildUnblockItems(issues, fieldIds, fakeClient({}), {}, NOW);
    assert.equal(result.length, 0);
  });

  it('emits an unblock item (today, unblock-done) when a blocker is done', async () => {
    const issues = [ticket('A-1', { issuelinks: [blockedBy('B-1')] })];
    const result = await jira.buildUnblockItems(
      issues, fieldIds, fakeClient({ 'B-1': { name: 'Done', cat: 'done' } }), {}, NOW,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'jira:acme.atlassian.net:unblock:A-1:B-1');
    assert.equal(result[0].kind, 'unblock');
    assert.equal(result[0].urgency, 'today');
    assert.equal(result[0].meta.rule.id, 'unblock-done');
    assert.equal(result[0].meta.fingerprint, 'B-1:Done');
    assert.equal(result[0].meta.fields['Blocker status'], 'Done');
  });

  it('emits an unblock item (later, unblock-advancing) when a blocker is advancing', async () => {
    const issues = [ticket('A-1', { issuelinks: [blockedBy('B-2')] })];
    const result = await jira.buildUnblockItems(
      issues, fieldIds, fakeClient({ 'B-2': { name: 'In QA', cat: 'indeterminate' } }), {}, NOW,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].urgency, 'later');
    assert.equal(result[0].meta.rule.id, 'unblock-advancing');
    assert.equal(result[0].meta.fingerprint, 'B-2:In QA');
  });

  it('emits no item when a blocker is not done or advancing', async () => {
    const issues = [ticket('A-1', { issuelinks: [blockedBy('B-3')] })];
    const result = await jira.buildUnblockItems(
      issues, fieldIds, fakeClient({ 'B-3': { name: 'In Progress', cat: 'indeterminate' } }), {}, NOW,
    );
    assert.equal(result.length, 0);
  });

  it('skips tickets that are themselves done', async () => {
    const doneTicket = ticket('A-1', {
      issuelinks: [blockedBy('B-1')],
      status: { name: 'Done', statusCategory: { key: 'done' } },
    });
    const result = await jira.buildUnblockItems(
      [doneTicket], fieldIds, fakeClient({ 'B-1': { name: 'Done', cat: 'done' } }), {}, NOW,
    );
    assert.equal(result.length, 0);
  });

  it('allows a custom advancing status list via config.advancingStatuses', async () => {
    const issues = [ticket('A-1', { issuelinks: [blockedBy('B-4')] })];
    const client = fakeClient({ 'B-4': { name: 'Review', cat: 'indeterminate' } });
    // 'Review' is not in DEFAULT_ADVANCING
    const r1 = await jira.buildUnblockItems(issues, fieldIds, client, {}, NOW);
    assert.equal(r1.length, 0);
    // but it is if passed via config
    const r2 = await jira.buildUnblockItems(issues, fieldIds, client, { advancingStatuses: ['Review'] }, NOW);
    assert.equal(r2.length, 1);
  });

  it('handles fetch errors for a blocker gracefully', async () => {
    const issues = [ticket('A-1', { issuelinks: [blockedBy('B-5')] })];
    const brokenClient = {
      site: 'https://acme.atlassian.net',
      host: 'acme.atlassian.net',
      async get() { throw new Error('network error'); },
    };
    const result = await jira.buildUnblockItems(issues, fieldIds, brokenClient, {}, NOW);
    assert.equal(result.length, 0, 'failed fetches are silently skipped');
  });

  it('emits one item per (blocker, my-ticket) pair when a blocker blocks multiple tickets', async () => {
    const issues = [
      ticket('A-1', { issuelinks: [blockedBy('B-6')] }),
      ticket('A-2', { issuelinks: [blockedBy('B-6')] }),
    ];
    const result = await jira.buildUnblockItems(
      issues, fieldIds, fakeClient({ 'B-6': { name: 'Closed', cat: 'done' } }), {}, NOW,
    );
    assert.equal(result.length, 2);
    const ids = result.map((r) => r.id).sort();
    assert.deepEqual(ids, [
      'jira:acme.atlassian.net:unblock:A-1:B-6',
      'jira:acme.atlassian.net:unblock:A-2:B-6',
    ]);
  });

  it('surfaces unblock even when blocker was already done in the JQL snapshot', async () => {
    // blockedBy(key, done=true) → inwardIssue with done statusCategory
    // The ticket A-1 has a done blocker in JQL snapshot; since the blocker is done,
    // signalOf filters it out of blockedBy[], so blockedBy.length=0.
    // A-1 must also be flagged (or have blocked status) to be "blocked" by our check.
    const issues = [ticket('A-1', {
      issuelinks: [blockedBy('B-7', true /* done in JQL snapshot */)],
      [FLAG]: [{ value: 'Impediment' }], // makes it "blocked" (flagged)
    })];
    const fieldIdsWithFlag = { sprint: null, flagged: FLAG };
    const result = await jira.buildUnblockItems(
      issues, fieldIdsWithFlag, fakeClient({ 'B-7': { name: 'Done', cat: 'done' } }), {}, NOW,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].meta.fingerprint, 'B-7:Done');
  });
});

// ---------------------------------------------------------------------------
// No-progress nudge tests

describe('buildNoProgressItems', () => {
  const fieldIds = { sprint: null, flagged: null };
  const SITE = 'https://acme.atlassian.net';
  const HOST = 'acme.atlassian.net';

  function inProgress(key, statusName = 'In Progress') {
    return ticket(key, { status: { name: statusName, statusCategory: { key: 'indeterminate' } } });
  }

  it('returns empty when gitActivity is not in ctx (graceful degradation)', () => {
    const result = jira.buildNoProgressItems([inProgress('A-1')], fieldIds, {}, {}, NOW, SITE, HOST);
    assert.equal(result.length, 0);
  });

  it('emits no-progress when no matching branch exists', () => {
    const gitActivity = new Map([['feat/something-else', NOW]]);
    const result = jira.buildNoProgressItems(
      [inProgress('A-1')], fieldIds, { gitActivity }, {}, NOW, SITE, HOST,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'jira:acme.atlassian.net:noprogress:A-1');
    assert.equal(result[0].kind, 'no-progress');
    assert.equal(result[0].urgency, 'today');
    assert.equal(result[0].meta.fields['Days since commit'], 'no branch found');
    assert.equal(result[0].meta.fingerprint, 'In Progress:null');
  });

  it('emits no-progress when matching branch commit is older than threshold', () => {
    const staleBranch = new Map([['feat/a-1-some-feature', NOW - 5 * DAY]]);
    const result = jira.buildNoProgressItems(
      [inProgress('A-1')], fieldIds, { gitActivity: staleBranch }, {}, NOW, SITE, HOST,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].meta.fields['Days since commit'], 5);
    assert.equal(result[0].meta.fingerprint, 'In Progress:5');
  });

  it('does not emit when matching branch commit is fresh (within threshold)', () => {
    const freshBranch = new Map([['feat/a-1-wip', NOW - DAY]]);
    const result = jira.buildNoProgressItems(
      [inProgress('A-1')], fieldIds, { gitActivity: freshBranch }, {}, NOW, SITE, HOST,
    );
    assert.equal(result.length, 0);
  });

  it('skips tickets in a done status', () => {
    const done = ticket('A-2', { status: { name: 'Done', statusCategory: { key: 'done' } } });
    const result = jira.buildNoProgressItems(
      [done], fieldIds, { gitActivity: new Map() }, {}, NOW, SITE, HOST,
    );
    assert.equal(result.length, 0);
  });

  it('skips tickets not in an in-progress status', () => {
    const todo = ticket('A-3', { status: { name: 'To Do', statusCategory: { key: 'new' } } });
    const result = jira.buildNoProgressItems(
      [todo], fieldIds, { gitActivity: new Map() }, {}, NOW, SITE, HOST,
    );
    assert.equal(result.length, 0);
  });

  it('respects custom inProgressStatuses and noProgressDays in config', () => {
    const issue = ticket('A-1', { status: { name: 'Coding', statusCategory: { key: 'indeterminate' } } });
    const gitActivity = new Map([['feat/a-1', NOW - 2 * DAY]]);
    // With default config, 'Coding' is not in DEFAULT_IN_PROGRESS → no item
    const r1 = jira.buildNoProgressItems([issue], fieldIds, { gitActivity }, {}, NOW, SITE, HOST);
    assert.equal(r1.length, 0, '"Coding" not in default in-progress list');
    // With custom config and threshold of 1 day
    const r2 = jira.buildNoProgressItems(
      [issue], fieldIds, { gitActivity }, { inProgressStatuses: ['Coding'], noProgressDays: 1 }, NOW, SITE, HOST,
    );
    assert.equal(r2.length, 1);
    assert.equal(r2[0].meta.fields.Threshold, '1 days');
  });

  it('uses the latest commit across multiple matching branches', () => {
    // A-1 has two matching branches; the fresher one should determine whether to emit
    const gitActivity = new Map([
      ['feat/a-1-stale', NOW - 10 * DAY],
      ['fix/a-1-quick', NOW - DAY], // fresh, within default 3-day threshold
    ]);
    const result = jira.buildNoProgressItems(
      [inProgress('A-1')], fieldIds, { gitActivity }, {}, NOW, SITE, HOST,
    );
    assert.equal(result.length, 0, 'latest branch is fresh → no nudge');
  });

  it('branch match is case-insensitive', () => {
    const gitActivity = new Map([['FEAT/A-1-work', NOW - 5 * DAY]]);
    const result = jira.buildNoProgressItems(
      [inProgress('a-1')], fieldIds, { gitActivity }, {}, NOW, SITE, HOST,
    );
    assert.equal(result.length, 1, 'case-insensitive match works');
    assert.equal(result[0].meta.fields['Days since commit'], 5);
  });
});

// ---------------------------------------------------------------------------
// buildGitActivity tests (from collector.mjs)

describe('buildGitActivity', () => {
  const T = new Date('2026-11-03T12:00:00Z').getTime();

  function gitItem(kind, branch, updatedAt) {
    return {
      kind,
      updatedAt: new Date(updatedAt).toISOString(),
      meta: { fields: { Branch: branch } },
    };
  }

  it('returns an empty map for empty input', () => {
    const m = buildGitActivity([]);
    assert.equal(m.size, 0);
  });

  it('extracts branch and timestamp from an unpushed item', () => {
    const m = buildGitActivity([gitItem('unpushed', 'feat/abc', T)]);
    assert.equal(m.get('feat/abc'), T);
  });

  it('extracts branch and timestamp from an uncommitted item', () => {
    const m = buildGitActivity([gitItem('uncommitted', 'main', T)]);
    assert.equal(m.get('main'), T);
  });

  it('ignores items of other kinds', () => {
    const m = buildGitActivity([
      gitItem('merged-branches', 'old-feat', T),
      gitItem('stale-branches', 'stale', T),
    ]);
    assert.equal(m.size, 0);
  });

  it('ignores items with detached HEAD or missing branch', () => {
    const m = buildGitActivity([
      gitItem('unpushed', 'detached HEAD', T),
      { kind: 'unpushed', updatedAt: new Date(T).toISOString(), meta: { fields: {} } },
      { kind: 'unpushed', updatedAt: new Date(T).toISOString(), meta: {} },
    ]);
    assert.equal(m.size, 0);
  });

  it('keeps the most recent timestamp when the same branch appears multiple times', () => {
    const older = T - 86_400_000;
    const newer = T;
    const m = buildGitActivity([
      gitItem('unpushed', 'feat/abc', older),
      gitItem('uncommitted', 'feat/abc', newer),
    ]);
    assert.equal(m.get('feat/abc'), newer);
  });

  it('handles multiple distinct branches', () => {
    const m = buildGitActivity([
      gitItem('unpushed', 'feat/a', T - 1000),
      gitItem('unpushed', 'feat/b', T),
    ]);
    assert.equal(m.size, 2);
    assert.equal(m.get('feat/a'), T - 1000);
    assert.equal(m.get('feat/b'), T);
  });
});
