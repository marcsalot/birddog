// What the task-list sources share (Microsoft To Do, Google Tasks, Todoist).
//
// Reading: open tasks that are overdue, due in the next week, or marked important /
// top priority ("showAll" lists every open task). Ranked by the task rules in rules.mjs.
//
// Two-way: a task source exports capabilities ['complete'] and complete(item, ctx, done).
// With "Sync done" switched on for that source (sources.<id>.syncDone, off by default),
// marking a task Done in Birddog completes it in the app, and Undo / Restore reopens it.
// Completing it in the app clears it from Birddog on the next refresh. Snooze stays in
// Birddog. Nothing else is ever written.

import { createItem } from '../items.mjs';
import { rank } from '../rules.mjs';
import { daysUntilDate } from './web.mjs';

export const SOON_DAYS = 7;
export const CAPABILITIES = Object.freeze(['complete']);

/** Settings every task source takes. syncDone is switched from the card, not this form. */
export function normalizeTaskSettings(input = {}) {
  return { showAll: input.showAll === true || input.showAll === 'true' || input.showAll === 'on' };
}

/** Should this task be listed? */
export function wanted({ dueDays, important }, { showAll = false } = {}) {
  return showAll || important || (dueDays !== null && dueDays < SOON_DAYS);
}

/**
 * One task → an inbox item.
 * @param {object} t  { source, key, title, url, list, due ("YYYY-MM-DD" or null), important, importantLabel, updatedAt, ref (ids for complete()) }
 */
export function taskItem(t, now) {
  const dueDays = daysUntilDate(t.due, now);
  const s = { dueDays, important: !!t.important, importantLabel: t.importantLabel ?? null, list: t.list ?? null };
  const r = rank('task', s);
  return createItem({
    id: `${t.source}:${t.key}`, source: t.source, kind: 'task', title: t.title.slice(0, 160) || '(untitled task)',
    url: /^https:\/\//.test(t.url ?? '') ? t.url : null, why: r.why, urgency: r.urgency, updatedAt: t.updatedAt ?? new Date(now).toISOString(),
    meta: {
      rule: r.rule, fingerprint: [t.due ?? '', s.important, t.title].join('|'), task: t.ref,
      fields: { List: t.list ?? '—', Due: t.due ?? 'no due date', ...(t.important ? { Priority: t.importantLabel ?? 'important' } : {}) },
    },
  });
}

/** Syncing done back needs it switched on; the error says how. */
export function assertSync(config, name) {
  if (config.syncDone !== true) throw new Error(`Sync done is off for ${name}. Switch it on in Sources & settings.`);
}
