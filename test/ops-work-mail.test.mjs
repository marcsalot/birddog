// Dynatrace, Grafana, Jenkins (self-hosted aware), GitHub Projects, Confluence, and the
// mail triage (needs you / FYI / noise) with Gmail and Outlook.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyMail, normalizeMailSettings, parsePeople } from '../src/mailsense.mjs';
import * as confluence from '../src/sources/confluence.mjs';
import * as dynatrace from '../src/sources/dynatrace.mjs';
import * as ghprojects from '../src/sources/ghprojects.mjs';
import * as gmail from '../src/sources/gmail.mjs';
import * as grafana from '../src/sources/grafana.mjs';
import * as jenkins from '../src/sources/jenkins.mjs';
import * as outlook from '../src/sources/outlook.mjs';
import { isPrivateHost, jsonClient, selfHostedUrl } from '../src/sources/web.mjs';
import { fakeFetch } from './helpers.mjs';

const NOW = Date.parse('2026-11-06T15:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const secret = async () => 'tok';

describe('self-hosted servers (Grafana, Jenkins, Dynatrace Managed)', () => {
  it('allows plain http only on your own network', () => {
    for (const h of ['localhost', '10.1.2.3', '192.168.0.9', '172.20.0.1', 'grafana', 'grafana.internal', 'ci.corp', 'box.local', '100.100.1.1']) assert.equal(isPrivateHost(h), true, h);
    for (const h of ['grafana.acme.com', '8.8.8.8', '172.40.0.1', 'example.org']) assert.equal(isPrivateHost(h), false, h);
    assert.equal(selfHostedUrl('http://grafana.internal:3000/'), 'http://grafana.internal:3000');
    assert.equal(selfHostedUrl('grafana.acme.com'), 'https://grafana.acme.com');
    assert.throws(() => selfHostedUrl('http://grafana.acme.com'), /only allowed on your own network/);
    assert.throws(() => selfHostedUrl('ftp://x.internal'), /https/);
  });

  it('explains VPN and private-CA failures', async () => {
    const down = (code) => jsonClient({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); }, label: 'grafana.internal' });
    await assert.rejects(down('ENOTFOUND').get('https://grafana.internal/x'), /are you on the VPN/);
    await assert.rejects(down('SELF_SIGNED_CERT_IN_CHAIN').get('https://grafana.internal/x'), /NODE_EXTRA_CA_CERTS/);
  });
});

describe('Dynatrace', () => {
  it('lists open problems in the zone, errors and outages first', async () => {
    const fetch = fakeFetch((u, init) => {
      assert.equal(init.headers.authorization, 'Api-Token tok');
      assert.equal(u.searchParams.get('problemSelector'), 'status("OPEN"),managementZones("Pay ~"ments~"")');
      return { body: { totalCount: 2, problems: [
        { problemId: 'p1', displayId: 'P-1', title: 'Failure rate increase', status: 'OPEN', severityLevel: 'ERROR', startTime: NOW - 10 * MIN, affectedEntities: [{ name: 'api' }] },
        { problemId: 'p2', displayId: 'P-2', title: 'Slow', status: 'OPEN', severityLevel: 'PERFORMANCE', startTime: NOW - 5 * DAY, affectedEntities: [] },
      ] } };
    });
    const config = dynatrace.normalizeSettings({ url: 'https://abc.live.dynatrace.com/api/v2', zone: 'Pay "ments"' });
    assert.equal(config.url, 'https://abc.live.dynatrace.com');
    const items = await dynatrace.collect(config, { fetch, now: NOW, secret });
    assert.deepEqual(items.map((i) => [i.title, i.urgency]), [['P-1 · Failure rate increase', 'now'], ['P-2 · Slow', 'later']]);
    assert.equal(items[0].url, 'https://abc.live.dynatrace.com/#problems/problemdetails;pid=p1');
    assert.match(items[0].why, /\*\*Firing\*\* 10 minutes · \*\*error\*\* · api/);
  });
});

