// Demo mode (`birddog --demo`): a believable inbox made of fake data, for screenshots,
// GIFs and trying Birddog out.
//
// Nothing here touches your real setup: it uses a fresh temporary folder, an
// in-memory secret store, a fake `gh`, and a fake fetch() that answers for an
// imaginary company ("Acme") and never reaches the network. The real GitHub,
// Jira and Calendar sources run against those fake APIs, so ranking and "why"
// lines are exactly what you would see with real data. Local git is canned,
// because it would otherwise read your real repos.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createItem } from './items.mjs';
import { ago, rank } from './rules.mjs';
import * as cal from './sources/cal.mjs';
import * as github from './sources/github.mjs';
import { SOURCES } from './sources/index.mjs';
import * as jira from './sources/jira.mjs';
import { writeJson } from './store.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const API = 'https://api.github.com';
const JIRA = 'https://acme-demo.atlassian.net';
const CAL_URL = 'https://calendar.example.com/acme-demo/basic.ics';
const ME = 'sam-dev';

// ---------------------------------------------------------------------------
// Local git (canned)

function demoGitItems(now) {
  const where = (repo) => `~/code/${repo}`;
  const make = (fields) => createItem({ source: 'git', ...fields });
  const unpushed = rank('unpushed', { count: 3, ageDays: 4.2, hasUpstream: true });
  const dirty = rank('uncommitted', { tracked: 6, untracked: 1, ageDays: 3.4 });
  const merged = rank('merged-branches', { count: 4, base: 'main' });
  return [
    make({
      id: 'git:unpushed:demo-payments', kind: 'unpushed', title: 'acme-payments · 3 unpushed commits on feat/webhook-backoff',
      url: 'https://github.com/acme/payments/tree/feat/webhook-backoff', why: unpushed.why, urgency: unpushed.urgency,
      updatedAt: now - 4.2 * DAY,
      meta: {
        rule: unpushed.rule, path: where('acme-payments'), command: 'git -C ~/code/acme-payments push', fingerprint: 'demo-1',
        fields: { Repo: where('acme-payments'), Branch: 'feat/webhook-backoff', Upstream: 'origin/feat/webhook-backoff', 'Unpushed commits': 3, 'Latest commit': 'Cap retries at 8 attempts', 'Oldest commit': `${ago(4.2)} ago` },
      },
    }),
    make({
      id: 'git:uncommitted:demo-web', kind: 'uncommitted', title: 'acme-web · uncommitted changes in 7 files',
      url: 'https://github.com/acme/web', why: dirty.why, urgency: dirty.urgency, updatedAt: now - 3.4 * DAY,
      meta: {
        rule: dirty.rule, path: where('acme-web'), command: 'git -C ~/code/acme-web status', fingerprint: 'demo-2',
        fields: { Repo: where('acme-web'), Branch: 'fix/safari-login', 'Changed files': 6, 'New files': 1, Files: 'src/auth/session.ts, src/auth/cookies.ts +5 more' },
      },
    }),
    make({
      id: 'git:merged:demo-cli', kind: 'merged-branches', title: 'acme-cli · 4 merged branches safe to delete',
      url: 'https://github.com/acme/cli', why: merged.why, urgency: merged.urgency, updatedAt: now - 9 * DAY,
      meta: {
        rule: merged.rule, path: where('acme-cli'), command: 'git -C ~/code/acme-cli branch -d docs/config json-output fix/typo release/1.4', fingerprint: 'demo-3',
        fields: { Repo: where('acme-cli'), 'Merged into': 'main', Branches: 'docs/config, json-output, fix/typo, release/1.4' },
      },
    }),
  ];
}

export const demoGit = {
  id: 'git',
  name: 'Local git',
  description: 'Uncommitted work, unpushed commits and branches to tidy in your local repos. (Demo data.)',
  test: async () => ({ ok: true, message: 'Demo: 3 repos in ~/code' }),
  collect: async (_config, ctx) => { ctx.summary?.('3 repos scanned (demo)'); return demoGitItems(ctx.now ?? Date.now()); },
};

// ---------------------------------------------------------------------------
// Fake GitHub, Jira and calendar APIs

const iso = (t) => new Date(t).toISOString();
const icsTime = (t) => iso(t).replace(/[-:]/g, '').replace(/\.\d+/, '');

