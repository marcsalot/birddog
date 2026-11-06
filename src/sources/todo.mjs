// Microsoft To Do: your open tasks (Microsoft 365 work/school or personal accounts),
// through Microsoft Graph with "Sign in with Microsoft To Do" (the "mstodo" sign-in in
// src/auth/oauth.mjs, delegated Tasks.Read).
//
// Two-way, opt-in: switch on "Sync done" and Birddog asks for Tasks.ReadWrite at your
// next sign-in. Then Done in Birddog completes the task in To Do, and Undo reopens it.
// See tasklib.mjs.

import { plural } from '../rules.mjs';
import { mapLimit } from './http.mjs';
import { assertSync, CAPABILITIES, normalizeTaskSettings, taskItem, wanted } from './tasklib.mjs';
import { daysUntilDate, jsonClient } from './web.mjs';

export const id = 'todo';
export const name = 'Microsoft To Do';
export const description = 'Tasks that are overdue, due this week, or important. Done in Birddog can complete them in To Do.';
export const enabledByDefault = false;
export const capabilities = CAPABILITIES;
export const WRITE_SCOPE = 'Tasks.ReadWrite';
export const setup = Object.freeze({
  oauthOnly: true,
  oauth: 'mstodo',
  fields: [],
  token: null,
  notes: 'Work, school or personal Microsoft accounts. Birddog reads your task lists (Tasks.Read).',
  syncNote: `Turning this on asks Microsoft for permission to change tasks (${WRITE_SCOPE}) the next time you sign in.`,
});
export const normalizeSettings = normalizeTaskSettings;

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function client(ctx) {
  if (!ctx.oauth) throw new Error('Sign in with Microsoft To Do in setup.');
  const token = await ctx.oauth.accessToken('mstodo');
  return jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'Microsoft To Do', headers: { authorization: `Bearer ${token}` }, fix: 'Sign in with Microsoft To Do again in setup.' });
}

/** Graph's dueDateTime is a date in disguise ("2026-11-06T00:00:00.0000000", UTC). */
export const dueOf = (t) => (/^\d{4}-\d{2}-\d{2}/.exec(t.dueDateTime?.dateTime ?? '') ?? [null])[0];

export async function test(config = {}, ctx = {}) {
  try {
    const http = await client(ctx);
    const lists = (await http.get(`${GRAPH}/me/todo/lists`))?.value ?? [];
    return { ok: true, message: `Connected to Microsoft To Do · ${plural(lists.length, 'list')}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const http = await client(ctx);
  const lists = (await http.get(`${GRAPH}/me/todo/lists`))?.value ?? [];
  const q = new URLSearchParams({ $filter: "status ne 'completed'", $top: '100' });
  const perList = await mapLimit(lists, 3, async (l) => {
    const tasks = (await http.get(`${GRAPH}/me/todo/lists/${encodeURIComponent(l.id)}/tasks?${q}`).catch((e) => { ctx.warn?.(`To Do ${l.displayName}: ${e.message}`); return null; }))?.value ?? [];
    return tasks.map((t) => ({ l, t }));
  });
  const items = [];
  for (const { l, t } of perList.flat()) {
    const due = dueOf(t);
    const important = t.importance === 'high';
    if (!wanted({ dueDays: daysUntilDate(due, now), important }, config)) continue;
    items.push(taskItem({
      source: id, key: t.id, title: t.title ?? '', url: 'https://to-do.office.com/tasks/', list: l.displayName, due, important, importantLabel: 'important',
      updatedAt: t.lastModifiedDateTime, ref: { list: l.id, task: t.id },
    }, now));
  }
  ctx.summary?.(`${plural(lists.length, 'list')} · ${plural(items.length, 'task')} need you`);
  return items;
}

/** Complete (done = true) or reopen a task. Needs Sync done and Tasks.ReadWrite. */
export async function complete(item, ctx = {}, done = true, config = {}) {
  assertSync(config, name);
  const ref = item?.meta?.task;
  if (!ref?.list || !ref?.task) throw new Error('This item has no To Do task to update.');
  const granted = await ctx.oauth?.grantedScopes?.('mstodo').catch(() => null);
  if (granted && !granted.some((s) => s.toLowerCase() === WRITE_SCOPE.toLowerCase())) throw new Error(`Birddog can't change To Do tasks yet: sign in with Microsoft To Do again (on its card) and allow ${WRITE_SCOPE}.`);
  const token = await ctx.oauth.accessToken('mstodo');
  const res = await (ctx.fetch ?? fetch)(`${GRAPH}/me/todo/lists/${encodeURIComponent(ref.list)}/tasks/${encodeURIComponent(ref.task)}`, {
    method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: done ? 'completed' : 'notStarted' }), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Microsoft To Do refused (HTTP ${res.status})${res.status === 403 ? `: sign in again and allow ${WRITE_SCOPE}` : ''}`);
}