describe('Grafana', () => {
  it('reads firing alerts with a label filter, critical as Now', async () => {
    const fetch = fakeFetch((u, init) => {
      assert.equal(init.headers.authorization, 'Bearer tok');
      assert.equal(u.pathname, '/api/alertmanager/grafana/api/v2/alerts');
      assert.deepEqual(u.searchParams.getAll('filter'), ['team="payments"', 'env!="dev"']);
      assert.equal(u.searchParams.get('silenced'), 'false');
      return { body: [
        { fingerprint: 'f1', labels: { alertname: 'APIDown', severity: 'critical', service: 'api' }, annotations: { summary: 'API is down' }, startsAt: new Date(NOW - 5 * MIN).toISOString(), status: { state: 'active' }, generatorURL: 'http://grafana.internal:3000/alerting/x/view' },
        { fingerprint: 'f2', labels: { alertname: 'Old', severity: 'warning' }, annotations: {}, startsAt: new Date(NOW - 4 * DAY).toISOString(), status: { state: 'suppressed' } },
      ] };
    });
    const config = grafana.normalizeSettings({ url: 'http://grafana.internal:3000', filter: 'team=payments, env!=dev' });
    const items = await grafana.collect(config, { fetch, now: NOW, secret });
    assert.deepEqual(items.map((i) => [i.title, i.urgency, i.url]), [['APIDown · API is down', 'now', 'http://grafana.internal:3000/alerting/x/view']]);
    assert.throws(() => grafana.normalizeSettings({ url: 'https://g.example', filter: 'not a filter' }), /isn't a label filter/);
  });
});

describe('Jenkins', () => {
  const tree = { jobs: [
    { name: 'api', fullName: 'team/api', _class: 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject', jobs: [
      { name: 'main', fullName: 'team/api/main', url: 'https://ci.internal/job/team/job/api/job/main/', color: 'blue', lastCompletedBuild: { number: 9, result: 'SUCCESS', timestamp: NOW - HOUR } },
      { name: 'feature%2Fx', fullName: 'team/api/feature%2Fx', url: 'https://ci.internal/job/team/job/api/job/feature%252Fx/', color: 'red', lastCompletedBuild: { number: 4, result: 'FAILURE', timestamp: NOW - HOUR, url: 'https://ci.internal/job/team/job/api/job/feature%252Fx/4/', culprits: [{ id: 'sam', fullName: 'Sam' }] } },
    ] },
    { name: 'e2e', fullName: 'e2e', url: 'https://ci.internal/job/e2e/', color: 'yellow', lastCompletedBuild: { number: 30, result: 'UNSTABLE', timestamp: NOW - 3 * DAY, url: 'https://ci.internal/job/e2e/30/', culprits: [], actions: [{ causes: [{ userId: 'other' }] }] } },
    { name: 'old', fullName: 'old', url: 'https://ci.internal/job/old/', color: 'disabled', lastCompletedBuild: { number: 1, result: 'FAILURE', timestamp: NOW - 9 * DAY } },
  ] };
  const fetch = () => fakeFetch((u, init) => {
    assert.equal(init.headers.authorization, `Basic ${Buffer.from('sam:tok').toString('base64')}`);
    assert.equal(u.searchParams.get('tree'), jenkins.TREE);
    return { body: tree };
  });

  it('lists failing and unstable jobs, one per multibranch branch, skipping disabled ones', async () => {
    const config = jenkins.normalizeSettings({ url: 'http://ci.internal/view/team/api/json', username: 'sam' });
    assert.equal(config.url, 'http://ci.internal/view/team');
    const items = await jenkins.collect(config, { fetch: fetch(), now: NOW, secret });
    assert.deepEqual(items.map((i) => [i.title, i.urgency]), [['team/api · feature/x · build #4 failed', 'today'], ['e2e · build #30 unstable', 'later']]);
    assert.match(items[1].why, /still unstable on \*\*#30\*\*/);
  });

  it('"only mine" keeps builds you broke or started', async () => {
    const items = await jenkins.collect(jenkins.normalizeSettings({ url: 'https://ci.internal', username: 'sam', onlyMine: 'yes' }), { fetch: fetch(), now: NOW, secret });
    assert.deepEqual(items.map((i) => i.meta.fields.Job), ['team/api/feature%2Fx']);
    assert.equal(jenkins.involves({ actions: [{ causes: [{ userId: 'SAM' }] }] }, 'sam'), true);
  });
});

describe('GitHub Projects', () => {
  it('checks board links', () => {
    assert.deepEqual(ghprojects.parseProject('https://github.com/orgs/acme/projects/5/views/2'), { host: 'github.com', kind: 'orgs', owner: 'acme', number: 5, url: 'https://github.com/orgs/acme/projects/5' });
    assert.equal(ghprojects.normalizeSettings({ projects: 'https://github.com/users/sam/projects/2, https://github.com/orgs/acme/projects/5' }).projects, 'https://github.com/users/sam/projects/2\nhttps://github.com/orgs/acme/projects/5');
    assert.throws(() => ghprojects.normalizeSettings({ projects: 'https://github.com/acme/repo' }), /isn't a project board/);
  });

  it('lists open items assigned to you that aren\'t done, ranked like tickets', async () => {
    const node = (id, status, extra = {}, content = {}) => ({ id, isArchived: false, updatedAt: new Date(NOW - DAY).toISOString(), fieldValues: { nodes: [{ name: status, field: { name: 'Status' } }, ...(extra.values ?? [])] }, content: { __typename: 'Issue', title: id, url: `https://github.com/acme/r/issues/${id.length}`, number: 1, state: 'OPEN', assignees: { nodes: [{ login: 'Sam' }] }, repository: { nameWithOwner: 'acme/r' }, ...content } });
    const fetch = fakeFetch((u, init) => {
      assert.equal(u.href, 'https://api.github.com/graphql');
      assert.equal(JSON.parse(init.body).variables.login, 'acme');
      return { body: { data: { viewer: { login: 'sam' }, owner: { projectV2: { title: 'Roadmap', url: 'https://github.com/orgs/acme/projects/5', items: { pageInfo: { hasNextPage: false }, nodes: [
        node('due-soon', 'Todo', { values: [{ date: new Date(NOW + DAY).toISOString().slice(0, 10), field: { name: 'Due date' } }] }),
        node('done', 'Done'),
        node('someone-elses', 'Todo', {}, { assignees: { nodes: [{ login: 'kai' }] } }),
        node('closed', 'Todo', {}, { state: 'CLOSED' }),
        node('blocked', 'Blocked'),
      ] } } } } } };
    });
    const items = await ghprojects.collect({ projects: 'https://github.com/orgs/acme/projects/5' }, { fetch, now: NOW, github: { token: async () => 'tok' } });
    assert.deepEqual(items.map((i) => i.title).sort(), ['r#1 · blocked', 'r#1 · due-soon']);
    assert.equal(items.find((i) => /due-soon/.test(i.title)).meta.fields.Project, 'Roadmap');
  });

  it('says how to add the read:project scope', async () => {
    const fetch = fakeFetch(() => ({ body: { errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'Your token has not been granted the required scopes: read:project' }] } }));
    await assert.rejects(ghprojects.collect({ projects: 'https://github.com/orgs/acme/projects/5' }, { fetch, now: NOW, github: { token: async () => 'tok' } }), /gh auth refresh -s read:project/);
  });
});

