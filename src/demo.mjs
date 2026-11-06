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
  normalizeSettings: (input = {}) => ({ roots: (Array.isArray(input.roots) ? input.roots : ['~/code']).map(String).slice(0, 20) }), // the demo never scans them
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

/** Tickets on the board: one search with statuses in the lanes, with a changelog for "time in status". */
function boardIssues(now) {
  const status = (name) => ({ name, statusCategory: { key: 'indeterminate' } });
  const moved = (to, daysAgo) => ({ histories: [{ created: iso(now - daysAgo * DAY), items: [{ field: 'status', toString: to }] }] });
  const t = (key, summary, st, daysIn, extra = {}) => ({
    key, changelog: moved(st, daysIn),
    fields: { summary, status: status(st), priority: { name: 'Medium' }, issuetype: { name: 'Story' }, assignee: { displayName: 'Sam Developer' }, fixVersions: [], updated: iso(now - Math.min(daysIn, 1) * DAY), ...extra },
  });
  return [
    t('PAY-214', 'Reconcile November payouts', 'In Progress', 2.2, { priority: { name: 'High' } }),
    t('PAY-235', 'Payout retry dashboard', 'In Progress', 0.4, { issuetype: { name: 'Task' } }),
    t('PAY-226', 'Show refund status in the dashboard', 'In Code Review', 1.3),
    t('PAY-233', 'Idempotency keys on payout API', 'In Code Review', 3.6, { issuetype: { name: 'Bug' }, priority: { name: 'High' } }),
    t('PAY-219', 'Refund audit log', 'In Code Review Pass', 0.8, { fixVersions: [{ name: '2026.11.2' }] }),
    t('PAY-198', 'Payout CSV export', 'Ready for Deployment', 1.9, { fixVersions: [{ name: '2026.11.2' }] }),
    t('PAY-201', 'Currency rounding on refunds', 'Ready for Deployment', 4.1, { issuetype: { name: 'Bug' }, fixVersions: [{ name: '2026.11.2' }] }),
  ];
}

// ---------------------------------------------------------------------------
// Worktrees and slots (canned, so the demo never reads your disk)

const QA_PATTERN = 'https://qa{n}.acme-demo.example';
/** What each QA slot's /api/version says. Missing = up on main; null = not answering. */
const QA_DEPLOYS = { 2: 'feature/PAY-219-refund-audit', 3: 'feature/PAY-226-refund-status', 7: 'release/2026.11.2', 9: 'feature/PAY-198-payout-csv', 11: null, 12: 'feature/OPS-90-log-shipping' };

export function demoWorkspaceGit(now = Date.now()) {
  const home = os.homedir();
  const repo = path.join(home, 'code', 'acme-payments');
  const wt = (suffix, branch, facts) => ({ path: suffix ? `${repo}-${suffix}` : repo, branch, head: 'a1b2c3d4e5f6', facts });
  const ago = (d) => new Date(now - d * DAY).toISOString();
  const list = [
    wt('', 'main', { changed: 0, untracked: 0, ahead: 0, behind: 0, unpushed: 0, lastCommitAt: ago(0.3), lastSubject: 'Merge PAY-205: payout webhooks' }),
    wt('PAY-214', 'feature/PAY-214-reconcile-payouts', { changed: 4, untracked: 1, ahead: 3, behind: 2, unpushed: 1, lastCommitAt: ago(0.2), lastSubject: 'Match payouts by settlement id' }),
    wt('PAY-226', 'feature/PAY-226-refund-status', { changed: 0, untracked: 0, ahead: 5, behind: 6, unpushed: 0, lastCommitAt: ago(1.3), lastSubject: 'Refund status pill' }),
    wt('PAY-233', 'bugfix/PAY-233-idempotency', { changed: 0, untracked: 0, ahead: 2, behind: 1, unpushed: 0, lastCommitAt: ago(3.6), lastSubject: 'Reject replayed payout requests' }),
    wt('PAY-180', 'feature/PAY-180-old-export', { changed: 2, untracked: 0, ahead: 1, behind: 41, unpushed: 1, lastCommitAt: ago(19), lastSubject: 'WIP export' }),
  ];
  return {
    findRepos: async () => [repo],
    worktrees: async () => list.map((w, i) => ({ path: w.path, head: w.head, branch: w.branch, bare: false, detached: false, locked: false, prunable: false, main: i === 0 })),
    base: async () => 'origin/main',
    inspect: async (dir) => ({ conflicts: 0, upstream: 'origin/x', ...list.find((w) => w.path === dir).facts }),
    readFile: async () => { throw new Error('no lock files in the demo'); },
  };
}
/** Dev 1's ports answer (it's running); the rest are quiet. */
export const demoProbe = async (port) => port === 5173 || port === 5001;

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
// A scripted stand-in for Claude, so "Ask Fetch" works in the demo without a key.
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

