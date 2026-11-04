// Jira Cloud source.
//
// Reports the open tickets assigned to you, ranked by what is most pressing:
//   • overdue or due soon
//   • in a sprint that ends soon
//   • blocked (by a linked ticket, flagged, or in a "Blocked" status)
//   • high priority
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
  if (input.auth === 'oauth') return { auth: 'oauth' };
  const site = normalizeSite(input.site);
  const email = String(input.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new TypeError('Enter the email address you use to sign in to Atlassian');
  return { site, email, auth: 'token' };
}

// ---------------------------------------------------------------------------
// API client

async function jiraClient(config, ctx) {
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
// Plugin interface

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
  const jql = typeof config.jql === 'string' && config.jql.trim() ? config.jql : DEFAULT_JQL;

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
  ctx.summary?.(`${jira.host} · ${plural(items.length, 'open ticket')}${blocked ? ` · ${blocked} blocked` : ''}`);
  return items;
}