describe('Confluence', () => {
  it('lists mentions (not your own edits) and tasks assigned to you', async () => {
    const fetch = fakeFetch((u) => {
      if (u.pathname === '/wiki/rest/api/user/current') return { body: { accountId: 'me', displayName: 'Sam' } };
      if (u.pathname === '/wiki/rest/api/search') {
        assert.match(u.searchParams.get('cql'), /^mention = currentUser\(\) AND lastmodified >= now\("-7d"\)/);
        return { body: { results: [
          { content: { id: '1', type: 'page', title: 'Design', _links: { webui: '/spaces/X/pages/1' }, version: { number: 3, by: { displayName: 'Priya', accountId: 'p' } } }, excerpt: '<b>@Sam</b> thoughts?', lastModified: new Date(NOW - HOUR).toISOString() },
          { content: { id: '2', type: 'page', title: 'Mine', version: { by: { accountId: 'me' } } }, lastModified: new Date(NOW - HOUR).toISOString() },
        ] } };
      }
      if (u.pathname === '/wiki/api/v2/tasks') { assert.equal(u.searchParams.get('assigned-to'), 'me'); return { body: { results: [{ id: '9', pageId: '1', dueAt: new Date(NOW - DAY).toISOString(), body: { storage: { value: '<p>Fix &amp; ship</p>' } } }] } }; }
      if (u.pathname === '/wiki/api/v2/pages/1') return { body: { title: 'Design' } };
      return undefined;
    });
    const items = await confluence.collect(confluence.normalizeSettings({ site: 'acme.atlassian.net/wiki', email: 'sam@acme.example' }), { fetch, now: NOW, secret });
    assert.deepEqual(items.map((i) => [i.kind, i.title, i.urgency]), [['mention', 'Design · @Sam thoughts?', 'today'], ['task', 'Fix & ship', 'today']]);
    assert.equal(items[0].url, 'https://acme.atlassian.net/wiki/spaces/X/pages/1');
    assert.match(items[1].why, /Overdue/);
  });
});

