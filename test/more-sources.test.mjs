// GitLab, Linear, Azure DevOps, Sentry, PagerDuty, Slack, and GitHub Actions/Dependabot,
// all against fake APIs (no network).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as azure from '../src/sources/azure.mjs';
import * as github from '../src/sources/github.mjs';
import * as gitlab from '../src/sources/gitlab.mjs';
import * as linear from '../src/sources/linear.mjs';
import * as pagerduty from '../src/sources/pagerduty.mjs';
import * as sentry from '../src/sources/sentry.mjs';
import * as slack from '../src/sources/slack.mjs';
import { fakeFetch } from './helpers.mjs';

const NOW = Date.parse('2026-11-04T16:00:00Z');
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();
const ctxFor = (f, token) => ({ now: NOW, fetch: f, secret: async () => token, warn() {}, summary() {} });
const byKind = (items) => Object.groupBy ? Object.groupBy(items, (i) => i.kind) : items.reduce((a, i) => ((a[i.kind] ??= []).push(i), a), {});

describe('GitLab', () => {
  const f = fakeFetch((u, init) => {
    assert.equal(init.headers['private-token'], 'glpat-x');
    assert.equal(init.method, 'GET');
    const p = u.pathname;
    if (p === '/api/v4/user') return { body: { username: 'sam' } };
    if (p === '/api/v4/merge_requests' && u.searchParams.get('reviewer_username') === 'sam') return { body: [{ iid: 7, project_id: 1, title: 'Faster builds', web_url: 'https://gitlab.example.com/g/p/-/merge_requests/7', author: { username: 'ana' }, created_at: ago(30), updated_at: ago(2), references: { full: 'g/p!7' } }] };
    if (p === '/api/v4/merge_requests' && u.searchParams.get('scope') === 'created_by_me') return { body: [{ iid: 9, project_id: 1, references: { full: 'g/p!9' } }, { iid: 10, project_id: 1 }] };
    if (p === '/api/v4/projects/1/merge_requests/9') return { body: { iid: 9, project_id: 1, title: 'Mine', web_url: 'https://gitlab.example.com/g/p/-/merge_requests/9', head_pipeline: { status: 'failed' }, has_conflicts: false, target_branch: 'main', source_branch: 'feat', updated_at: ago(1), references: { full: 'g/p!9' } } };
    if (p === '/api/v4/projects/1/merge_requests/10') return { body: { iid: 10, project_id: 1, title: 'Fine', head_pipeline: { status: 'success' }, has_conflicts: false, updated_at: ago(1) } };
    if (p === '/api/v4/issues') return { body: [{ iid: 3, project_id: 1, title: 'Bug', web_url: 'https://gitlab.example.com/g/p/-/issues/3', labels: ['P1'], due_date: null, updated_at: ago(5), references: { full: 'g/p#3' } }] };
    return undefined;
  });
  it('finds reviews, failed pipelines and issues on a self-managed instance', async () => {
    const items = await gitlab.collect({ url: 'https://gitlab.example.com' }, ctxFor(f, 'glpat-x'));
    const k = byKind(items);
    assert.equal(k['review-request'][0].why, '**@ana** requested your review **1 day** ago · they are waiting on you');
    assert.equal(k['my-pr'].length, 1, 'the green MR is left out');
    assert.match(k['my-pr'][0].why, /\*\*1 check failing\*\*: pipeline failed/);
    assert.equal(k.issue[0].why, 'Labeled **P1** · assigned to you');
    assert.ok(f.calls.every((c) => c.url.host === 'gitlab.example.com'));
  });
  it('validates the address and explains a bad token', async () => {
    assert.throws(() => gitlab.normalizeSettings({ url: 'http://gitlab.example.com' }), /https/);
    assert.deepEqual(gitlab.normalizeSettings({}), { url: 'https://gitlab.com', auth: 'token' });
    const r = await gitlab.test({}, ctxFor(fakeFetch(() => ({ status: 401, body: { message: '401 Unauthorized' } })), 'bad'));
    assert.match(r.message, /rejected the token.*read_api/);
    assert.match((await gitlab.test({}, ctxFor(f, null))).message, /personal access token/);
  });
  it('uses the GitLab sign-in when connected that way', async () => {
    const g = fakeFetch((u, init) => (init.headers.authorization === 'Bearer gl-oauth' ? { body: { username: 'sam' } } : { status: 401 }));
    const r = await gitlab.test({ auth: 'oauth' }, { ...ctxFor(g, null), oauth: { accessToken: async () => 'gl-oauth' } });
    assert.equal(r.message, 'Connected to gitlab.com as @sam');
  });
});

