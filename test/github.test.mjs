import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as github from '../src/sources/github.mjs';
import { DAY, fakeFetch } from './helpers.mjs';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const API = 'https://api.github.com';

const pr = (repo, number, title, extra = {}) => ({
  number, title, html_url: `https://github.com/${repo}/pull/${number}`, repository_url: `${API}/repos/${repo}`,
  user: { login: 'ana' }, created_at: iso(5), updated_at: iso(1), comments: 2, draft: false, pull_request: {}, ...extra,
});
const issue = (repo, number, title, extra = {}) => ({
  number, title, html_url: `https://github.com/${repo}/issues/${number}`, repository_url: `${API}/repos/${repo}`,
  user: { login: 'ana' }, created_at: iso(20), updated_at: iso(4), labels: [], milestone: null, comments: 0, ...extra,
});

/** A small fake GitHub with one of everything. */
function fakeGithub(over = {}) {
  const searches = {
    'review-requested:@me': [pr('acme/api', 12, 'Add retries'), pr('acme/web', 5, 'New header'), pr('acme/web', 6, 'WIP: dark mode', { draft: true })],
    'author:@me': [pr('acme/api', 20, 'Cache tokens', { user: { login: 'octocat' } }), pr('acme/api', 21, 'All green'), pr('acme/api', 22, 'Draft thing')],
    'assignee:@me': [
      issue('acme/api', 40, 'Fix login', { milestone: { title: 'v2.1', due_on: iso(1) } }),
      issue('acme/api', 41, 'Outage follow-up', { labels: [{ name: 'P1' }, { name: 'bug' }] }),
      issue('acme/api', 42, 'Docs typo'),
    ],
  };
  const routes = {
    '/user': { body: { login: 'octocat' } },
    '/repos/acme/api/issues/12/events': { body: [
      { id: 1, event: 'labeled', created_at: iso(3) },
      { id: 2, event: 'review_requested', actor: { login: 'ana' }, review_requester: { login: 'ana' }, requested_reviewer: { login: 'octocat' }, created_at: iso(2) },
    ] },
    '/repos/acme/web/issues/5/events': { body: [
      { id: 7, event: 'review_requested', actor: { login: 'bo' }, review_requester: { login: 'bo' }, requested_team: { slug: 'frontend' }, created_at: iso(0.1) },
    ] },
    '/repos/acme/web/issues/6/events': { body: [
      { id: 8, event: 'review_requested', review_requester: { login: 'cy' }, requested_reviewer: { login: 'octocat' }, created_at: iso(4) },
    ] },
    '/repos/acme/api/pulls/20': { body: { head: { sha: 's20', ref: 'cache' }, base: { ref: 'main' }, mergeable_state: 'blocked', draft: false, updated_at: iso(1) } },
    '/repos/acme/api/commits/s20/check-runs': { body: { check_runs: [
      { name: 'test', status: 'completed', conclusion: 'failure' },
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'e2e', status: 'in_progress', conclusion: null },
    ] } },
    '/repos/acme/api/commits/s20/status': { body: { statuses: [{ context: 'ci/legacy', state: 'error' }] } },
    '/repos/acme/api/pulls/20/reviews': { body: [
      { id: 1, user: { login: 'ben' }, state: 'CHANGES_REQUESTED', submitted_at: iso(2) },
      { id: 2, user: { login: 'cara' }, state: 'CHANGES_REQUESTED', submitted_at: iso(3) },
      { id: 3, user: { login: 'cara' }, state: 'APPROVED', submitted_at: iso(1.5) },
      { id: 4, user: { login: 'ben' }, state: 'COMMENTED', submitted_at: iso(1) },
    ] },
    '/repos/acme/api/pulls/21': { body: { head: { sha: 's21' }, base: { ref: 'main' }, mergeable_state: 'clean', updated_at: iso(1) } },
    '/repos/acme/api/commits/s21/check-runs': { body: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] } },
    '/repos/acme/api/commits/s21/status': { body: { statuses: [] } },
    '/repos/acme/api/pulls/21/reviews': { body: [{ id: 9, user: { login: 'ben' }, state: 'APPROVED', submitted_at: iso(1) }] },
    '/repos/acme/api/pulls/22': { body: { head: { sha: 's22' }, base: { ref: 'main' }, mergeable_state: 'dirty', draft: true, updated_at: iso(1) } },
    '/repos/acme/api/commits/s22/check-runs': { body: { check_runs: [] } },
    '/repos/acme/api/commits/s22/status': { body: { statuses: [] } },
    '/repos/acme/api/pulls/22/reviews': { body: [] },
    '/notifications': { body: [
      { reason: 'mention', updated_at: iso(0.2), repository: { full_name: 'acme/api', html_url: 'https://github.com/acme/api' },
        subject: { type: 'Issue', title: 'Crash on start', url: `${API}/repos/acme/api/issues/30`, latest_comment_url: `${API}/repos/acme/api/issues/comments/900` } },
      { reason: 'mention', updated_at: iso(1), repository: { full_name: 'acme/api', html_url: 'https://github.com/acme/api' },
        subject: { type: 'Issue', title: 'Already answered', url: `${API}/repos/acme/api/issues/31`, latest_comment_url: `${API}/repos/acme/api/issues/comments/901` } },
      { reason: 'team_mention', updated_at: iso(6), repository: { full_name: 'acme/api', html_url: 'https://github.com/acme/api' },
        subject: { type: 'Issue', title: 'Fix login', url: `${API}/repos/acme/api/issues/40`, latest_comment_url: `${API}/repos/acme/api/issues/comments/902` } },
      { reason: 'subscribed', updated_at: iso(1), repository: { full_name: 'acme/api' }, subject: { type: 'Issue', title: 'Noise', url: `${API}/repos/acme/api/issues/32` } },
      { reason: 'mention', updated_at: iso(1), repository: { full_name: 'acme/api' }, subject: { type: 'Commit', title: 'A commit', url: `${API}/repos/acme/api/commits/abc` } },
    ] },
    '/repos/acme/api/issues/comments/900': { body: { user: { login: 'dee' }, html_url: 'https://github.com/acme/api/issues/30#issuecomment-900', created_at: iso(0.2) } },
    '/repos/acme/api/issues/comments/901': { body: { user: { login: 'octocat' }, html_url: 'https://github.com/acme/api/issues/31#issuecomment-901', created_at: iso(1) } },
    '/repos/acme/api/issues/comments/902': { body: { user: { login: 'eve' }, html_url: 'https://github.com/acme/api/issues/40#issuecomment-902', created_at: iso(6) } },
    ...over,
  };
  return fakeFetch((u) => {
    if (u.pathname === '/search/issues') {
      const q = u.searchParams.get('q');
      const hit = Object.entries(searches).find(([k]) => q.includes(k));
      return { body: { total_count: hit?.[1].length ?? 0, incomplete_results: false, items: hit?.[1] ?? [] } };
    }
    const r = routes[u.pathname];
    return typeof r === 'function' ? r(u) : r;
  });
}