describe('mail triage', () => {
  const me = ['sam@acme.example'];
  const c = (headers, extra = {}) => classifyMail({ headers: { from: 'Dana <dana@acme.example>', to: 'sam@acme.example', subject: 'Lunch?', ...headers }, me, ...extra });

  it('a person writing to you needs you; CC is FYI; a list or BCC is FYI', () => {
    assert.deepEqual(c({}), { verdict: 'needs-you', reason: 'sent to you directly' });
    assert.equal(c({ to: 'team@acme.example', cc: 'sam@acme.example' }).reason, 'you\'re on CC');
    assert.equal(c({ to: 'all@acme.example' }).verdict, 'fyi');
  });

  it('newsletters, robots and notifications from tools Birddog already shows are noise', () => {
    assert.match(c({ 'list-unsubscribe': '<https://x/unsub>' }).reason, /newsletter/);
    assert.equal(c({ precedence: 'bulk' }).verdict, 'noise');
    assert.equal(c({ 'auto-submitted': 'auto-generated' }).verdict, 'noise');
    assert.equal(c({ from: 'no-reply@shop.example' }).verdict, 'noise');
    assert.match(c({ from: 'GitHub <notifications@github.com>', 'list-id': 'x' }).reason, /Birddog can show that source directly/);
    assert.equal(c({ from: 'no-reply@bank.example', subject: 'Action required: verify your payment' }).verdict, 'needs-you', 'a robot saying "action required" still gets through');
  });

  it('VIPs, muted senders, your provider\'s signals, and people you reply to', () => {
    assert.equal(c({ 'list-unsubscribe': 'x', from: 'ceo@acme.example' }, { settings: { vip: 'ceo@acme.example' } }).verdict, 'needs-you');
    assert.equal(c({ from: 'pat@vendor.example' }, { settings: { mute: '@vendor.example' } }).verdict, 'noise');
    assert.equal(c({}, { provider: { category: 'promotions' } }).verdict, 'noise');
    assert.equal(c({ to: 'all@acme.example' }, { provider: { important: true, importantBy: 'Gmail marked it important' } }).reason, 'Gmail marked it important');
    assert.equal(c({ to: 'all@acme.example' }, { known: new Set(['dana@acme.example']) }).reason, 'from someone you\'ve replied to before');
    assert.equal(c({ to: 'all@acme.example' }, { provider: { focused: false } }).reason, 'in Other, not Focused');
    assert.equal(c({ subject: 'URGENT: prod creds rotate' }).reason, 'it says "urgent"');
    assert.equal(c({ from: 'sam@acme.example' }).verdict, 'noise');
    assert.deepEqual(parsePeople('A@x.com; @Corp.example, nope'), ['a@x.com', '@corp.example']);
    assert.deepEqual(normalizeMailSettings({ vip: 'a@x.com', showNoise: 'yes' }), { vip: 'a@x.com', mute: '', showNoise: true });
  });

  it('Gmail: headers only, Gmail\'s own signals, noise counted not listed', async () => {
    const msg = (id, labels, headers, ago = HOUR) => ({ id, threadId: `t${id}`, labelIds: labels, internalDate: String(NOW - ago), payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } });
    const all = {
      a: msg('a', ['INBOX', 'UNREAD', 'IMPORTANT'], { From: 'Boss <boss@x.example>', To: 'list@x.example', Subject: 'Plan' }),
      b: msg('b', ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'], { From: 'Shop <deals@shop.example>', To: 'sam@gmail.example', Subject: 'Sale' }),
      c: msg('c', ['STARRED'], { From: 'Kai <kai@x.example>', To: 'sam@gmail.example', Subject: 'Old thing' }, 9 * DAY),
    };
    const fetch = fakeFetch((u) => {
      if (u.pathname.endsWith('/profile')) return { body: { emailAddress: 'sam@gmail.example' } };
      if (u.pathname.endsWith('/messages')) {
        assert.equal(u.searchParams.has('q'), false, 'the metadata scope can\'t search');
        return { body: { messages: u.searchParams.getAll('labelIds').includes('STARRED') ? [{ id: 'c' }] : [{ id: 'a' }, { id: 'b' }] } };
      }
      const id = u.pathname.split('/').pop();
      assert.equal(u.searchParams.get('format'), 'metadata');
      return { body: all[id] };
    });
    let summary = '';
    const items = await gmail.collect({}, { fetch, now: NOW, oauth: { accessToken: async () => 'tok' }, summary: (s) => { summary = s; } });
    assert.deepEqual(items.map((i) => [i.title, i.meta.rule.id]), [['Plan', 'email-unread-fresh'], ['Old thing', 'email-starred']]);
    assert.match(items[0].why, /Gmail marked it important/);
    assert.match(items[0].url, /^https:\/\/mail\.google\.com\/mail\/\?authuser=sam%40gmail\.example#all\/ta$/);
    assert.match(summary, /1 noise skipped/);
  });

  it('Outlook: Focused / Other and unsubscribe links, Mail.ReadBasic fields only', async () => {
    const m = (id, extra) => ({ id, subject: id, from: { emailAddress: { name: 'Lena', address: 'lena@acme.example' } }, toRecipients: [{ emailAddress: { address: 'sam@acme.example' } }], ccRecipients: [], receivedDateTime: new Date(NOW - HOUR).toISOString(), isRead: false, flag: { flagStatus: 'notFlagged' }, inferenceClassification: 'focused', webLink: `https://outlook.office.com/mail/id/${id}`, ...extra });
    const fetch = fakeFetch((u) => {
      if (u.pathname === '/v1.0/me') return { body: { mail: 'sam@acme.example' } };
      assert.doesNotMatch(u.searchParams.get('$select'), /body/);
      return { body: { value: /flagStatus/.test(u.searchParams.get('$filter')) ? [] : [m('direct', {}), m('digest', { unsubscribeEnabled: true, importance: 'high', inferenceClassification: 'other' })] } };
    });
    const items = await outlook.collect({}, { fetch, now: NOW, oauth: { accessToken: async () => 'tok' } });
    assert.deepEqual(items.map((i) => i.title), ['direct']);
    assert.equal(items[0].url, 'https://outlook.office.com/mail/id/direct');
  });
});
