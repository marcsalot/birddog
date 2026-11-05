// The ticket board: your Jira tickets at a glance, in delivery swimlanes.
//
// Lanes are a list of { id, label, statuses }. A ticket lands in the first lane that
// lists its status (case and spacing don't matter); tickets in no lane are left off.
// The defaults follow a common delivery flow:
//
//   In Progress → In Code Review → Code Review Pass → Ready for Deployment
//
// Every team names its statuses a little differently, so each lane takes several
// names and the whole list can be edited on the board (config.json → board.lanes).
//
// Read-only, like the Jira source: one search (with the changelog, for "time in
// status") per refresh, cached for a minute. Birddog never moves a ticket.

import { jiraClient } from './sources/jira.mjs';

const DAY = 86_400_000;
const PAGE = 100;
const MAX_PAGES = 3;
const CACHE_MS = 60_000;
const MAX_LANES = 8;
const MAX_STATUSES = 12;

export const DEFAULT_LANES = Object.freeze([
  { id: 'progress', label: 'In Progress', statuses: ['In Progress', 'In Development'] },
  { id: 'review', label: 'In Code Review', statuses: ['In Code Review', 'Code Review', 'PR Code Review', 'In Review'] },
  { id: 'passed', label: 'Code Review Pass', statuses: ['In Code Review Pass', 'Code Review Pass', 'Code Review Passed', 'Review Passed'] },
  { id: 'deploy', label: 'Ready for Deployment', statuses: ['Ready for Deployment', 'Ready for Deploy', 'Ready to Deploy'] },
].map((l) => Object.freeze({ ...l, statuses: Object.freeze(l.statuses) })));

/** Whose tickets: "mine" (assigned to you), "projects" (everyone's in those projects) or "jql" (your own filter). */
export const SCOPES = Object.freeze(['mine', 'projects', 'jql']);

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The board settings, with defaults filled in. Never throws (bad config falls back to defaults). */
export function boardSettings(config = {}) {
  const b = config.board ?? {};
  try { return normalizeBoard(b); } catch { return normalizeBoard({}); }
}

