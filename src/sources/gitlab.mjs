// GitLab source (gitlab.com or self-managed).
//
//   • merge requests waiting for your review
//   • your open merge requests whose pipeline failed, or that have conflicts
//   • open issues assigned to you
//
// Sign in with GitLab (OAuth + PKCE, scope read_api) or a personal access token
// with the read_api scope, kept in your keychain. Read-only (GET only).

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { mapLimit } from './http.mjs';
import { baseUrl, daysSince, daysUntilDate, jsonClient, tokenSetup } from './web.mjs';
import { priorityLabels } from './github.mjs';

export const id = 'gitlab';
export const name = 'GitLab';
export const description = 'Merge requests to review, your MRs with failed pipelines, and issues assigned to you.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'gitlab-token' });
export const setup = tokenSetup({
  fields: [{ key: 'url', label: 'GitLab address', placeholder: 'https://gitlab.com', optional: true }],
  token: { label: 'Personal access token (scope read_api)', help: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Birddog&scopes=read_api', placeholder: 'glpat-…' },
  oauth: 'gitlab',
});

export function normalizeSettings(input = {}) {
  if (input.auth === 'oauth') return { auth: 'oauth', url: baseUrl(input.url, 'https://gitlab.com') };
  return { url: baseUrl(input.url, 'https://gitlab.com'), auth: 'token' };
}

async function client(config, ctx) {
  const base = baseUrl(config.url, 'https://gitlab.com');
  const label = new URL(base).host;
  let headers;
  if (config.auth === 'oauth') {
    if (!ctx.oauth) throw new Error('Sign in to GitLab in setup.');
    headers = { authorization: `Bearer ${await ctx.oauth.accessToken('gitlab')}` };
  } else {
    const token = await ctx.secret?.(secretFields.token);
    if (!token) throw new Error('Add a GitLab personal access token (read_api) in setup, or sign in with GitLab.');
    headers = { 'private-token': token };
  }
  const http = jsonClient({ fetchImpl: ctx.fetch ?? fetch, label, headers, fix: config.auth === 'oauth' ? 'Sign in to GitLab again in setup.' : 'Make a new token with the read_api scope and update it in setup.' });
  return { base, label, get: (p) => http.get(`${base}/api/v4${p}`) };
}

const ref = (mr) => mr.references?.full ?? `${mr.project_id}!${mr.iid}`;
const short = (mr) => `${(mr.references?.full ?? '').split('/').pop() || `!${mr.iid}`} · ${mr.title}`;

export async function test(config = {}, ctx = {}) {
  try {
    const gl = await client(config, ctx);
    const me = await gl.get('/user');
    return { ok: true, message: `Connected to ${gl.label} as @${me.username}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const warn = ctx.warn ?? (() => {});
  const gl = await client(config, ctx);
  const me = await gl.get('/user');
  const items = [];

  const reviews = await gl.get(`/merge_requests?state=opened&scope=all&reviewer_username=${encodeURIComponent(me.username)}&per_page=50`);
  for (const mr of reviews ?? []) {
    const signal = { requester: mr.author?.username ?? null, team: null, draft: !!(mr.draft || mr.work_in_progress), ageDays: daysSince(now, mr.created_at) };
    const r = rank('review-request', signal);
    items.push(createItem({
      id: `gitlab:review:${ref(mr)}`, source: id, kind: 'review-request', title: short(mr), url: mr.web_url,
      why: r.why, urgency: r.urgency, updatedAt: mr.updated_at,
      meta: { rule: r.rule, fingerprint: mr.sha ?? mr.updated_at, fields: { 'Merge request': ref(mr), Author: mr.author?.username ? `@${mr.author.username}` : 'unknown', Draft: signal.draft ? 'yes' : 'no' } },
    }));
  }

  const mine = await gl.get('/merge_requests?state=opened&scope=created_by_me&per_page=30');
  const detailed = await mapLimit(mine ?? [], 6, async (mr) => {
    try { return await gl.get(`/projects/${mr.project_id}/merge_requests/${mr.iid}`); } catch (err) { warn(`${ref(mr)}: ${err.message}`); return null; }
  });
  for (const mr of detailed.filter(Boolean)) {
    const failing = ['failed', 'canceled'].includes(mr.head_pipeline?.status) ? [`pipeline ${mr.head_pipeline.status}`] : [];
    const conflict = !!mr.has_conflicts;
    if (!failing.length && !conflict) continue;
    const signal = { draft: !!(mr.draft || mr.work_in_progress), failing, changesBy: [], conflict, base: mr.target_branch ?? null, ageDays: daysSince(now, mr.updated_at) };
    const r = rank('my-pr', signal);
    items.push(createItem({
      id: `gitlab:mr:${ref(mr)}`, source: id, kind: 'my-pr', title: short(mr), url: mr.web_url,
      why: r.why, urgency: r.urgency, updatedAt: mr.updated_at,
      meta: { rule: r.rule, fingerprint: [mr.sha, failing.join(','), conflict].join('|'), fields: { 'Merge request': ref(mr), Branch: `${mr.source_branch} → ${mr.target_branch}`, Pipeline: mr.head_pipeline?.status ?? 'none', Conflicts: conflict ? 'yes' : 'no' } },
    }));
  }

  const issues = await gl.get('/issues?state=opened&scope=assigned_to_me&per_page=50');
  for (const it of issues ?? []) {
    const due = daysUntilDate(it.due_date ?? it.milestone?.due_date, now);
    const signal = { milestone: it.milestone?.title ?? (it.due_date ? 'its due date' : null), dueDays: due, priorityLabels: priorityLabels(it.labels ?? []), ageDays: daysSince(now, it.updated_at) };
    const r = rank('issue', signal);
    items.push(createItem({
      id: `gitlab:issue:${it.references?.full ?? `${it.project_id}#${it.iid}`}`, source: id, kind: 'issue',
      title: `${(it.references?.full ?? '').split('/').pop() || `#${it.iid}`} · ${it.title}`, url: it.web_url,
      why: r.why, urgency: r.urgency, updatedAt: it.updated_at,
      meta: { rule: r.rule, fingerprint: it.updated_at, fields: { Issue: it.references?.full ?? `#${it.iid}`, Labels: (it.labels ?? []).join(', ') || 'none', Due: it.due_date ?? it.milestone?.due_date ?? 'no due date' } },
    }));
  }
  ctx.summary?.(`@${me.username} · ${plural(reviews?.length ?? 0, 'review')} · ${plural(issues?.length ?? 0, 'issue')}`);
  return items;
}