describe('Linear', () => {
  it('ranks assigned issues like tickets, via read-only GraphQL', async () => {
    const f = fakeFetch((u, init) => {
      assert.equal(init.headers.authorization, 'lin_api_x');
      const q = JSON.parse(init.body).query;
      assert.doesNotMatch(q, /mutation/);
      if (/assignedIssues/.test(q)) {
        return { body: { data: { viewer: { name: 'Sam', assignedIssues: { nodes: [
          { identifier: 'ENG-1', title: 'Ship it', url: 'https://linear.app/acme/issue/ENG-1', priorityLabel: 'Urgent', dueDate: '2026-11-03', updatedAt: ago(3), state: { name: 'In Progress', type: 'started' }, cycle: null, inverseRelations: { nodes: [] } },
          { identifier: 'ENG-2', title: 'Wait', url: 'https://linear.app/acme/issue/ENG-2', priorityLabel: 'Low', updatedAt: ago(3), state: { name: 'Todo', type: 'unstarted' }, cycle: { number: 12, endsAt: new Date(NOW + 2 * 86_400_000).toISOString() }, inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'ENG-9', state: { type: 'started' } } }] } },
          { identifier: 'ENG-3', title: 'Later', url: 'https://linear.app/acme/issue/ENG-3', priorityLabel: 'No priority', updatedAt: ago(100), state: { name: 'Backlog', type: 'backlog' }, cycle: null },
        ] } } } } };
      }
      return { body: { data: { viewer: { name: 'Sam' } } } };
    });
    const items = await linear.collect({}, ctxFor(f, 'lin_api_x'));
    const by = Object.fromEntries(items.map((i) => [i.meta.fields.Issue, i]));
    assert.equal(by['ENG-1'].meta.rule.id, 'jira-overdue');
    assert.equal(by['ENG-2'].why, '**Blocked** by ENG-9 · chase it or pick up something else');
    assert.equal(by['ENG-3'].urgency, 'later');
    assert.equal((await linear.test({}, ctxFor(f, 'lin_api_x'))).message, 'Connected to Linear as Sam');
  });
  it('retries without blockers if the relations field is refused', async () => {
    let n = 0;
    const f = fakeFetch((u, init) => (++n === 1 ? { body: { errors: [{ message: 'Cannot query field "inverseRelations"' }] } } : { body: { data: { viewer: { assignedIssues: { nodes: [] } } } } }));
    const warns = [];
    assert.deepEqual(await linear.collect({}, { ...ctxFor(f, 'k'), warn: (w) => warns.push(w) }), []);
    assert.match(warns[0], /blockers are skipped/);
  });
});

describe('Azure DevOps', () => {
  it('finds PRs you have not voted on, and work items via WIQL', async () => {
    const f = fakeFetch((u, init) => {
      assert.equal(init.headers.authorization, `Basic ${Buffer.from(':pat').toString('base64')}`);
      const p = u.pathname;
      if (p === '/contoso/_apis/connectionData') return { body: { authenticatedUser: { id: 'me-1', providerDisplayName: 'Sam' } } };
      if (p === '/contoso/Payments/_apis/git/pullrequests') {
        assert.equal(u.searchParams.get('searchCriteria.reviewerId'), 'me-1');
        return { body: { value: [
          { pullRequestId: 5, title: 'Add retries', createdBy: { displayName: 'Ana', uniqueName: 'ana@contoso.com' }, creationDate: ago(40), repository: { name: 'api', webUrl: 'https://dev.azure.com/contoso/Payments/_git/api' }, reviewers: [{ id: 'me-1', vote: 0 }] },
          { pullRequestId: 6, title: 'Voted', creationDate: ago(40), repository: { name: 'api' }, reviewers: [{ id: 'me-1', vote: 10 }] },
        ] } };
      }
      if (p === '/contoso/Payments/_apis/wit/wiql') {
        assert.equal(init.method, 'POST');
        assert.match(JSON.parse(init.body).query, /\[System\.AssignedTo\] = @Me/);
        return { body: { workItems: [{ id: 42 }] } };
      }
      if (p === '/contoso/Payments/_apis/wit/workitems') return { body: { value: [{ id: 42, fields: { 'System.Title': 'Fix login', 'System.State': 'Active', 'System.WorkItemType': 'Bug', 'System.ChangedDate': ago(2), 'Microsoft.VSTS.Common.Priority': 1, 'System.Tags': 'Blocked; ui' } }] } };
      return undefined;
    });
    const items = await azure.collect({ organization: 'contoso', project: 'Payments' }, ctxFor(f, 'pat'));
    const k = byKind(items);
    assert.equal(k['review-request'].length, 1);
    assert.equal(k['review-request'][0].url, 'https://dev.azure.com/contoso/Payments/_git/api/pullrequest/5');
    assert.equal(k.ticket[0].why, '**Flagged** as an impediment · find out what it needs');
    assert.equal(k.ticket[0].url, 'https://dev.azure.com/contoso/Payments/_workitems/edit/42');
    assert.ok(f.calls.filter((c) => c.method === 'POST').every((c) => c.url.pathname.endsWith('/wiql')), 'the only POST is the WIQL query');
  });
  it('accepts an org URL and needs a project', () => {
    assert.deepEqual(azure.normalizeSettings({ organization: 'https://dev.azure.com/Contoso/', project: 'Payments' }), { organization: 'contoso', project: 'Payments' });
    assert.throws(() => azure.normalizeSettings({ organization: 'contoso' }), /project/);
  });
});