const signedIn = (token = 'gho_test') => ({ token: async () => token, status: async () => ({ login: 'octocat' }) });

async function run(fetchImpl, { github: auth = signedIn(), config = {} } = {}) {
  const warnings = [];
  let summary = null;
  const items = await github.collect(config, { now: NOW, fetch: fetchImpl, github: auth, warn: (w) => warnings.push(w), summary: (s) => { summary = s; } });
  return { items, warnings, summary, byId: Object.fromEntries(items.map((i) => [i.id, i])) };
}

describe('GitHub source', () => {
  it('asks you to sign in when there is no GitHub connection', async () => {
    const f = fakeGithub();
    await assert.rejects(github.collect({}, { now: NOW, fetch: f, github: { token: async () => null } }), /Sign in to GitHub in setup/);
    await assert.rejects(github.collect({}, { now: NOW, fetch: f }), /Sign in to GitHub in setup/);
    assert.equal(f.calls.length, 0, 'no requests without a token');
    const t = await github.test({}, { fetch: f, github: { token: async () => null } });
    assert.equal(t.ok, false);
  });

  it('review requests: who asked, how long ago, and team or draft requests rank lower', async () => {
    const { byId } = await run(fakeGithub());
    const mine = byId['github:review:acme/api#12'];
    assert.equal(mine.urgency, 'now');
    assert.equal(mine.why, '**@ana** requested your review **2 days** ago · they are waiting on you');
    assert.equal(mine.url, 'https://github.com/acme/api/pull/12');
    assert.equal(mine.title, 'api#12 · Add retries');
    assert.equal(mine.meta.command, 'gh pr checkout 12 -R acme/api');
    assert.equal(mine.meta.rule.id, 'review-waiting');

    const team = byId['github:review:acme/web#5'];
    assert.equal(team.urgency, 'later');
    assert.match(team.why, /\*\*@bo\*\* asked \*\*@acme\/frontend\*\* for a review/);

    const draft = byId['github:review:acme/web#6'];
    assert.equal(draft.urgency, 'later');
    assert.match(draft.why, /^Draft PR · \*\*@cy\*\*/);
  });

  it('your PRs: changes requested beats failing checks; clean PRs are left out', async () => {
    const { byId } = await run(fakeGithub());
    const p = byId['github:pr:acme/api#20'];
    assert.equal(p.urgency, 'today');
    assert.equal(p.meta.rule.id, 'pr-changes-requested');
    assert.equal(p.why, '**@ben** requested changes **2 days** ago · address the feedback');
    assert.equal(p.meta.fields['Failing checks'], 'test, ci/legacy');
    assert.equal(p.meta.fields['Changes requested by'], '@ben', 'cara approved after asking for changes');
    assert.equal(byId['github:pr:acme/api#21'], undefined);
    const draft = byId['github:pr:acme/api#22'];
    assert.equal(draft.urgency, 'later');
    assert.equal(draft.why, 'Draft · merge conflicts');
  });

  it('mentions: who mentioned you, skipping threads you already answered and non-issue notifications', async () => {
    const { byId, items } = await run(fakeGithub());
    const m = byId['github:mention:acme/api#30'];
    assert.equal(m.urgency, 'today');
    assert.equal(m.why, '**@dee** mentioned you **5 hours** ago');
    assert.equal(m.url, 'https://github.com/acme/api/issues/30#issuecomment-900');
    assert.ok(!items.some((i) => i.id.endsWith('#31')), 'you replied last');
    assert.ok(!items.some((i) => i.title.includes('Noise') || i.title.includes('A commit')));
  });

  it('assigned issues: overdue milestones and priority labels rise; duplicates keep the most urgent', async () => {
    const { byId, items } = await run(fakeGithub());
    const overdue = byId['github:issue:acme/api#40'];
    assert.equal(overdue.urgency, 'now');
    assert.equal(overdue.why, 'Milestone **v2.1** was due **1 day ago** · assigned to you');
    assert.equal(byId['github:mention:acme/api#40'], undefined, 'the team mention on #40 is folded into the issue');
    assert.equal(items.filter((i) => i.url.startsWith('https://github.com/acme/api/issues/40')).length, 1);
    assert.equal(byId['github:issue:acme/api#41'].why, 'Labeled **P1** · assigned to you');
    assert.equal(byId['github:issue:acme/api#42'].urgency, 'later');
  });

  it('summarises, only sends GETs, and only to the API host', async () => {
    const f = fakeGithub();
    const { summary, items } = await run(f);
    assert.equal(summary, '@octocat · 3 review requests · 2 PRs needing work · 1 mention · 3 assigned issues');
    assert.equal(items.length, 9);
    assert.ok(f.calls.every((c) => c.method === 'GET'));
    assert.ok(f.calls.every((c) => c.url.origin === API && c.headers.authorization === 'Bearer gho_test'));
    const q = f.calls.find((c) => c.url.pathname === '/search/issues').url.searchParams;
    assert.equal(q.get('per_page'), '50');
  });

  it('supports GitHub Enterprise URLs', async () => {
    const ghe = 'https://ghe.acme.dev/api/v3';
    const inner = fakeGithub();
    const f = async (url, init) => inner(String(url).replace(ghe, API), init);
    const { items } = await run(f, { config: { webUrl: 'https://ghe.acme.dev', apiUrl: ghe } });
    assert.ok(items.length > 0);
    assert.match(items.find((i) => i.kind === 'review-request').meta.command, /-R ghe\.acme\.dev\/acme\//);
  });

  it('turns API failures into clear messages', async () => {
    await assert.rejects(run(fakeGithub({ '/user': { status: 401, body: { message: 'Bad credentials' } } })), /rejected the token\. Sign in to GitHub again in setup/);
    await assert.rejects(
      run(fakeGithub({ '/user': { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 600) }, body: { message: 'API rate limit exceeded' } } })),
      /rate limit reached\. It resets at/,
    );
    const gone = await run(fakeGithub({ '/notifications': { status: 403, body: { message: 'Resource not accessible' } } }));
    assert.ok(gone.warnings.some((w) => /Mentions are skipped/.test(w)));
    assert.ok(gone.items.length > 0, 'the rest still works');
    await assert.rejects(github.collect({}, { now: NOW, fetch: fakeGithub(), github: { token: async () => { throw new Error('gh is not signed in.'); } } }), /gh is not signed in\. Or sign in to GitHub again/);
  });

  it('test() says who you are signed in as', async () => {
    const r = await github.test({}, { fetch: fakeGithub(), github: signedIn() });
    assert.deepEqual([r.ok, r.message], [true, 'Connected to github.com as @octocat']);
  });
});

