// Confluence Cloud: pages and comments that @mention you (last 7 days), and inline tasks
// assigned to you that aren't done, ranked by their due date.
//
// Your Atlassian site, email and an API token (the same kind Jira uses; one token works
// for both), kept in your keychain. Read-only: GET only.

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { mapLimit } from './http.mjs';
import { taskItem } from './tasklib.mjs';
import { baseUrl, daysSince, jsonClient, tokenSetup } from './web.mjs';

export const id = 'confluence';
export const name = 'Confluence';
export const description = 'Pages and comments that mention you, and tasks assigned to you.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'confluence-token' });
export const setup = tokenSetup({
  fields: [
    { key: 'site', label: 'Atlassian site', placeholder: 'https://acme.atlassian.net' },
    { key: 'email', label: 'Your Atlassian email', placeholder: 'you@acme.com' },
  ],
  token: { label: 'API token (the same kind as Jira\'s; one token works for both)', help: 'https://id.atlassian.com/manage-profile/security/api-tokens', placeholder: 'ATATT…' },
});

const WINDOW_DAYS = 7;

export function normalizeSettings(input = {}) {
  const site = baseUrl(input.site, '').replace(/\/wiki$/, '');
  const email = String(input.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new TypeError('Enter the email you sign in to Atlassian with');
  return { site, email };
}

async function client(config, ctx) {
  if (!config.site || !config.email) throw new Error('Add your Atlassian site and email in setup.');
  const token = await ctx.secret?.(secretFields.token);
  if (!token) throw new Error('Add an Atlassian API token in setup.');
  const basic = Buffer.from(`${config.email}:${token}`).toString('base64');
  return jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: new URL(config.site).host, headers: { authorization: `Basic ${basic}` }, fix: 'Make a new API token at id.atlassian.com and update it in setup.' });
}

const strip = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

export async function test(config = {}, ctx = {}) {
  try {
    const http = await client(config, ctx);
    const me = await http.get(`${config.site}/wiki/rest/api/user/current`);
    return { ok: true, message: `Connected to Confluence as ${me?.displayName ?? me?.publicName ?? config.email}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const http = await client(config, ctx);
  const wiki = `${config.site}/wiki`;
  const me = await http.get(`${wiki}/rest/api/user/current`);
  const items = [];

  // Mentions of you, newest first.
  const cql = `mention = currentUser() AND lastmodified >= now("-${WINDOW_DAYS}d") ORDER BY lastmodified DESC`;
  const found = await http.get(`${wiki}/rest/api/search?${new URLSearchParams({ cql, limit: '25', expand: 'content.version,content.container' })}`).catch((e) => { ctx.warn?.(`Confluence mentions: ${e.message}`); return null; });
  for (const r of found?.results ?? []) {
    const c = r.content ?? {};
    const by = c.version?.by?.displayName ?? c.version?.by?.publicName ?? null;
    if (c.version?.by?.accountId && c.version.by.accountId === me?.accountId) continue; // your own latest edit
    const at = r.lastModified ?? c.version?.when ?? new Date(now).toISOString();
    const s = { by, team: false, ageDays: daysSince(now, at), where: 'Confluence' };
    const rk = rank('mention', s);
    const where = c.type === 'comment' ? `Comment on ${c.container?.title ?? 'a page'}` : (c.title ?? r.title ?? 'Page');
    const link = c._links?.webui ? `${wiki}${c._links.webui}` : r.url ? `${wiki}${r.url}` : null;
    items.push(createItem({
      id: `confluence:mention:${c.id ?? r.url}`, source: id, kind: 'mention', title: `${where}${r.excerpt ? ` · ${strip(r.excerpt).slice(0, 90)}` : ''}`,
      url: /^https:\/\//.test(link ?? '') ? link : null, why: rk.why, urgency: rk.urgency, updatedAt: at,
      meta: { rule: rk.rule, fingerprint: String(c.version?.number ?? at), fields: { Where: where, From: by ?? 'someone', Space: r.resultGlobalContainer?.title ?? 'unknown' } },
    }));
  }

  // Tasks assigned to you (inline task lists on pages).
  const tasks = me?.accountId
    ? (await http.get(`${wiki}/api/v2/tasks?${new URLSearchParams({ 'assigned-to': me.accountId, status: 'incomplete', limit: '100', 'body-format': 'storage' })}`).catch((e) => { ctx.warn?.(`Confluence tasks: ${e.message}`); return null; }))?.results ?? []
    : [];
  const pageIds = [...new Set(tasks.map((t) => t.pageId).filter(Boolean))].slice(0, 30);
  const titles = new Map(await mapLimit(pageIds, 4, async (pid) => [pid, (await http.get(`${wiki}/api/v2/pages/${encodeURIComponent(pid)}`).catch(() => null))?.title ?? null]));
  for (const t of tasks) {
    const due = t.dueAt ? new Date(t.dueAt).toISOString().slice(0, 10) : null;
    const page = titles.get(t.pageId) ?? (t.blogPostId ? 'Blog post' : 'Page');
    items.push(taskItem({
      source: id, key: `task:${t.id}`, title: strip(t.body?.storage?.value) || 'Task', url: t.pageId ? `${wiki}/pages/viewpage.action?pageId=${encodeURIComponent(t.pageId)}` : null,
      list: page, due, important: false, updatedAt: t.updatedAt ?? t.createdAt, ref: { task: t.id },
    }, now));
  }
  ctx.summary?.(`${plural(items.filter((i) => i.kind === 'mention').length, 'mention')} · ${plural(tasks.length, 'task')} assigned`);
  return items;
}