function githubData(now) {
  const pr = (repo, number, title, extra = {}) => ({
    number, title, html_url: `https://github.com/${repo}/pull/${number}`, repository_url: `${API}/repos/${repo}`,
    user: { login: 'ana-lopez' }, created_at: iso(now - 3 * DAY), updated_at: iso(now - 5 * HOUR), comments: 4, draft: false, ...extra,
  });
  const issue = (repo, number, title, extra = {}) => ({
    number, title, html_url: `https://github.com/${repo}/issues/${number}`, repository_url: `${API}/repos/${repo}`,
    user: { login: 'priya-s' }, created_at: iso(now - 12 * DAY), updated_at: iso(now - 2 * DAY), labels: [], milestone: null, comments: 2, ...extra,
  });
  const searches = {
    'review-requested:@me': [
      pr('acme/payments', 482, 'Retry failed webhooks with exponential backoff'),
      pr('acme/web', 97, 'Dark mode for the settings page', { user: { login: 'jo-chen' } }),
    ],
    'author:@me': [
      pr('acme/payments', 475, 'Cache FX rates for 10 minutes', { user: { login: ME } }),
      pr('acme/cli', 33, 'Add --json output to `acme status`', { user: { login: ME } }),
    ],
    'assignee:@me': [
      issue('acme/web', 88, 'Login loops forever on Safari 18', { labels: [{ name: 'bug' }, { name: 'P1' }], updated_at: iso(now - 6 * HOUR) }),
      issue('acme/payments', 460, 'Ledger export for finance', { milestone: { title: 'Q4 close', due_on: iso(now + 1.2 * DAY) } }),
      issue('acme/cli', 30, 'Document the config file', { updated_at: iso(now - 9 * DAY) }),
    ],
  };
  const routes = {
    '/user': { login: ME, name: 'Sam Developer' },
    '/repos/acme/payments/issues/482/events': [{ id: 101, event: 'review_requested', review_requester: { login: 'ana-lopez' }, requested_reviewer: { login: ME }, created_at: iso(now - 2.1 * DAY) }],
    '/repos/acme/web/issues/97/events': [{ id: 102, event: 'review_requested', review_requester: { login: 'jo-chen' }, requested_team: { slug: 'frontend' }, created_at: iso(now - 3 * HOUR) }],
    '/repos/acme/payments/pulls/475': { head: { sha: 'a1', ref: 'fx-cache' }, base: { ref: 'main' }, mergeable_state: 'clean', updated_at: iso(now - 40 * MIN) },
    '/repos/acme/payments/commits/a1/check-runs': { check_runs: [{ name: 'unit-tests', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'failure' }, { name: 'build', status: 'completed', conclusion: 'success' }] },
    '/repos/acme/payments/commits/a1/status': { statuses: [] },
    '/repos/acme/payments/pulls/475/reviews': [],
    '/repos/acme/cli/pulls/33': { head: { sha: 'b2', ref: 'json-status' }, base: { ref: 'main' }, mergeable_state: 'clean', updated_at: iso(now - 20 * HOUR) },
    '/repos/acme/cli/commits/b2/check-runs': { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
    '/repos/acme/cli/commits/b2/status': { statuses: [] },
    '/repos/acme/cli/pulls/33/reviews': [{ id: 7, user: { login: 'ben-k' }, state: 'CHANGES_REQUESTED', submitted_at: iso(now - 20 * HOUR) }],
    '/notifications': [{
      reason: 'mention', updated_at: iso(now - 2 * HOUR), repository: { full_name: 'acme/payments', html_url: 'https://github.com/acme/payments' },
      subject: { type: 'Issue', title: 'Refunds over $10k need a second approver', url: `${API}/repos/acme/payments/issues/470`, latest_comment_url: `${API}/repos/acme/payments/issues/comments/9001` },
    }],
    '/repos/acme/payments/issues/comments/9001': { user: { login: 'priya-s' }, html_url: 'https://github.com/acme/payments/issues/470#issuecomment-9001', created_at: iso(now - 2 * HOUR) },
  };
  return { searches, routes };
}

function jiraData(now) {
  const day = (offset) => { const d = new Date(now + offset * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const status = (name, key = 'indeterminate') => ({ name, statusCategory: { key } });
  const sprint = [{ id: 31, name: 'Payments 24', state: 'active', endDate: iso(now + 1.5 * DAY) }];
  const t = (key, summary, fields) => ({ key, fields: { summary, status: status('In Progress'), priority: { name: 'Medium' }, updated: iso(now - DAY), issuetype: { name: 'Task' }, project: { name: 'Payments' }, issuelinks: [], ...fields } });
  return [
    t('PAY-214', 'Reconcile November payouts', { duedate: day(-1), priority: { name: 'High' } }),
    t('PAY-220', 'Rotate webhook signing keys', { issuelinks: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'OPS-77', fields: { status: status('To Do', 'new') } } }] }),
    t('PAY-226', 'Show refund status in the dashboard', { status: status('In Review'), customfield_10020: sprint }),
    t('PAY-231', 'Remove the legacy payout cron', { status: status('To Do', 'new'), priority: { name: 'Low' }, updated: iso(now - 8 * DAY) }),
  ];
}

