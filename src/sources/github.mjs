// GitHub source.
//
// Reports what is waiting on you on GitHub:
//   • pull requests where your review is requested (you, or a team you are on)
//   • your open PRs with changes requested, failing checks or merge conflicts
//   • unread @mentions from the last two weeks (from your GitHub notifications)
//   • open issues assigned to you
//
// Uses the token from "Sign in with GitHub" in setup (gh CLI or device flow).
// Read-only: it only sends GET requests, and never marks notifications as read.

import { createItem, compareItems } from '../items.mjs';
import { GITHUB_DEFAULTS } from '../auth/github.mjs';
import { plural, rank } from '../rules.mjs';
import { getJson, HttpError, linkRel, mapLimit } from './http.mjs';

export const id = 'github';
export const name = 'GitHub';
export const description = 'Review requests, your PRs with failing checks or requested changes, mentions and assigned issues.';

const DAY = 86_400_000;
const SEARCH_LIMIT = 50; // results per search; more than this and we say so
const MENTION_DAYS = 14;
const CONCURRENCY = 6;
const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const PRIORITY = /^(p[01]|priority[\s:/_-]*(0|1|high|critical|urgent)|sev(erity)?[\s:/_-]*[01]|critical|urgent|blocker|high[\s_-]priority)$/i;

export const NOT_SIGNED_IN = 'Sign in to GitHub in setup to see review requests, your PRs, mentions and issues.';
const NO_ENV_TOKEN = (v) => `Set ${v} (or ${v}_FILE) for this container to see review requests, your PRs, mentions and issues.`;

// ---------------------------------------------------------------------------
// API client

