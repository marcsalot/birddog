// Jira Cloud source.
//
// Reports the open tickets assigned to you, ranked by what is most pressing:
//   • overdue or due soon
//   • in a sprint that ends soon
//   • blocked (by a linked ticket, flagged, or in a "Blocked" status)
//   • high priority
//   • a blocker has reached done or is advancing (unblock signal)
//   • in-progress ticket with no recent git commits (no-progress nudge)
//
// Signs in with your Atlassian email and an API token. The token lives in your
// OS keychain (secret "jira-token"), never in config.json.
// Read-only: it only sends GET requests.

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { getJson, HttpError } from './http.mjs';

export const id = 'jira';
export const name = 'Jira Cloud';
export const description = 'Tickets assigned to you, blocked work and sprint deadlines.';
/** Off until you connect it, so people without Jira never see a broken source. */
export const enabledByDefault = false;
/** Setup fields that are secrets: field name → secret store key. Never written to config.json. */
export const secretFields = Object.freeze({ token: 'jira-token' });

export const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
export const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

const DAY = 86_400_000;
const PAGE = 100;
const MAX_PAGES = 3;
const FIELD_CACHE_MS = 3_600_000;
const BLOCKED_STATUS = /\b(blocked|impeded|on hold)\b/i;
const fieldCache = new Map(); // site → { at, fields }

/** Late-stage statuses that signal a blocker is about to be resolved. */
export const DEFAULT_ADVANCING = ['Ready for Deployment', 'Ready for QA', 'In QA', 'UAT', 'Done', 'Closed'];

/** In-progress statuses that should have recent commits. */
export const DEFAULT_IN_PROGRESS = ['In Development', 'In Progress', 'In Dev'];

// ---------------------------------------------------------------------------
// Boards helpers

/** Parse and validate a boards array coming from the settings form or API. */
function normBoards(raw) {
  if (!Array.isArray(raw)) return undefined;
  const boards = raw
    .map((b) => ({ id: Number(b.id), name: String(b.name ?? ''), type: String(b.type ?? 'scrum'), enabled: b.enabled !== false }))
    .filter((b) => b.id > 0);
  return boards.length ? boards : undefined;
}

function tryParseBoards(v) {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v ?? 'null'); return Array.isArray(p) ? p : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Settings

/** "acme", "acme.atlassian.net" or a pasted ticket URL → "https://acme.atlassian.net". */
export function normalizeSite(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new TypeError('Enter your Jira site, like acme.atlassian.net');
  if (/^[a-z0-9][a-z0-9-]*$/i.test(s)) s = `${s}.atlassian.net`;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new TypeError(`"${input}" is not a valid site address`); }
  if (u.protocol !== 'https:') throw new TypeError('The Jira site must use https, so your token is never sent in the clear');
  if (u.username || u.password) throw new TypeError('Leave the user name out of the site address');
  return `https://${u.host.toLowerCase()}`;
}