describe('Sentry', () => {
  it('lists unresolved issues assigned to you, regressed and new first', async () => {
    const f = fakeFetch((u, init) => {
      assert.equal(init.headers.authorization, 'Bearer sntryu_x');
      assert.equal(u.searchParams.get('query'), 'is:unresolved assigned:me');
      return { body: [
        { id: '1', shortId: 'API-1', title: 'TypeError', permalink: 'https://acme.sentry.io/issues/1/', count: '120', userCount: 14, firstSeen: ago(200), lastSeen: ago(1), substatus: 'regressed', project: { slug: 'api' } },
        { id: '2', shortId: 'API-2', title: 'Timeout', permalink: 'https://acme.sentry.io/issues/2/', count: '3', userCount: 0, firstSeen: ago(300), lastSeen: ago(50), substatus: 'ongoing' },
      ] };
    });
    const items = await sentry.collect({ organization: 'acme' }, ctxFor(f, 'sntryu_x'));
    assert.equal(items[0].why, '**Regressed** · 120 events, 14 users · last seen 1 hour ago');
    assert.equal(items[1].urgency, 'later');
    assert.throws(() => sentry.normalizeSettings({ organization: 'Bad Org!' }), /slug/);
  });
});

describe('PagerDuty', () => {
  it('pages first; on call now is today', async () => {
    const f = fakeFetch((u, init) => {
      assert.equal(init.headers.authorization, 'Token token=pd-x');
      if (u.pathname === '/users/me') return { body: { user: { id: 'U1', name: 'Sam' } } };
      if (u.pathname === '/incidents') {
        assert.deepEqual(u.searchParams.getAll('statuses[]'), ['triggered', 'acknowledged']);
        return { body: { incidents: [{ id: 'P1', incident_number: 77, title: 'API 5xx', status: 'triggered', urgency: 'high', created_at: ago(0.2), html_url: 'https://acme.pagerduty.com/incidents/P1', service: { summary: 'API' } }] } };
      }
      if (u.pathname === '/oncalls') return { body: { oncalls: [{ start: ago(5), end: new Date(NOW + 20 * 3600_000).toISOString(), escalation_policy: { id: 'E1', summary: 'Payments' }, schedule: { id: 'S1', summary: 'Primary' }, escalation_level: 1 }] } };
      return undefined;
    });
    const items = await pagerduty.collect({}, ctxFor(f, 'pd-x'));
    const k = byKind(items);
    assert.equal(k.incident[0].urgency, 'now');
    assert.match(k.incident[0].why, /^\*\*Triggered\*\* 12 minutes ago · \*\*high urgency\*\* · API/);
    assert.equal(k['on-call'][0].urgency, 'today');
    assert.match(k['on-call'][0].why, /You're \*\*on call\*\* for Payments until/);
  });
});

describe('Slack', () => {
  const f = fakeFetch((u, init) => {
    assert.equal(init.headers.authorization, 'Bearer xoxp-1');
    const m = u.pathname.replace('/api/', '');
    if (m === 'auth.test') return { body: { ok: true, user_id: 'UME', user: 'sam', team: 'Acme' } };
    if (m === 'search.messages') return { body: { ok: true, messages: { matches: [
      { ts: String((NOW - 2 * 3600_000) / 1000), user: 'UANA', username: 'ana', text: 'hey <@UME> can you look?', permalink: 'https://acme.slack.com/archives/C1/p1', channel: { id: 'C1', name: 'payments' } },
      { ts: String((NOW - 3600_000) / 1000), user: 'UME', text: 'me <@UME>', channel: { id: 'C1' } },
    ] } } };
    if (m === 'conversations.list') return { body: { ok: true, channels: [{ id: 'D1', user: 'UBEN' }, { id: 'D2', user: 'UCY' }] } };
    if (m === 'conversations.history') return { body: { ok: true, messages: [u.searchParams.get('channel') === 'D1' ? { user: 'UBEN', ts: String((NOW - 5 * 3600_000) / 1000), text: 'quick question' } : { user: 'UME', ts: String(NOW / 1000), text: 'replied' }] } };
    if (m === 'users.info') return { body: { ok: true, user: { profile: { display_name: 'ben' } } } };
    if (m === 'chat.getPermalink') return { body: { ok: true, permalink: 'https://acme.slack.com/archives/D1/p5' } };
    return { body: { ok: false, error: 'unknown_method' } };
  });
  it('mentions and DMs waiting on you, read-only', async () => {
    const items = await slack.collect({}, ctxFor(f, 'xoxp-1'));
    const k = byKind(items);
    assert.equal(k.mention.length, 1, 'your own messages are not mentions');
    assert.equal(k.mention[0].why, '**@ana** mentioned you **2 hours** ago');
    assert.equal(k.dm.length, 1, 'a DM you answered last is not waiting');
    assert.equal(k.dm[0].why, '**@ben** messaged you **5 hours** ago · waiting for your reply');
    assert.ok(f.calls.every((c) => c.method === 'GET'));
    assert.ok(!f.calls.some((c) => /chat\.post|reactions|mark/.test(c.url.pathname)));
  });
  it('wants a user token and explains missing scopes', async () => {
    assert.match((await slack.test({}, ctxFor(f, 'xoxb-bot'))).message, /user token/);
    const scopes = fakeFetch(() => ({ body: { ok: false, error: 'missing_scope', needed: 'search:read' } }));
    assert.match((await slack.test({}, ctxFor(scopes, 'xoxp-1'))).message, /missing the search:read scope/);
  });
});

describe('GitHub Actions and Dependabot', () => {
  it('latest run per workflow and branch; only failures count', () => {
    const runs = [
      { workflow_id: 1, name: 'CI', head_branch: 'feat', status: 'completed', conclusion: 'failure', created_at: ago(3), updated_at: ago(3) },
      { workflow_id: 1, name: 'CI', head_branch: 'feat', status: 'completed', conclusion: 'success', created_at: ago(1), updated_at: ago(1) },
      { workflow_id: 1, name: 'CI', head_branch: 'fix', status: 'completed', conclusion: 'failure', created_at: ago(2), updated_at: ago(2) },
      { workflow_id: 2, name: 'Lint', head_branch: 'fix', status: 'in_progress', conclusion: null, created_at: ago(0.1) },
    ];
    assert.deepEqual(github.failingRuns(runs, NOW).map((r) => r.head_branch), ['fix']);
  });
  it('turn into items alongside the usual GitHub ones', async () => {
    const f = fakeFetch((u) => {
      const p = u.pathname;
      if (p === '/user') return { body: { login: 'sam' } };
      if (p === '/search/issues') return { body: { total_count: 0, items: [] } };
      if (p === '/notifications') return { body: [] };
      if (p === '/user/repos') return { body: [{ full_name: 'acme/api', pushed_at: ago(5) }, { full_name: 'acme/old', pushed_at: ago(24 * 30) }] };
      if (p === '/repos/acme/api/actions/runs') { assert.equal(u.searchParams.get('actor'), 'sam'); return { body: { workflow_runs: [{ id: 99, workflow_id: 1, name: 'CI', head_branch: 'feat/x', status: 'completed', conclusion: 'failure', created_at: ago(2), updated_at: ago(2), html_url: 'https://github.com/acme/api/actions/runs/99' }] } }; }
      if (p === '/repos/acme/api/dependabot/alerts') return { body: [{ number: 4, html_url: 'https://github.com/acme/api/security/dependabot/4', state: 'open', security_advisory: { severity: 'critical', summary: 'Prototype pollution in lodash', ghsa_id: 'GHSA-x' }, security_vulnerability: { package: { name: 'lodash' }, first_patched_version: { identifier: '4.17.21' } }, created_at: ago(30) }] };
      return undefined;
    });
    const items = await github.collect({}, { now: NOW, fetch: f, github: { token: async () => 't' }, warn() {}, summary() {} });
    const k = byKind(items);
    assert.equal(k['ci-failure'][0].why, '**CI** failed on **feat/x** 2 hours ago · it\'s your latest run there');
    assert.equal(k['ci-failure'][0].meta.command, 'gh run view 99 -R acme/api --log-failed');
    assert.equal(k['security-alert'][0].why, '**Critical** vulnerability in **lodash** · a fix is available');
    assert.ok(!f.calls.some((c) => c.url.pathname.includes('acme/old')), 'only repos pushed to this week');
    const off = await github.collect({ actions: false, security: false }, { now: NOW, fetch: f, github: { token: async () => 't' }, warn() {} });
    assert.equal(off.length, 0);
  });
});