/** A tiny GitHub REST client that never sends the token anywhere but apiUrl. */
export function githubClient({ apiUrl, token, fetchImpl = fetch }) {
  const base = apiUrl.replace(/\/+$/, '');
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'birddog',
  };
  const abs = (p) => {
    const url = /^https?:\/\//i.test(p) ? p : `${base}${p}`;
    if (url !== base && !url.startsWith(`${base}/`)) throw new Error(`Refusing to send the GitHub token to ${new URL(url).host}`);
    return url;
  };

  async function request(p) {
    try {
      return await getJson(fetchImpl, abs(p), { headers, label: 'GitHub' });
    } catch (err) {
      if (!(err instanceof HttpError) || !err.status) throw err;
      const h = err.headers;
      const msg = err.body?.message ? `: ${err.body.message}` : '';
      if (err.status === 401) throw new HttpError('GitHub rejected the token. Sign in to GitHub again in setup.', err);
      if ((err.status === 403 || err.status === 429) && (h?.get('x-ratelimit-remaining') === '0' || h?.get('retry-after'))) {
        const reset = Number(h.get('x-ratelimit-reset')) * 1000;
        const when = reset ? ` It resets at ${new Date(reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '';
        throw new HttpError(`GitHub rate limit reached.${when}`, err);
      }
      throw new HttpError(`GitHub returned HTTP ${err.status} for ${p.replace(base, '').split('?')[0]}${msg}`, err);
    }
  }

  return {
    async get(p) { return (await request(p)).body; },
    /** First page plus the last page, so "latest" lookups work on long threads. */
    async getEnds(p) {
      const first = await request(p);
      const last = linkRel(first.headers?.get?.('link'));
      if (!last) return first.body ?? [];
      const tail = (await request(last)).body ?? [];
      const seen = new Set();
      return [...(first.body ?? []), ...tail].filter((x) => (seen.has(x.id) ? false : seen.add(x.id)));
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers (pure, unit tested)

/** "https://api.github.com/repos/acme/api" → "acme/api" */
export function repoOf(searchItem) {
  const m = /\/repos\/([^/]+\/[^/]+)$/.exec(searchItem.repository_url ?? '');
  return m ? m[1] : searchItem.repository?.full_name ?? 'unknown/unknown';
}

/** Latest review state per reviewer → who currently has changes requested. */
export function changesRequested(reviews, me) {
  const latest = new Map();
  for (const r of reviews) {
    const login = r.user?.login;
    if (!login || login.toLowerCase() === me.toLowerCase()) continue;
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue; // comments don't change a verdict
    latest.set(login, r);
  }
  const changes = [...latest.values()].filter((r) => r.state === 'CHANGES_REQUESTED');
  return {
    by: changes.map((r) => r.user.login),
    at: changes.length ? Math.max(...changes.map((r) => Date.parse(r.submitted_at) || 0)) : null,
  };
}

/** Names of failing check runs and commit statuses. */
export function failingChecks(checkRuns = [], statuses = []) {
  const names = new Set();
  for (const c of checkRuns) if (c.status === 'completed' && FAILED.has(c.conclusion)) names.add(c.name);
  for (const s of statuses) if (s.state === 'failure' || s.state === 'error') names.add(s.context);
  return [...names];
}

/** The review_requested event that put this PR in your list (yours first, then a team's). */
export function requestEvent(events, me) {
  const reqs = events.filter((e) => e.event === 'review_requested');
  const lastOf = (list) => list[list.length - 1] ?? null;
  const mine = lastOf(reqs.filter((e) => e.requested_reviewer?.login?.toLowerCase() === me.toLowerCase()));
  if (mine) return { event: mine, team: null };
  const team = lastOf(reqs.filter((e) => e.requested_team));
  return { event: team, team: team?.requested_team ?? null };
}

export const priorityLabels = (labels = []) => labels.map((l) => (typeof l === 'string' ? l : l.name)).filter((n) => PRIORITY.test(n ?? ''));

// ---------------------------------------------------------------------------
// Collecting

function context(config, ctx) {
  const s = { ...GITHUB_DEFAULTS, ...config };
  const host = new URL(s.webUrl).host;
  return {
    settings: s,
    now: ctx.now ?? Date.now(),
    warn: ctx.warn ?? (() => {}),
    fetchImpl: ctx.fetch ?? fetch,
    repoFlag: (repo) => `-R ${host === 'github.com' ? '' : `${host}/`}${repo}`,
  };
}

async function signIn(ctx) {
  if (!ctx.github) throw new Error(NOT_SIGNED_IN);
  let token;
  try { token = await ctx.github.token(); } catch (err) { throw new Error(`${err.message} Or sign in to GitHub again in setup.`); }
  if (!token) {
    const from = (await Promise.resolve(ctx.github.status?.()).catch(() => null))?.tokenFrom;
    throw new Error(from?.variable ? NO_ENV_TOKEN(from.variable) : NOT_SIGNED_IN);
  }
  return token;
}

async function search(gh, q, warn, what) {
  const r = await gh.get(`/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${SEARCH_LIMIT}`);
  if (r.total_count > SEARCH_LIMIT) warn(`Showing the ${SEARCH_LIMIT} most recently updated of ${r.total_count} ${what}`);
  if (r.incomplete_results) warn(`GitHub returned partial results for ${what}`);
  return r.items ?? [];
}

const key = (repo, n) => `${repo.toLowerCase()}#${n}`;
const short = (repo, n, title) => `${repo.split('/')[1]}#${n} · ${title}`;
const days = (now, iso) => Math.max(0, (now - Date.parse(iso)) / DAY);

async function reviewItems(gh, me, c) {
  const found = await search(gh, 'is:open is:pr review-requested:@me archived:false', c.warn, 'review requests');
  return mapLimit(found, CONCURRENCY, async (it) => {
    const repo = repoOf(it);
    let events = [];
    try { events = await gh.getEnds(`/repos/${repo}/issues/${it.number}/events?per_page=100`); } catch (err) { c.warn(`${repo}#${it.number}: ${err.message}`); }
    const { event, team } = requestEvent(events, me);
    const at = event?.created_at ?? it.created_at;
    const signal = {
      requester: event?.review_requester?.login ?? event?.actor?.login ?? it.user?.login ?? null,
      team: team ? `@${repo.split('/')[0]}/${team.slug}` : null,
      draft: !!it.draft,
      ageDays: days(c.now, at),
    };
    const r = rank('review-request', signal);
    return createItem({
      id: `github:review:${key(repo, it.number)}`,
      source: id,
      kind: 'review-request',
      title: short(repo, it.number, it.title),
      url: it.html_url,
      why: r.why,
      urgency: r.urgency,
      updatedAt: at,
      meta: {
        rule: r.rule,
        command: `gh pr checkout ${it.number} ${c.repoFlag(repo)}`,
        fingerprint: String(event?.id ?? at),
        fields: {
          Repo: repo,
          'Pull request': `#${it.number}`,
          Author: it.user?.login ? `@${it.user.login}` : 'unknown',
          'Requested by': signal.requester ? `@${signal.requester}` : 'unknown',
          'Requested of': signal.team ?? 'you',
          Draft: signal.draft ? 'yes' : 'no',
          Comments: it.comments ?? 0,
        },
      },
    });
  });
}

async function myPrItems(gh, me, c) {
  const found = await search(gh, 'is:open is:pr author:@me archived:false', c.warn, 'open PRs');
  const out = await mapLimit(found, CONCURRENCY, async (it) => {
    const repo = repoOf(it);
    const where = `${repo}#${it.number}`;
    let pr;
    try { pr = await gh.get(`/repos/${repo}/pulls/${it.number}`); } catch (err) { c.warn(`${where}: ${err.message}`); return null; }
    const sha = pr.head?.sha;
    const soft = (p, fallback) => p.catch((err) => { c.warn(`${where}: ${err.message}`); return fallback; });
    const [checks, status, reviews] = await Promise.all([
      sha ? soft(gh.get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`), {}) : {},
      sha ? soft(gh.get(`/repos/${repo}/commits/${sha}/status?per_page=100`), {}) : {},
      soft(gh.getEnds(`/repos/${repo}/pulls/${it.number}/reviews?per_page=100`), []),
    ]);
    const failing = failingChecks(checks?.check_runs, status?.statuses);
    const changes = changesRequested(reviews ?? [], me);
    const conflict = pr.mergeable_state === 'dirty' || pr.mergeable === false;
    if (!failing.length && !changes.by.length && !conflict) return null;
    const signal = {
      draft: !!pr.draft,
      failing,
      changesBy: changes.by,
      conflict,
      base: pr.base?.ref ?? null,
      ageDays: days(c.now, changes.at ? new Date(changes.at).toISOString() : pr.updated_at),
    };
    const r = rank('my-pr', signal);
    return createItem({
      id: `github:pr:${key(repo, it.number)}`,
      source: id,
      kind: 'my-pr',
      title: short(repo, it.number, it.title),
      url: it.html_url,
      why: r.why,
      urgency: r.urgency,
      updatedAt: pr.updated_at ?? it.updated_at,
      meta: {
        rule: r.rule,
        command: failing.length ? `gh pr checks ${it.number} ${c.repoFlag(repo)}` : `gh pr view ${it.number} ${c.repoFlag(repo)} --comments`,
        fingerprint: [sha, [...failing].sort().join(','), [...changes.by].sort().join(','), conflict].join('|'),
        fields: {
          Repo: repo,
          'Pull request': `#${it.number}`,
          Branch: `${pr.head?.ref ?? '?'} → ${pr.base?.ref ?? '?'}`,
          'Changes requested by': changes.by.map((l) => `@${l}`).join(', ') || 'nobody',
          'Failing checks': failing.join(', ') || 'none',
          'Merge conflicts': conflict ? 'yes' : 'no',
          Draft: signal.draft ? 'yes' : 'no',
        },
      },
    });
  });
  return out.filter(Boolean);
}

async function mentionItems(gh, me, c) {
  const since = new Date(c.now - MENTION_DAYS * DAY).toISOString();
  let notes;
  try {
    notes = await gh.get(`/notifications?participating=true&per_page=50&since=${encodeURIComponent(since)}`);
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      c.warn('Mentions are skipped: this GitHub token cannot read notifications (fine-grained tokens cannot).');
      return [];
    }
    throw err;
  }
  const wanted = (notes ?? []).filter((n) => (n.reason === 'mention' || n.reason === 'team_mention')
    && (n.subject?.type === 'Issue' || n.subject?.type === 'PullRequest'));
  const out = await mapLimit(wanted, CONCURRENCY, async (n) => {
    const repo = n.repository?.full_name;
    const number = Number(/\/(\d+)$/.exec(n.subject.url ?? '')?.[1]);
    if (!repo || !number) return null;
    const isPr = n.subject.type === 'PullRequest';
    let url = `${n.repository.html_url ?? `${c.settings.webUrl}/${repo}`}/${isPr ? 'pull' : 'issues'}/${number}`;
    let by = null;
    let at = n.updated_at;
    if (n.subject.latest_comment_url) {
      try {
        const comment = await gh.get(n.subject.latest_comment_url);
        by = comment?.user?.login ?? null;
        if (/^https?:\/\//.test(comment?.html_url ?? '')) url = comment.html_url;
        at = comment?.updated_at ?? comment?.created_at ?? at;
      } catch (err) { c.warn(`${repo}#${number}: ${err.message}`); }
    }
    if (by && by.toLowerCase() === me.toLowerCase()) return null; // you already answered
    const signal = { by, team: n.reason === 'team_mention', ageDays: days(c.now, at) };
    const r = rank('mention', signal);
    return createItem({
      id: `github:mention:${key(repo, number)}`,
      source: id,
      kind: 'mention',
      title: short(repo, number, n.subject.title),
      url,
      why: r.why,
      urgency: r.urgency,
      updatedAt: at,
      meta: {
        rule: r.rule,
        command: `gh ${isPr ? 'pr' : 'issue'} view ${number} ${c.repoFlag(repo)} --comments`,
        fingerprint: n.updated_at,
        fields: {
          Repo: repo,
          [isPr ? 'Pull request' : 'Issue']: `#${number}`,
          'Mentioned by': by ? `@${by}` : 'unknown',
          Mentioned: signal.team ? 'your team' : 'you',
        },
      },
    });
  });
  return out.filter(Boolean);
}

async function issueItems(gh, c) {
  const found = await search(gh, 'is:open is:issue assignee:@me archived:false', c.warn, 'assigned issues');
  return found.map((it) => {
    const repo = repoOf(it);
    const due = it.milestone?.due_on ? (Date.parse(it.milestone.due_on) - c.now) / DAY : null;
    const labels = (it.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
    const signal = {
      milestone: it.milestone?.title ?? null,
      dueDays: due,
      priorityLabels: priorityLabels(labels),
      ageDays: days(c.now, it.updated_at),
    };
    const r = rank('issue', signal);
    return createItem({
      id: `github:issue:${key(repo, it.number)}`,
      source: id,
      kind: 'issue',
      title: short(repo, it.number, it.title),
      url: it.html_url,
      why: r.why,
      urgency: r.urgency,
      updatedAt: it.updated_at,
      meta: {
        rule: r.rule,
        command: `gh issue view ${it.number} ${c.repoFlag(repo)}`,
        fingerprint: it.updated_at,
        fields: {
          Repo: repo,
          Issue: `#${it.number}`,
          Labels: labels.join(', ') || 'none',
          Milestone: it.milestone ? `${it.milestone.title}${it.milestone.due_on ? ` (due ${it.milestone.due_on.slice(0, 10)})` : ''}` : 'none',
          'Opened by': it.user?.login ? `@${it.user.login}` : 'unknown',
          Comments: it.comments ?? 0,
        },
      },
    });
  });
}

/** One item per PR or issue: if it shows up twice (say, assigned and mentioned), keep the more urgent one. */
export function dedupe(items) {
  const best = new Map();
  for (const it of items) {
    const prev = best.get(it.url ? it.url.replace(/#.*$/, '') : it.id);
    if (!prev || compareItems(it, prev) < 0) best.set(it.url ? it.url.replace(/#.*$/, '') : it.id, it);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// Plugin interface

export async function test(config = {}, ctx = {}) {
  const c = context(config, ctx);
  let token;
  try { token = await signIn(ctx); } catch (err) { return { ok: false, message: err.message }; }
  try {
    const me = await githubClient({ apiUrl: c.settings.apiUrl, token, fetchImpl: c.fetchImpl }).get('/user');
    return { ok: true, login: me.login, message: `Connected to ${new URL(c.settings.webUrl).host} as @${me.login}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

export async function collect(config = {}, ctx = {}) {
  const c = context(config, ctx);
  const token = await signIn(ctx);
  const gh = githubClient({ apiUrl: c.settings.apiUrl, token, fetchImpl: c.fetchImpl });
  // Ask every time: with the gh CLI, the account behind the token can change under us.
  const me = (await gh.get('/user')).login;

  const [reviews, prs, mentions, issues] = await Promise.all([
    reviewItems(gh, me, c),
    myPrItems(gh, me, c),
    mentionItems(gh, me, c),
    issueItems(gh, c),
  ]);
  const items = dedupe([...reviews, ...prs, ...mentions, ...issues]);
  const count = (kind) => items.filter((i) => i.kind === kind).length;
  ctx.summary?.([
    `@${me}`,
    plural(count('review-request'), 'review request'),
    plural(count('my-pr'), 'PR needing work', 'PRs needing work'),
    plural(count('mention'), 'mention'),
    plural(count('issue'), 'assigned issue'),
  ].join(' · '));
  return items;
}
