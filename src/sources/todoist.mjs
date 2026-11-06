// Todoist: tasks that are overdue, due this week, or priority 1 (Todoist API v1).
// An API token from Todoist's settings, kept in your keychain.
//
// Two-way, opt-in: with "Sync done" on, Done in Birddog closes the task in Todoist
// (POST /tasks/{id}/close; a recurring task moves to its next date, as in Todoist),
// and Undo reopens it. Todoist tokens can't be limited to reading, so Birddog only
// writes when Sync done is on. See tasklib.mjs.

import { plural } from '../rules.mjs';
import { assertSync, CAPABILITIES, normalizeTaskSettings, taskItem, wanted } from './tasklib.mjs';
import { daysUntilDate, jsonClient, tokenSetup } from './web.mjs';

export const id = 'todoist';
export const name = 'Todoist';
export const description = 'Tasks that are overdue, due this week, or priority 1. Done in Birddog can close them in Todoist.';
export const enabledByDefault = false;
export const capabilities = CAPABILITIES;
export const secretFields = Object.freeze({ token: 'todoist-token' });
export const setup = {
  ...tokenSetup({
    fields: [],
    token: { label: 'API token', help: 'https://app.todoist.com/app/settings/integrations/developer', placeholder: 'from Settings → Integrations → Developer' },
    notes: 'Todoist → Settings → Integrations → Developer → API token. Todoist tokens can do everything you can, so Birddog only writes when you switch on Sync done.',
  }),
  syncNote: 'Your token already allows it; nothing to sign in again.',
};
export const normalizeSettings = normalizeTaskSettings;

const API = 'https://api.todoist.com/api/v1';
const MAX_PAGES = 10;

async function client(ctx) {
  const token = await ctx.secret?.(secretFields.token);
  if (!token) throw new Error('Add your Todoist API token in setup.');
  return { token, http: jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'Todoist', headers: { authorization: `Bearer ${token}` }, fix: 'Copy the API token from Todoist\'s settings again and update it in setup.' }) };
}

/** Todoist priority 4 is what the app shows as P1. */
export const isTop = (t) => Number(t.priority) === 4;

export async function test(config = {}, ctx = {}) {
  try {
    const { http } = await client(ctx);
    const me = await http.get(`${API}/user`);
    return { ok: true, message: `Connected to Todoist as ${me?.full_name || me?.email || 'you'}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const { http } = await client(ctx);
  // Todoist filters the list itself; showAll takes every active task instead.
  const path = config.showAll ? '/tasks' : '/tasks/filter';
  const base = config.showAll ? {} : { query: 'overdue | 7 days | p1' };
  const tasks = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ ...base, limit: '200', ...(cursor ? { cursor } : {}) });
    const r = await http.get(`${API}${path}?${q}`);
    tasks.push(...(r?.results ?? []));
    cursor = r?.next_cursor ?? null;
    if (!cursor) break;
  }
  const projects = new Map(((await http.get(`${API}/projects?limit=200`).catch(() => null))?.results ?? []).map((p) => [p.id, p.name]));
  const items = [];
  for (const t of tasks) {
    if (t.checked || t.is_deleted) continue;
    const due = (/^\d{4}-\d{2}-\d{2}/.exec(t.due?.date ?? t.deadline?.date ?? '') ?? [null])[0];
    const important = isTop(t);
    if (!wanted({ dueDays: daysUntilDate(due, now), important }, config)) continue;
    items.push(taskItem({
      source: id, key: t.id, title: String(t.content ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'), url: `https://app.todoist.com/app/task/${encodeURIComponent(t.id)}`,
      list: projects.get(t.project_id) ?? null, due, important, importantLabel: 'P1', updatedAt: t.updated_at ?? t.added_at, ref: { task: t.id, recurring: !!t.due?.is_recurring },
    }, now));
  }
  ctx.summary?.(`${plural(items.length, 'task')} need you`);
  return items;
}

export async function complete(item, ctx = {}, done = true, config = {}) {
  assertSync(config, name);
  const ref = item?.meta?.task;
  if (!ref?.task) throw new Error('This item has no Todoist task to update.');
  const { token } = await client(ctx);
  const res = await (ctx.fetch ?? fetch)(`${API}/tasks/${encodeURIComponent(ref.task)}/${done ? 'close' : 'reopen'}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Todoist refused (HTTP ${res.status})`);
}
