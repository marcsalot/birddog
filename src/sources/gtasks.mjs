// Google Tasks: your open tasks (the ones in Gmail's and Google Calendar's Tasks
// panel), with "Sign in with Google Tasks" (the "gtasks" sign-in on Birddog's Google
// app, scope tasks.readonly).
//
// Two-way, opt-in: switch on "Sync done" and Birddog asks for the tasks scope at your
// next sign-in. Then Done in Birddog completes the task in Google Tasks, and Undo
// reopens it. See tasklib.mjs.

import { plural } from '../rules.mjs';
import { mapLimit } from './http.mjs';
import { assertSync, CAPABILITIES, normalizeTaskSettings, taskItem, wanted } from './tasklib.mjs';
import { daysUntilDate, jsonClient } from './web.mjs';

export const id = 'gtasks';
export const name = 'Google Tasks';
export const description = 'Tasks from Gmail and Google Calendar that are overdue or due this week. Done in Birddog can complete them.';
export const enabledByDefault = false;
export const capabilities = CAPABILITIES;
export const WRITE_SCOPE = 'https://www.googleapis.com/auth/tasks';
export const setup = Object.freeze({
  oauthOnly: true,
  oauth: 'gtasks',
  fields: [],
  token: null,
  notes: 'Reads your task lists (tasks.readonly). Google Tasks has no "important" flag, so Birddog lists what\'s overdue or due within a week.',
  syncNote: 'Turning this on asks Google for permission to change tasks the next time you sign in.',
});
export const normalizeSettings = normalizeTaskSettings;

const API = 'https://tasks.googleapis.com/tasks/v1';

async function client(ctx) {
  if (!ctx.oauth) throw new Error('Sign in with Google Tasks in setup.');
  const token = await ctx.oauth.accessToken('gtasks');
  return { token, http: jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'Google Tasks', headers: { authorization: `Bearer ${token}` }, fix: 'Sign in with Google Tasks again in setup.' }) };
}

export async function test(config = {}, ctx = {}) {
  try {
    const { http } = await client(ctx);
    const lists = (await http.get(`${API}/users/@me/lists?maxResults=100`))?.items ?? [];
    return { ok: true, message: `Connected to Google Tasks · ${plural(lists.length, 'list')}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const { http } = await client(ctx);
  const lists = (await http.get(`${API}/users/@me/lists?maxResults=100`))?.items ?? [];
  const q = new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: '100' });
  const perList = await mapLimit(lists, 3, async (l) => ((await http.get(`${API}/lists/${encodeURIComponent(l.id)}/tasks?${q}`).catch((e) => { ctx.warn?.(`Google Tasks ${l.title}: ${e.message}`); return null; }))?.items ?? []).map((t) => ({ l, t })));
  const items = [];
  for (const { l, t } of perList.flat()) {
    if (t.status === 'completed' || t.deleted || !t.title?.trim()) continue;
    const due = (/^\d{4}-\d{2}-\d{2}/.exec(t.due ?? '') ?? [null])[0]; // Google keeps only the date
    if (!wanted({ dueDays: daysUntilDate(due, now), important: false }, config)) continue;
    items.push(taskItem({ source: id, key: t.id, title: t.title, url: t.webViewLink ?? 'https://tasks.google.com/', list: l.title, due, important: false, updatedAt: t.updated, ref: { list: l.id, task: t.id } }, now));
  }
  ctx.summary?.(`${plural(lists.length, 'list')} · ${plural(items.length, 'task')} due`);
  return items;
}

export async function complete(item, ctx = {}, done = true, config = {}) {
  assertSync(config, name);
  const ref = item?.meta?.task;
  if (!ref?.list || !ref?.task) throw new Error('This item has no Google task to update.');
  const granted = await ctx.oauth?.grantedScopes?.('gtasks').catch(() => null);
  if (granted && !granted.includes(WRITE_SCOPE)) throw new Error('Birddog can\'t change Google Tasks yet: sign in with Google Tasks again (on its card) and allow changing tasks.');
  const { token } = await client(ctx);
  const res = await (ctx.fetch ?? fetch)(`${API}/lists/${encodeURIComponent(ref.list)}/tasks/${encodeURIComponent(ref.task)}`, {
    method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(done ? { status: 'completed' } : { status: 'needsAction', completed: null }), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google Tasks refused (HTTP ${res.status})`);
}