/** The user's words in a question turn (the app puts a context block first). */
const questionText = (m) => (typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) && m.content.every((b) => b.type === 'text') ? m.content.at(-1).text : null);

export function demoClaude(body) {
  const msgs = body.messages ?? [];
  const last = msgs.at(-1);
  const question = ([...msgs].reverse().map(questionText).find((q) => q !== null) ?? '').toLowerCase();
  const wantsChange = /\b(done|snooze|clear)\b/.test(question);
  const wantsReply = /\b(reply|answer|respond)\b/.test(question);
  if (last?.role === 'user' && questionText(last) !== null) {
    const remember = /^(?:please )?remember (?:that )?(.+)/i.exec(questionText(last).trim());
    if (remember) return toolEvents('remember', { note: remember[1] });
    if (/(can'?t|cannot|not allowed|boundar|limits?\b|what can you)/.test(question)) {
      return textEvents("Here's where my leash ends:\n- I **can** read every source you've connected and tell you what needs you.\n- I **ask first** before marking done, snoozing, or sending a reply as you, and replies only work where you turned on \"Allow replies\".\n- I **never** see your tokens or settings, change GitHub, Jira or git, browse the web, follow instructions hidden in your items, or keep secrets in memory.\n\nTry: \"remember my API key is sk-ant-…\" and watch me refuse.");
    }
    if (/\b(token|api key|password|secret)\b/.test(question) && !/remember/.test(question)) {
      return textEvents("I can't see those. Birddog's tools never hand me tokens, API keys, passwords or settings: they stay in your keychain. I only get titles, \"why\" lines, fields and links.");
    }
    if (/what do you remember|memory/.test(question)) {
      const notes = /Your memory[^\n]*\n([\s\S]*)$/.exec(String(body.system ?? ''))?.[1]?.trim() ?? '(empty)';
      return textEvents(notes === '(empty)' ? "Nothing yet. Tell me \"remember that …\" and I'll keep it (you can see and delete notes under Memory)." : `Here's what I remember:\n${notes.replace(/\[[0-9a-f]+\] /g, '')}`);
    }
    if (wantsReply) return toolEvents('list_items', { source: 'slack' });
    const urgency = /calendar|meeting/.test(question) ? undefined : /today/.test(question) ? 'today' : 'now';
    return toolEvents('list_items', /calendar|meeting/.test(question) ? { source: 'cal' } : { urgency });
  }
  const result = Array.isArray(last?.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  const prevTool = msgs.at(-2)?.content?.find?.((b) => b.type === 'tool_use');
  if (prevTool?.name === 'list_items') {
    const items = parseList(result?.content);
    if (wantsReply && items[0]) return toolEvents('reply', { id: items[0].id, text: 'Sure, happy to. I can do 10:15, right after standup.' });
    if (wantsChange && items[0]) return toolEvents(/snooze/.test(question) ? 'snooze' : 'mark_done', /snooze/.test(question) ? { id: items[0].id, until: 'tomorrow' } : { id: items[0].id });
    if (!items.length) return textEvents('Nothing to fetch there right now. Good dog, you.');
    const lines = items.slice(0, 4).map((i) => `- **${i.title}**: ${i.why}`).join('\n');
    return textEvents(`Fetched! Here's what needs you${/today/.test(question) ? ' today' : ' first'}:\n${lines}\n\nI'd start with the first one: ${items[0].why.split(' · ')[0].toLowerCase()}.`);
  }
  if (prevTool?.name === 'remember') {
    return textEvents(result?.is_error ? `I didn't keep that. ${String(result.content).replace(/^REFUSED: /, '')}` : "Got it, I'll remember that. It's under Memory if you want to check or delete it.");
  }
  if (prevTool?.name === 'reply') {
    return textEvents(/declined/.test(result?.content ?? '') ? "Okay, not sent. It's still in your inbox." : `Sent! ${result?.content ?? ''} (Demo mode: the fake Slack kept it to itself.)`);
  }
  if (prevTool && ['mark_done', 'snooze', 'restore'].includes(prevTool.name)) {
    return textEvents(/declined/.test(result?.content ?? '') ? "Okay, I'll drop it. Left as it is." : `Done, and brought back the receipt: ${result?.content ?? ''}`);
  }
  return textEvents('Woof. I\'m Fetch, in demo mode: a scripted stand-in. With your own Anthropic API key, Claude answers here as me.');
}

// ---------------------------------------------------------------------------
// Slack (fake): one DM and one channel mention, and replies that go nowhere.

const SLACK_ME = 'U0DEMOSAM';
const SLACK_PEOPLE = { U0DEMOPRI: 'priya', U0DEMOJON: 'jonas' };

function slackData(t0, sent, now) {
  const ts = (agoMs) => ((t0 - agoMs) / 1000).toFixed(6);
  const dmTs = ts(40 * MIN);
  const mentionTs = ts(2 * HOUR);
  return {
    'auth.test': { ok: true, team: 'Acme', user: 'sam', user_id: SLACK_ME },
    'search.messages': { ok: true, messages: { matches: sent.has('C0DEMOPAY') ? [] : [{ ts: mentionTs, user: 'U0DEMOJON', text: `<@${SLACK_ME}> can you sanity-check the webhook retry cap before Friday's deploy?`, channel: { id: 'C0DEMOPAY', name: 'payments', is_im: false }, permalink: `https://acme-demo.slack.com/archives/C0DEMOPAY/p${mentionTs.replace('.', '')}` }] } },
    'conversations.list': { ok: true, channels: [{ id: 'D0DEMOPRI', user: 'U0DEMOPRI', is_im: true }] },
    'conversations.history': { ok: true, messages: sent.has('D0DEMOPRI') ? [{ ts: ((now - MIN) / 1000).toFixed(6), user: SLACK_ME, text: '(your reply)' }] : [{ ts: dmTs, user: 'U0DEMOPRI', text: 'Got 5 min to pair on the Safari login bug after standup?' }] },
  };
}

// ---------------------------------------------------------------------------
// Microsoft Teams (fake Graph): a 1:1 chat waiting on you and a group-chat @mention.

const TEAMS_ME = { id: 'demo-sam', displayName: 'Sam Developer', mail: 'sam@acme.example' };
const teamsLink = (chatId) => `https://teams.microsoft.com/l/chat/${encodeURIComponent(chatId)}/0`;

function teamsData(t0, sentTo, now) {
  const at = (agoMs) => new Date(t0 - agoMs).toISOString();
  const lena = { user: { id: 'demo-lena', displayName: 'Lena Ortiz' } };
  const omar = { user: { id: 'demo-omar', displayName: 'Omar Haddad' } };
  const mine = (chatId) => sentTo.get(chatId);
  const dm = mine('19:demo-lena') ?? { id: 'm-lena-1', createdDateTime: at(25 * MIN), messageType: 'message', from: lena, body: { contentType: 'html', content: '<p>Could you look over the release notes before 4? I flagged two lines.</p>' } };
  const mention = { id: 'm-launch-7', createdDateTime: at(70 * MIN), messageType: 'message', from: omar, body: { contentType: 'html', content: '<p><at id="0">Sam</at> can you confirm the rollout window for Thursday?</p>' }, mentions: [{ id: 0, mentionText: 'Sam', mentioned: { user: { id: TEAMS_ME.id, displayName: 'Sam' } } }] };
  const launch = [...(mine('19:demo-launch') ? [mine('19:demo-launch')] : []), mention, { id: 'm-launch-6', createdDateTime: at(80 * MIN), messageType: 'message', from: omar, body: { contentType: 'html', content: '<p>Staging looks good.</p>' } }];
  return {
    chats: [
      { id: '19:demo-lena', chatType: 'oneOnOne', topic: null, webUrl: teamsLink('19:demo-lena'), lastMessagePreview: dm },
      { id: '19:demo-launch', chatType: 'group', topic: 'Launch crew', webUrl: teamsLink('19:demo-launch'), lastMessagePreview: launch[0] },
    ],
    messages: { '19:demo-launch': launch, '19:demo-lena': [dm] },
  };
}

/** fetch() for the demo: answers for the fake APIs above, and refuses everything else. */
// ---- Discord: a bot in one made-up server, and your user id ------------------------
export const DISCORD_ME = '1100000000000000042';
const DISCORD_GUILD = { id: '1200000000000000001', name: 'Lantern Game Jam' };
const snowflake = (t) => String((BigInt(Math.floor(t)) - 1420070400000n) << 22n);
function discordData(t0) {
  const at = (h) => t0 - h * HOUR;
  const person = (id, username, global_name) => ({ id, username, global_name });
  const kai = person('1100000000000000007', 'kai', 'Kai');
  const rae = person('1100000000000000008', 'raeb', 'Rae');
  const msg = (h, author, content, extra = {}) => ({ id: snowflake(at(h)), timestamp: new Date(at(h)).toISOString(), author, content, mentions: [], mention_roles: [], ...extra });
  return {
    channels: [
      { id: '1300000000000000001', name: 'general', type: 0, last_message_id: snowflake(at(0.6)) },
      { id: '1300000000000000002', name: 'art-feedback', type: 0, last_message_id: snowflake(at(30)) },
      { id: '1300000000000000003', name: 'voice', type: 2, last_message_id: null },
    ],
    messages: {
      '1300000000000000001': [
        msg(0.6, kai, `<@${DISCORD_ME}> can you look at the build for the jam submission tonight? itch.io page is up`, { mentions: [{ id: DISCORD_ME }] }),
        msg(3, rae, 'Who has the lighting shader?'),
      ],
      '1300000000000000002': [
        msg(30, rae, '<@&1400000000000000001> new tileset pass is in, thoughts?', { mention_roles: ['1400000000000000001'] }),
      ],
    },
  };
}

// ---- Thunderbird: a made-up profile folder with one Inbox ---------------------------
function mboxMessage({ from, subject, at, status, id }) {
  return `From - ${new Date(at).toUTCString()}\nX-Mozilla-Status: ${status}\nX-Mozilla-Status2: 00000000\nMessage-ID: <${id}@home.example>\nDate: ${new Date(at).toUTCString()}\nFrom: ${from}\nTo: Sam <sam@home.example>\nSubject: ${subject}\nContent-Type: text/plain; charset=UTF-8\n\nMade-up message for the Birddog demo.\n\n`;
}
export async function demoThunderbird(dir, now = Date.now()) {
  const profile = path.join(dir, 'thunderbird-profile');
  const inbox = path.join(profile, 'ImapMail', 'imap.home.example');
  await fs.mkdir(inbox, { recursive: true });
  await fs.writeFile(path.join(profile, 'prefs.js'), [
    'user_pref("mail.server.server1.directory-rel", "[ProfD]ImapMail/imap.home.example");',
    'user_pref("mail.server.server1.hostname", "imap.home.example");',
    'user_pref("mail.server.server1.type", "imap");',
    'user_pref("mail.server.server1.userName", "sam@home.example");',
  ].join('\n') + '\n');
  await fs.writeFile(path.join(inbox, 'INBOX'), [
    mboxMessage({ from: 'Old Newsletter <news@example.org>', subject: 'Last week in woodworking', at: now - 9 * DAY, status: '0000', id: 'n1' }),
    mboxMessage({ from: '"Dana (landlord)" <dana@home.example>', subject: 'Boiler service visit: Thursday 9–11?', at: now - 2.5 * HOUR, status: '0000', id: 'd1' }),
    mboxMessage({ from: 'City Library <noreply@library.example>', subject: '=?UTF-8?Q?Your_hold_is_ready_=E2=80=93_pick_up_by_Saturday?=', at: now - 1.6 * DAY, status: '0000', id: 'l1' }),
    mboxMessage({ from: 'Alex <alex@home.example>', subject: 'Camping weekend: who brings the stove?', at: now - 3 * DAY, status: '0005', id: 'a1' }),
    mboxMessage({ from: 'Shop <orders@shop.example>', subject: 'Your order has shipped', at: now - 5 * HOUR, status: '0001', id: 's1' }),
    mboxMessage({ from: 'Spam <x@spam.example>', subject: 'Deleted message', at: now - 1 * HOUR, status: '0008', id: 'x1' }),
  ].join(''));
  return profile;
}

export function demoFetch(clock = () => Date.now()) {
  const sent = new Set(); // channels the demo "replied" in, so the item clears like the real thing
  const teamsSent = new Map(); // Teams chat id → your reply
  const t0 = clock(); // fake Slack messages keep their timestamps (and so their ids) across refreshes
  return async (url, init = {}) => {
    const u = new URL(url);
    const now = clock();
    const json = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), text: async () => JSON.stringify(body), json: async () => body });
    if (u.origin === 'https://slack.com') {
      const method = u.pathname.replace('/api/', '');
      const body = init.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams);
      if (method === 'chat.postMessage') { sent.add(body.channel); return json({ ok: true, channel: body.channel, ts: (now / 1000).toFixed(6) }); }
      if (method === 'chat.getPermalink') return json({ ok: true, permalink: `https://acme-demo.slack.com/archives/${body.channel}/p${String(body.message_ts).replace('.', '')}` });
      if (method === 'users.info') return json({ ok: true, user: { name: SLACK_PEOPLE[body.user] ?? 'someone', profile: { display_name: SLACK_PEOPLE[body.user] ?? '' } } });
      const data = slackData(t0, sent, now)[method];
      return data ? json(data, 200, { 'x-oauth-scopes': 'search:read,im:read,im:history,users:read,chat:write' }) : json({ ok: false, error: 'unknown_method' });
    }
    if (u.origin === 'https://discord.com') {
      const p = u.pathname.replace('/api/v10', '');
      const d = discordData(t0);
      if (p === '/users/@me') return json({ id: '1100000000000000099', username: 'birddog-demo-bot' });
      if (p === '/users/@me/guilds') return json([DISCORD_GUILD]);
      if (p === `/guilds/${DISCORD_GUILD.id}/channels`) return json(d.channels);
      if (p === `/guilds/${DISCORD_GUILD.id}/members/${DISCORD_ME}`) return json({ roles: ['1400000000000000001'] });
      if (p === `/guilds/${DISCORD_GUILD.id}/threads/active`) return json({ threads: [] });
      const m = /^\/channels\/(\d+)\/messages$/.exec(p);
      if (m) return json(d.messages[m[1]] ?? []);
      return json({ message: 'Unknown', code: 0 }, 404);
    }
    if (u.origin === 'https://graph.microsoft.com') {
      const p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
      const data = teamsData(t0, teamsSent, now);
      if (p === '/me') return json(TEAMS_ME);
      if (p === '/me/chats') return json({ value: data.chats });
      const m = /^\/chats\/([^/]+)\/messages$/.exec(p);
      if (m && (init.method ?? 'GET') === 'POST') {
        const msg = { id: `m-you-${now}`, createdDateTime: new Date(now).toISOString(), messageType: 'message', from: { user: { id: TEAMS_ME.id, displayName: TEAMS_ME.displayName } }, body: JSON.parse(init.body).body, webUrl: teamsLink(m[1]) };
        teamsSent.set(m[1], msg);
        return json(msg, 201);
      }
      if (m) return json({ value: data.messages[m[1]] ?? [] });
      return json({ error: { code: 'NotFound', message: 'Not in the demo' } }, 404);
    }
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
      if (u.pathname === '/rest/api/3/search/jql') return json({ isLast: true, issues: /status in \(/.test(u.searchParams.get('jql') ?? '') ? boardIssues(now) : jiraData(now) });
    }
    if (u.origin === 'https://api.anthropic.com' && u.pathname === '/v1/messages') {
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: sseBody(demoClaude(JSON.parse(init.body))) };
    }
    const qa = /^https:\/\/qa(\d+)\.acme-demo\.example$/.exec(u.origin);
    if (qa && u.pathname === '/api/version') {
      const n = Number(qa[1]);
      if (QA_DEPLOYS[n] === null) throw new TypeError('fetch failed');
      return json({ branch: QA_DEPLOYS[n] ?? 'main', gitSha: `9f${String(n).padStart(2, '0')}c0ffee1234`, buildId: `2026.11.${300 + n}`, deployedAt: iso(now - n * 3 * HOUR) });
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
  const m = new Map([['jira-token', 'demo-not-a-real-token'], ['cal-url', CAL_URL], ['anthropic-api-key', 'demo-key-not-real-scripted-assistant'], ['slack-token', 'xoxp-demo-not-a-real-token'], ['discord-token', 'demo-not-a-real-token'],
    // A fake Teams sign-in that never expires (the fake Graph above takes any token).
    ['oauth-teams', JSON.stringify({ access_token: 'demo-not-a-real-token', refresh_token: null, expires_at: 8_640_000_000_000_000, scope: 'User.Read Chat.Read ChatMessage.Send' })]]);
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
  const thunderbird = await demoThunderbird(dir);
  await writeJson(path.join(dir, 'config.json'), {
    port: 4848,
    refreshMinutes: 5,
    sources: {
      git: { enabled: true, roots: ['~/code'] },
      jira: { enabled: true, site: JIRA, email: 'sam@acme.example' },
      cal: { enabled: true, file: '', email: 'sam@acme.example' },
      // Replies are on in the demo; the fake Slack above takes them and sends nothing anywhere.
      slack: { enabled: true, allowReplies: true },
      teams: { enabled: true, allowReplies: true },
      discord: { enabled: true, userId: DISCORD_ME, guilds: '' },
      thunderbird: { enabled: true, profile: thunderbird, days: 7 },
    },
    // Work shows everything on weekdays; Home shows the personal sources.
    profiles: [
      { id: 'work', name: 'Work', sources: ['git', 'github', 'jira', 'cal', 'slack', 'teams'], schedule: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }, notify: true },
      { id: 'home', name: 'Home', sources: ['git', 'github', 'cal', 'discord', 'thunderbird'], schedule: null, notify: true },
    ],
    chat: { demo: true },
    workspace: {
      devSlots: [{ label: 'Dev 1', ports: [5173, 5001] }, { label: 'Dev 2', ports: [5174, 5003] }, { label: 'Dev 3', ports: [5175, 5005] }],
      qa: { count: 12, pattern: QA_PATTERN, versionPath: '/api/version', label: 'QA {n}' },
    },
  });
  await writeJson(path.join(dir, 'slots.json'), {
    dev: { dev1: { worktree: '~/code/acme-payments-PAY-214', ticket: 'PAY-214', note: null, at: new Date().toISOString() }, dev2: { worktree: '~/code/acme-payments-PAY-226', ticket: 'PAY-226', note: 'Checking the refund pill on Safari', at: new Date().toISOString() } },
    qa: { 5: { ticket: 'PAY-233', owner: 'Priya', note: 'Regression run', at: new Date().toISOString() } },
  });
  await writeJson(path.join(dir, 'connections.json'), {
    github: { method: 'gh-cli', login: ME, name: 'Sam Developer', connectedAt: new Date().toISOString() },
    oauth: { teams: { account: 'sam@acme.example', connectedAt: new Date().toISOString() } },
  });
  await writeJson(path.join(dir, 'state.json'), { version: 1, items: {}, prefs: { seenSetup: true, profile: 'all' } });
  await writeJson(path.join(dir, 'history.json'), { days: demoHistory(Date.now()) });
  return {
    options: {
      dir,
      // The other sources are listed (switched off) so setup shows every card.
      sources: [demoGit, github, jira, cal, ...SOURCES.filter((x) => !['git', 'github', 'jira', 'cal'].includes(x.id))],
      secrets: demoSecrets(),
      workspaceGit: demoWorkspaceGit(),
      workspaceProbe: demoProbe,
      fetchImpl: demoFetch(),
      cliToken: async () => 'demo-not-a-real-token',
      // Made-up folders for the first-run screen, so the demo never looks at your disk.
      firstRunFolders: async () => ({ home: '~', folders: [{ path: '~/code', repos: 6, configured: true, selected: true }, { path: '~/Projects', repos: 2, configured: false, selected: false }, { path: '~/Documents/GitHub', repos: 0, configured: false, selected: false }] }),
    },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