describe('GitHub helpers', () => {
  it('the client never sends the token to another host', async () => {
    const f = fakeFetch(() => ({ body: {} }));
    const gh = github.githubClient({ apiUrl: API, token: 't', fetchImpl: f });
    await assert.rejects(gh.get('https://evil.example/repos/x'), /Refusing to send the GitHub token/);
    await assert.rejects(gh.get('https://api.github.com.evil.example/x'), /Refusing/);
    assert.equal(f.calls.length, 0);
  });

  it('getEnds reads the first and last page of long lists', async () => {
    const f = fakeFetch((u) => (u.searchParams.get('page') === '4'
      ? { body: [{ id: 3 }, { id: 4 }] }
      : { body: [{ id: 1 }, { id: 2 }], headers: { link: `<${API}/x?page=2>; rel="next", <${API}/x?page=4>; rel="last"` } }));
    const gh = github.githubClient({ apiUrl: API, token: 't', fetchImpl: f });
    assert.deepEqual((await gh.getEnds('/x')).map((x) => x.id), [1, 2, 3, 4]);
  });

  it('picks your review request over a team one, and reads verdicts per reviewer', () => {
    const ev = [
      { event: 'review_requested', requested_reviewer: { login: 'OctoCat' }, id: 1 },
      { event: 'review_requested', requested_team: { slug: 't' }, id: 2 },
    ];
    assert.equal(github.requestEvent(ev, 'octocat').event.id, 1);
    assert.equal(github.requestEvent(ev.slice(1), 'octocat').team.slug, 't');
    assert.deepEqual(github.changesRequested([
      { user: { login: 'a' }, state: 'CHANGES_REQUESTED', submitted_at: iso(1) },
      { user: { login: 'a' }, state: 'DISMISSED', submitted_at: iso(0) },
      { user: { login: 'me' }, state: 'CHANGES_REQUESTED', submitted_at: iso(0) },
    ], 'me').by, []);
    assert.deepEqual(github.failingChecks([{ name: 'x', status: 'completed', conclusion: 'timed_out' }, { name: 'y', status: 'completed', conclusion: 'neutral' }], [{ context: 'z', state: 'pending' }]), ['x']);
    assert.deepEqual(github.priorityLabels(['P0', 'priority: high', 'sev-1', 'bug', 'enhancement', 'urgent']), ['P0', 'priority: high', 'sev-1', 'urgent']);
  });
});