/** Clean board settings from the UI or config.json. Throws TypeError with a message for people. */
export function normalizeBoard(input = {}) {
  const scope = input.scope ?? 'mine';
  if (!SCOPES.includes(scope)) throw new TypeError(`scope must be one of ${SCOPES.join(', ')}`);
  let projects = input.projects ?? [];
  if (typeof projects === 'string') projects = projects.split(/[\s,]+/);
  if (!Array.isArray(projects)) throw new TypeError('projects must be a list of project keys');
  projects = [...new Set(projects.map((p) => String(p).trim().toUpperCase()).filter(Boolean))];
  if (projects.length > 20 || projects.some((p) => !/^[A-Z][A-Z0-9_]{0,19}$/.test(p))) throw new TypeError('Project keys look like PROJ or DBA (letters and digits, up to 20)');
  if (scope === 'projects' && !projects.length) throw new TypeError('Add at least one project key, like PROJ');
  const jql = String(input.jql ?? '').trim();
  if (jql.length > 1000) throw new TypeError('The JQL filter is too long (1000 characters at most)');
  if (scope === 'jql' && !jql) throw new TypeError('Enter a JQL filter, like: project = PROJ AND sprint in openSprints()');
  if (/\border\s+by\b/i.test(jql)) throw new TypeError('Leave ORDER BY out of the filter; the board sorts by itself');

  const lanesIn = input.lanes ?? DEFAULT_LANES;
  if (!Array.isArray(lanesIn) || !lanesIn.length) throw new TypeError('The board needs at least one lane');
  if (lanesIn.length > MAX_LANES) throw new TypeError(`The board has room for ${MAX_LANES} lanes at most`);
  const seenIds = new Set();
  const seenStatuses = new Map();
  const lanes = lanesIn.map((l, n) => {
    const label = String(l?.label ?? '').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 40) throw new TypeError(`Lane ${n + 1} needs a name (up to 40 characters)`);
    let statuses = l.statuses ?? [];
    if (typeof statuses === 'string') statuses = statuses.split(/[,\n]/);
    if (!Array.isArray(statuses)) throw new TypeError(`"${label}" statuses must be a list`);
    statuses = [...new Set(statuses.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean))];
    if (!statuses.length) throw new TypeError(`"${label}" needs at least one Jira status`);
    if (statuses.length > MAX_STATUSES || statuses.some((s) => s.length > 60 || /["\\]/.test(s))) throw new TypeError(`"${label}" has too many or too long statuses`);
    for (const s of statuses) {
      const other = seenStatuses.get(norm(s));
      if (other) throw new TypeError(`"${s}" is in both "${other}" and "${label}". A status can be in one lane only.`);
      seenStatuses.set(norm(s), label);
    }
    let id = String(l.id ?? '').trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `lane-${n + 1}`;
    if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new TypeError(`Lane id "${id}" may use lowercase letters, digits and dashes`);
    while (seenIds.has(id)) id = `${id}-${n + 1}`;
    seenIds.add(id);
    return { id, label, statuses };
  });
  return { scope, projects, jql, lanes };
}

/** The lane id a status belongs to, or null. */
export function laneOf(status, lanes) {
  const s = norm(status);
  return lanes.find((l) => l.statuses.some((x) => norm(x) === s))?.id ?? null;
}

const quote = (s) => `"${String(s).replace(/["\\]/g, '')}"`;

/** The JQL the board runs: whose tickets, in any lane's status, newest first. */
export function boardJql(settings) {
  const statuses = settings.lanes.flatMap((l) => l.statuses);
  const who = settings.scope === 'mine' ? 'assignee = currentUser()'
    : settings.scope === 'projects' ? `project in (${settings.projects.map(quote).join(', ')})`
      : `(${settings.jql})`;
  return `${who} AND status in (${statuses.map(quote).join(', ')}) ORDER BY updated DESC`;
}

/** When the ticket entered its current status: the newest status change in the changelog. */
export function statusSince(issue) {
  const current = norm(issue.fields?.status?.name);
  let best = null;
  for (const h of issue.changelog?.histories ?? []) {
    const at = Date.parse(h.created);
    if (!Number.isFinite(at)) continue;
    for (const it of h.items ?? []) {
      if (it.field !== 'status' || norm(it.toString) !== current) continue;
      if (best === null || at > best) best = at;
    }
  }
  if (best !== null) return best;
  const cat = Date.parse(issue.fields?.statuscategorychangedate ?? '');
  return Number.isFinite(cat) ? cat : null;
}

/** One card's worth of a ticket. */
export function cardOf(issue, { site, lanes, now }) {
  const f = issue.fields ?? {};
  const since = statusSince(issue);
  return {
    key: issue.key,
    summary: f.summary ?? '(no summary)',
    url: `${site}/browse/${encodeURIComponent(issue.key)}`,
    status: f.status?.name ?? 'Unknown',
    lane: laneOf(f.status?.name, lanes),
    type: f.issuetype?.name ?? null,
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    fixVersions: (f.fixVersions ?? []).map((v) => v?.name).filter(Boolean),
    sinceAt: since ? new Date(since).toISOString() : null,
    daysInStatus: since ? Math.max(0, (now - since) / DAY) : null,
    updatedAt: f.updated ?? null,
  };
}

/** Issues → lanes of cards. Cards in a lane: longest in status first (what's been sitting). */
export function boardFromIssues(issues, { site, lanes, now = Date.now() }) {
  const cards = issues.map((i) => cardOf(i, { site, lanes, now })).filter((c) => c.lane);
  const order = (a, b) => (b.daysInStatus ?? -1) - (a.daysInStatus ?? -1) || a.key.localeCompare(b.key, 'en', { numeric: true });
  return lanes.map((l) => ({ id: l.id, label: l.label, statuses: l.statuses, cards: cards.filter((c) => c.lane === l.id).sort(order) }));
}

/**
 * The board service: cached, refreshed on demand.
 * getConfig() → full config; ctx is the sources' context (fetch, oauth, secret).
 */
export function createBoard({ getConfig, context, now = () => Date.now() }) {
  let cache = null; // { at, key, data }
  let inflight = null;

  async function load() {
    const config = getConfig();
    const settings = boardSettings(config);
    const jiraCfg = config.sources?.jira ?? {};
    const base = { settings, refreshedAt: new Date(now()).toISOString() };
    if (jiraCfg.enabled === false || (!jiraCfg.site && jiraCfg.auth !== 'oauth')) {
      return { ...base, connected: false, lanes: boardFromIssues([], { site: '', lanes: settings.lanes }), total: 0, error: null };
    }
    const jira = await jiraClient(jiraCfg, context);
    const fields = 'summary,status,priority,issuetype,assignee,fixVersions,updated,statuscategorychangedate';
    const jql = boardJql(settings);
    const issues = [];
    let token = null;
    let more = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ jql, fields, expand: 'changelog', maxResults: String(PAGE) });
      if (token) q.set('nextPageToken', token);
      const r = await jira.get(`/rest/api/3/search/jql?${q}`);
      issues.push(...(r?.issues ?? []));
      token = r?.nextPageToken ?? null;
      if (!token || r?.isLast) { token = null; break; }
      more = page === MAX_PAGES - 1;
    }
    const lanes = boardFromIssues(issues, { site: jira.site, lanes: settings.lanes, now: now() });
    return { ...base, connected: true, site: jira.site, jql, lanes, total: lanes.reduce((n, l) => n + l.cards.length, 0), truncated: more, error: null };
  }

  return {
    /** The board; cached for a minute unless fresh is set. Errors come back as { error }, not thrown. */
    async get({ fresh = false } = {}) {
      const key = JSON.stringify([getConfig().board ?? null, getConfig().sources?.jira ?? null]);
      if (!fresh && cache && cache.key === key && now() - cache.at < CACHE_MS) return cache.data;
      inflight ??= load()
        .catch((err) => ({ settings: boardSettings(getConfig()), connected: true, lanes: boardFromIssues([], { site: '', lanes: boardSettings(getConfig()).lanes }), total: 0, error: err.message, refreshedAt: new Date(now()).toISOString() }))
        .then((data) => { cache = { at: now(), key, data }; return data; })
        .finally(() => { inflight = null; });
      return inflight;
    },
    /** The last board loaded, if any (for linking tickets from the worktrees page). */
    cached() { return cache?.data ?? null; },
    clear() { cache = null; },
  };
}