function calendarText(now) {
  const at = (h, m = 0, dayOffset = 0) => { const d = new Date(now); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.getTime(); };
  const soon = Math.ceil((now + 8 * MIN) / (5 * MIN)) * 5 * MIN; // a round time, 8 to 12 minutes away
  const later = Math.ceil((now + 2.5 * HOUR) / (30 * MIN)) * 30 * MIN;
  const today = new Date(now);
  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const tomorrow = new Date(now + DAY);
  const ev = (uid, summary, start, mins, extra = '') => `BEGIN:VEVENT\r\nUID:${uid}@demo\r\nSUMMARY:${summary}\r\nDTSTART:${icsTime(start)}\r\nDTEND:${icsTime(start + mins * MIN)}\r\n${extra}END:VEVENT\r\n`;
  return 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Birddog//Demo//EN\r\n'
    + ev('standup', 'Payments standup', soon, 15, 'LOCATION:https://acme.zoom.us/j/5550100\r\nORGANIZER;CN=Ana Lopez:mailto:ana@acme.example\r\n')
    + ev('1on1', '1:1 with Ana', later, 30, 'LOCATION:Room 4\r\n')
    + ev('design', 'Design review: refunds UI', at(10, 0, 1), 60, 'DESCRIPTION:Join: https://meet.google.com/abc-defg-hij\r\n')
    + `BEGIN:VEVENT\r\nUID:hackweek@demo\r\nSUMMARY:Hack week\r\nDTSTART;VALUE=DATE:${ymd(today)}\r\nDTEND;VALUE=DATE:${ymd(new Date(now + 3 * DAY))}\r\nEND:VEVENT\r\n`
    + `BEGIN:VEVENT\r\nUID:tomorrow-allday@demo\r\nSUMMARY:Office closed (local holiday)\r\nDTSTART;VALUE=DATE:${ymd(tomorrow)}\r\nEND:VEVENT\r\n`
    + 'END:VCALENDAR\r\n';
}

// ---------------------------------------------------------------------------
// A scripted stand-in for Claude, so "Ask Birddog" works in the demo without a key.
// It speaks the same streaming wire format, so the real chat code path runs.

function sseBody(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      for (let i = 0; i < text.length; i += 48) { c.enqueue(enc.encode(text.slice(i, i + 48))); await new Promise((r) => setTimeout(r, 12)); }
      c.close();
    },
  });
}