export function normalizeSettings(input = {}) {
  const boards = normBoards(tryParseBoards(input.boards));
  if (input.auth === 'oauth') return { auth: 'oauth', ...(boards ? { boards } : {}) };
  const site = normalizeSite(input.site);
  const email = String(input.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new TypeError('Enter the email address you use to sign in to Atlassian');
  return { site, email, auth: 'token', ...(boards ? { boards } : {}) };
}

// ---------------------------------------------------------------------------
// API client

export async function jiraClient(config, ctx) {
  const fetchImpl = ctx.fetch ?? fetch;
  let site; let apiBase; let headers;
  if (config.auth === 'oauth') {
    // "Sign in with Atlassian": a Bearer token for api.atlassian.com/ex/jira/<cloudId>.
    if (!ctx.oauth) throw new Error('Sign in to Atlassian in setup.');
    const conn = await ctx.oauth.connection('atlassian');
    if (!conn?.cloudId) throw new Error('Sign in to Atlassian in setup.');
    const token = await ctx.oauth.accessToken('atlassian');
    site = normalizeSite(conn.site ?? config.site);
    apiBase = `https://api.atlassian.com/ex/jira/${encodeURIComponent(conn.cloudId)}`;
    headers = { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'birddog' };
  } else {
    if (!config.site || !config.email) throw new Error('Connect Jira in setup: add your site, email and an API token.');
    site = normalizeSite(config.site);
    const token = await ctx.secret?.(secretFields.token);
    if (!token) throw new Error('No Jira API token saved yet. Add one in setup.');
    apiBase = site;
    headers = {
      authorization: `Basic ${Buffer.from(`${config.email}:${token}`).toString('base64')}`,
      accept: 'application/json',
      'user-agent': 'birddog',
    };
  }
  const host = new URL(site).host;
  return {
    site,
    host,
    async get(p) {
      try {
        return (await getJson(fetchImpl, `${apiBase}${p}`, { headers, label: host })).body;
      } catch (err) {
        if (!(err instanceof HttpError) || !err.status) throw err;
        if (err.status === 401) throw new HttpError(config.auth === 'oauth' ? `${host} rejected the Atlassian sign-in. Sign in again in setup.` : `${host} rejected the email or API token. Create a new token and update it in setup.`, err);
        if (err.status === 403) throw new HttpError(`${host} refused access (HTTP 403). Check that ${config.email} can use Jira there.`, err);
        if (err.status === 404) throw new HttpError(`No Jira Cloud API at ${host}. Check the site address.`, err);
        if (err.status === 429) throw new HttpError(`${host} is rate limiting Birddog. It will try again on the next refresh.`, err);
        const why = err.body?.errorMessages?.[0] ?? '';
        throw new HttpError(`${host} returned HTTP ${err.status}${why ? `: ${why}` : ''}`, err);
      }
    },
  };
}

/** Find the custom field ids for Sprint and Flagged; they differ per site. */
export function pickFields(all = []) {
  const sprint = all.find((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id ?? null;
  const flagged = all.find((f) => f.custom && f.name === 'Flagged')?.id ?? null;
  return { sprint, flagged };
}

async function customFields(jira, warn, now) {
  const hit = fieldCache.get(jira.site);
  if (hit && now - hit.at < FIELD_CACHE_MS) return hit.fields;
  let fields = { sprint: null, flagged: null };
  try {
    fields = pickFields(await jira.get('/rest/api/3/field'));
    fieldCache.set(jira.site, { at: now, fields });
  } catch (err) {
    warn(`Could not look up the Sprint and Flagged fields: ${err.message}`);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Concurrency helper

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Turning tickets into items (pure, unit tested)

/** Days left until the end of a "YYYY-MM-DD" due date in local time (negative = overdue). */
export function dueDaysLeft(due, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due ?? '');
  if (!m) return null;
  return (new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime() - now) / DAY;
}

export function signalOf(issue, fieldIds, now) {
  const f = issue.fields ?? {};
  const status = f.status?.name ?? 'Unknown status';
  const sprints = Array.isArray(fieldIds.sprint && f[fieldIds.sprint]) ? f[fieldIds.sprint] : [];
  const sprint = sprints.find((s) => s?.state === 'active') ?? null;
  const flag = fieldIds.flagged ? f[fieldIds.flagged] : null;
  const blockedBy = (f.issuelinks ?? [])
    .filter((l) => l.inwardIssue && /blocked by/i.test(l.type?.inward ?? '')
      && l.inwardIssue.fields?.status?.statusCategory?.key !== 'done')
    .map((l) => l.inwardIssue.key);
  return {
    status,
    priority: f.priority?.name ?? null,
    dueDays: dueDaysLeft(f.duedate, now),
    sprint: sprint?.name ?? null,
    sprintEnd: sprint?.endDate ?? null,
    sprintDays: sprint?.endDate ? (Date.parse(sprint.endDate) - now) / DAY : null,
    blockedBy,
    flagged: Array.isArray(flag) ? flag.length > 0 : !!flag,
    blockedStatus: BLOCKED_STATUS.test(status),
    ageDays: Math.max(0, (now - Date.parse(f.updated ?? now)) / DAY),
  };
}

export function issueItem(issue, { site, host, fieldIds, now }) {
  const f = issue.fields ?? {};
  const s = signalOf(issue, fieldIds, now);
  const r = rank('ticket', s);
  return createItem({
    id: `jira:${host}:${issue.key}`,
    source: id,
    kind: 'ticket',
    title: `${issue.key} · ${f.summary ?? '(no summary)'}`,
    url: `${site}/browse/${encodeURIComponent(issue.key)}`,
    why: r.why,
    urgency: r.urgency,
    updatedAt: f.updated ?? now,
    meta: {
      rule: r.rule,
      fingerprint: [s.status, s.priority, f.duedate, s.sprint, s.blockedBy.join(','), s.flagged].join('|'),
      fields: {
        Ticket: issue.key,
        Status: s.status,
        Priority: s.priority ?? 'none',
        Type: f.issuetype?.name ?? 'unknown',
        Project: f.project?.name ?? issue.key.split('-')[0],
        Due: f.duedate ?? 'no due date',
        Sprint: s.sprint ? `${s.sprint}${s.sprintEnd ? ` (ends ${s.sprintEnd.slice(0, 10)})` : ''}` : 'none',
        'Blocked by': s.blockedBy.join(', ') || (s.flagged ? 'flagged' : 'nothing'),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Unblock signals

/**
 * For each blocked (non-done) ticket, fetch the current status of its blockers.
 * Emit an unblock item when a blocker has reached done or is advancing.
 */
export async function buildUnblockItems(issues, fieldIds, jira, config, now) {
  const advancingStatuses = new Set(config.advancingStatuses ?? DEFAULT_ADVANCING);

  // Collect unique blocker keys and which of my tickets each one blocks.
  // We look at ALL "blocked by" inward links (not just non-done ones),
  // so we surface unblock signals even when the blocker was already done
  // in the JQL snapshot.
  const blockerToMyTickets = new Map(); // blockerKey → Set<myKey>
  for (const issue of issues) {
    const f = issue.fields ?? {};
    // Skip tickets that are themselves done
    if (f.status?.statusCategory?.key === 'done') continue;

    const s = signalOf(issue, fieldIds, now);
    if (!(s.blockedBy.length > 0 || s.flagged || s.blockedStatus)) continue;

    const blockerLinks = (f.issuelinks ?? [])
      .filter((l) => l.inwardIssue && /blocked by/i.test(l.type?.inward ?? ''));

    for (const link of blockerLinks) {
      const blockerKey = link.inwardIssue.key;
      if (!blockerToMyTickets.has(blockerKey)) blockerToMyTickets.set(blockerKey, new Set());
      blockerToMyTickets.get(blockerKey).add(issue.key);
    }
  }

  if (!blockerToMyTickets.size) return [];

  // Fetch current status for each unique blocker (max 5 parallel to avoid rate-limiting)
  const blockerKeys = [...blockerToMyTickets.keys()];
  const statuses = await mapLimit(blockerKeys, 5, async (key) => {
    try {
      const r = await jira.get(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,summary`);
      const statusName = r?.fields?.status?.name ?? 'Unknown';
      const categoryKey = r?.fields?.status?.statusCategory?.key ?? '';
      return { key, statusName, categoryKey };
    } catch {
      return { key, statusName: null, categoryKey: null };
    }
  });

  // Build one item per (blockerKey, myKey) pair when the blocker is done or advancing
  const items = [];
  for (const { key: blockerKey, statusName: blockerStatus, categoryKey } of statuses) {
    if (!blockerStatus) continue;

    const done = categoryKey === 'done';
    const advancing = advancingStatuses.has(blockerStatus);
    if (!done && !advancing) continue;

    for (const myKey of blockerToMyTickets.get(blockerKey)) {
      const myIssue = issues.find((i) => i.key === myKey);
      const f = myIssue?.fields ?? {};
      const signal = { blockerKey, blockerStatus, done };
      const r = rank('unblock', signal);
      items.push(createItem({
        id: `jira:${jira.host}:unblock:${myKey}:${blockerKey}`,
        source: id,
        kind: 'unblock',
        title: `${myKey} · blocker ${blockerKey} ${done ? 'is done' : 'is advancing'}`,
        url: `${jira.site}/browse/${encodeURIComponent(myKey)}`,
        why: r.why,
        urgency: r.urgency,
        updatedAt: f.updated ?? new Date(now).toISOString(),
        meta: {
          rule: r.rule,
          fingerprint: `${blockerKey}:${blockerStatus}`,
          fields: {
            Ticket: myKey,
            Blocker: blockerKey,
            'Blocker status': blockerStatus,
          },
        },
      }));
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// No-progress nudge

/**
 * For each in-progress ticket, check whether a matching local branch has had
 * a recent commit. Emits a no-progress item if the branch is stale or missing.
 * Gracefully skips when ctx.gitActivity is not provided.
 */
export function buildNoProgressItems(issues, fieldIds, ctx, config, now, site, host) {
  if (!ctx.gitActivity) return [];

  const inProgressStatuses = new Set(config.inProgressStatuses ?? DEFAULT_IN_PROGRESS);
  const threshold = config.noProgressDays ?? 3;
  const { gitActivity } = ctx;
  const items = [];

  for (const issue of issues) {
    const f = issue.fields ?? {};
    // Skip done tickets
    if (f.status?.statusCategory?.key === 'done') continue;

    const status = f.status?.name ?? 'Unknown';
    if (!inProgressStatuses.has(status)) continue;

    // Find any branch whose name contains the ticket key (case-insensitive)
    const keyLower = issue.key.toLowerCase();
    let latestCommitMs = null;
    for (const [branch, commitMs] of gitActivity) {
      if (branch.toLowerCase().includes(keyLower)) {
        if (latestCommitMs === null || commitMs > latestCommitMs) {
          latestCommitMs = commitMs;
        }
      }
    }

    // days=null: no uncommitted/unpushed activity for this key; also fires when the branch is clean.
    // Will improve once git items expose per-branch last-commit data regardless of push state.
    const rawDays = latestCommitMs !== null ? Math.max(0, (now - latestCommitMs) / DAY) : null;
    const days = rawDays !== null ? Math.floor(rawDays) : null;

    // Only nudge when stale or no branch
    if (rawDays !== null && rawDays < threshold) continue;

    const signal = { status, days, threshold };
    const r = rank('no-progress', signal);
    items.push(createItem({
      id: `jira:${host}:noprogress:${issue.key}`,
      source: id,
      kind: 'no-progress',
      title: `${issue.key} · ${status} with no recent commits`,
      url: `${site}/browse/${encodeURIComponent(issue.key)}`,
      why: r.why,
      urgency: r.urgency,
      updatedAt: f.updated ?? new Date(now).toISOString(),
      meta: {
        rule: r.rule,
        fingerprint: `${status}:${days}`,
        fields: {
          Ticket: issue.key,
          Status: status,
          'Days since commit': days !== null ? days : 'no branch found',
          Threshold: `${threshold} days`,
        },
      },
    }));
  }

  return items;
}

// ---------------------------------------------------------------------------
// Plugin interface

/** Fetch boards available to this account via the Jira Agile API. */
export async function getBoards(config, ctx) {
  const jira = await jiraClient(config, ctx);
  const data = await jira.get('/rest/agile/1.0/board?maxResults=50&orderBy=name');
  const boards = (data?.values ?? []).map((b) => ({
    id: b.id, name: b.name, type: b.type ?? 'scrum', project: b.location?.projectName ?? null,
  }));
  return { boards };
}

export async function test(config = {}, ctx = {}) {
  try {
    const jira = await jiraClient(config, ctx);
    const me = await jira.get('/rest/api/3/myself');
    return { ok: true, message: `Connected to ${jira.host} as ${me?.displayName ?? me?.emailAddress ?? config.email}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const warn = ctx.warn ?? (() => {});
  const jira = await jiraClient(config, ctx);
  const fieldIds = await customFields(jira, warn, now);
  const fields = ['summary', 'status', 'priority', 'duedate', 'updated', 'issuetype', 'project', 'issuelinks', fieldIds.sprint, fieldIds.flagged]
    .filter(Boolean).join(',');
  const enabledBoards = (config.boards ?? []).filter((b) => b.enabled !== false);
  let jql = typeof config.jql === 'string' && config.jql.trim() ? config.jql : DEFAULT_JQL;
  if (enabledBoards.length > 0 && jql === DEFAULT_JQL) {
    const bf = enabledBoards.map((b) => `sprint in boardSprints(${b.id})`).join(' OR ');
    jql = `assignee = currentUser() AND statusCategory != Done AND (${bf}) ORDER BY updated DESC`;
  }

  const issues = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ jql, fields, maxResults: String(PAGE) });
    if (pageToken) q.set('nextPageToken', pageToken);
    const r = await jira.get(`/rest/api/3/search/jql?${q}`);
    issues.push(...(r?.issues ?? []));
    pageToken = r?.nextPageToken ?? null;
    if (!pageToken || r?.isLast) { pageToken = null; break; }
  }
  if (pageToken) warn(`Showing the ${issues.length} most recently updated tickets; narrow the JQL to see the rest`);

  const items = issues.map((issue) => issueItem(issue, { site: jira.site, host: jira.host, fieldIds, now }));
  const blocked = items.filter((i) => i.meta.rule.id === 'jira-blocked').length;

  // Unblock signals: fetch blocker statuses and emit items when a blocker advances
  const unblockItems = await buildUnblockItems(issues, fieldIds, jira, config, now).catch((err) => {
    warn(`Could not fetch blocker statuses: ${err.message}`);
    return [];
  });

  // No-progress nudge: check ctx.gitActivity for in-progress tickets
  const noProgressItems = buildNoProgressItems(issues, fieldIds, ctx, config, now, jira.site, jira.host);

  ctx.summary?.(`${jira.host} · ${plural(items.length, 'open ticket')}${blocked ? ` · ${blocked} blocked` : ''}`);
  return [...items, ...unblockItems, ...noProgressItems];
}