const textEvents = (text) => [
  { type: 'message_start', message: { id: 'msg_demo', model: 'demo (scripted, not Claude)' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ...text.match(/[\s\S]{1,6}/g).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
];
const toolEvents = (name, input) => [
  { type: 'message_start', message: { id: 'msg_demo', model: 'demo (scripted, not Claude)' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_demo_${name}_${Date.now()}`, name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
];

/** Items from list_items' text: "- [now] Title\n  why\n  id: …". */
function parseList(text) {
  const out = [];
  for (const m of String(text).matchAll(/- \[([a-z]+)[^\]]*\] (.+)\n {2}(.+)\n {2}id: (\S+)/g)) out.push({ urgency: m[1], title: m[2], why: m[3], id: m[4] });
  return out;
}

export function demoClaude(body) {
  const msgs = body.messages ?? [];
  const last = msgs.at(-1);
  const question = [...msgs].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')?.content?.toLowerCase() ?? '';
  const wantsChange = /\b(done|snooze|clear)\b/.test(question);
  if (last?.role === 'user' && typeof last.content === 'string') {
    const urgency = /calendar|meeting/.test(question) ? undefined : /today/.test(question) ? 'today' : 'now';
    return toolEvents('list_items', /calendar|meeting/.test(question) ? { source: 'cal' } : { urgency });
  }
  const result = Array.isArray(last?.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  const prevTool = msgs.at(-2)?.content?.find?.((b) => b.type === 'tool_use');
  if (prevTool?.name === 'list_items') {
    const items = parseList(result?.content);
    if (wantsChange && items[0]) return toolEvents(/snooze/.test(question) ? 'snooze' : 'mark_done', /snooze/.test(question) ? { id: items[0].id, until: 'tomorrow' } : { id: items[0].id });
    if (!items.length) return textEvents('Nothing there right now. Nice.');
    const lines = items.slice(0, 4).map((i) => `- **${i.title}**: ${i.why}`).join('\n');
    return textEvents(`Here's what needs you${/today/.test(question) ? ' today' : ' first'}:\n${lines}\n\nI'd start with the first one: ${items[0].why.split(' · ')[0].toLowerCase()}.`);
  }
  if (prevTool && ['mark_done', 'snooze', 'restore'].includes(prevTool.name)) {
    return textEvents(/declined/.test(result?.content ?? '') ? "Okay, I've left it as it is." : `Done. ${result?.content ?? ''}`);
  }
  return textEvents('(This is the demo\'s scripted assistant. With your own Anthropic API key, Claude answers here.)');
}

/** fetch() for the demo: answers for the fake APIs above, and refuses everything else. */
export function demoFetch(clock = () => Date.now()) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const now = clock();
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body });
    if (u.origin === API) {
      const gh = githubData(now);
      if (u.pathname === '/search/issues') {
        const q = u.searchParams.get('q');
        const hit = Object.entries(gh.searches).find(([k]) => q.includes(k))?.[1] ?? [];
        return json({ total_count: hit.length, incomplete_results: false, items: hit });
      }
      return gh.routes[u.pathname] ? json(gh.routes[u.pathname]) : json({ message: 'Not Found' }, 404);
    }
    if (u.origin === JIRA) {
      if (u.pathname === '/rest/api/3/myself') return json({ displayName: 'Sam Developer' });
      if (u.pathname === '/rest/api/3/field') return json([{ id: 'customfield_10020', name: 'Sprint', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }]);
      if (u.pathname === '/rest/api/3/search/jql') return json({ isLast: true, issues: jiraData(now) });
    }
    if (u.origin === 'https://api.anthropic.com' && u.pathname === '/v1/messages') {
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: sseBody(demoClaude(JSON.parse(init.body))) };
    }
    if (u.href === CAL_URL) return { ok: true, status: 200, headers: new Headers(), text: async () => calendarText(now) };
    return json({ message: 'Demo mode makes no real network requests' }, 404);
  };
}

/** Thirteen made-up past days, so the overview's 14-day chart has a shape. Today comes from the live data. */
export function demoHistory(now) {
  const open = [27, 29, 28, 31, 30, 26, 24, 25, 27, 23, 22, 24, 21];
  const hot = [5, 6, 4, 7, 6, 3, 2, 3, 5, 3, 2, 4, 3];
  const done = [3, 2, 4, 1, 3, 6, 5, 2, 3, 5, 4, 2, 4];
  const days = {};
  for (let i = 13; i >= 1; i--) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const k = 13 - i;
    days[key] = { open: open[k], now: hot[k], today: Math.round((open[k] - hot[k]) * 0.45), later: open[k] - hot[k] - Math.round((open[k] - hot[k]) * 0.45), done: done[k], snoozed: 0, at: d.toISOString() };
  }
  return days;
}

/** A secret store that lives in memory and starts with the demo's fake credentials. */
export function demoSecrets() {
  const m = new Map([['jira-token', 'demo-not-a-real-token'], ['cal-url', CAL_URL], ['anthropic-api-key', 'demo-key-not-real-scripted-assistant']]);
  return {
    kind: 'demo (in memory)',
    secure: true,
    warning: null,
    async get(n) { return m.get(n) ?? null; },
    async set(n, v) { m.set(n, v); },
    async delete(n) { m.delete(n); },
  };
}

/**
 * Everything createBirddog() needs for a demo, in a fresh temporary folder.
 * Returns { options, cleanup }.
 */
export async function createDemo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'birddog-demo-'));
  await writeJson(path.join(dir, 'config.json'), {
    port: 4848,
    refreshMinutes: 5,
    sources: {
      git: { enabled: true, roots: ['~/code'] },
      jira: { enabled: true, site: JIRA, email: 'sam@acme.example' },
      cal: { enabled: true, file: '', email: 'sam@acme.example' },
    },
    chat: { demo: true },
  });
  await writeJson(path.join(dir, 'connections.json'), { github: { method: 'gh-cli', login: ME, name: 'Sam Developer', connectedAt: new Date().toISOString() } });
  await writeJson(path.join(dir, 'state.json'), { version: 1, items: {}, prefs: { seenSetup: true } });
  await writeJson(path.join(dir, 'history.json'), { days: demoHistory(Date.now()) });
  return {
    options: {
      dir,
      // The other sources are listed (switched off) so setup shows every card.
      sources: [demoGit, github, jira, cal, ...SOURCES.filter((x) => !['git', 'github', 'jira', 'cal'].includes(x.id))],
      secrets: demoSecrets(),
      fetchImpl: demoFetch(),
      cliToken: async () => 'demo-not-a-real-token',
    },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
