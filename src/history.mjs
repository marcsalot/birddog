// A small local history for the overview charts: one row per day with how many
// items were open (and how urgent) and how many were marked done that day.
// Each refresh overwrites today's row, so a day keeps its last reading.
// history.json holds at most KEEP_DAYS rows. Nothing here leaves your machine.

import path from 'node:path';
import { readJson, writeJson } from './store.mjs';

const KEEP_DAYS = 60;

/** "2026-11-04" in this machine's time zone. */
export function localDate(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Counts for one day from triaged items (each with status open/done/snoozed). */
export function summarize(items, t) {
  const today = localDate(t);
  const row = { open: 0, now: 0, today: 0, later: 0, done: 0, snoozed: 0 };
  for (const i of items) {
    if (i.status === 'open') { row.open++; row[i.urgency]++; }
    else if (i.status === 'snoozed') row.snoozed++;
    else if (i.status === 'done' && i.doneAt && localDate(Date.parse(i.doneAt)) === today) row.done++;
  }
  return row;
}

export function createHistory({ dir, now = () => Date.now() }) {
  const file = path.join(dir, 'history.json');
  return {
    async record(items) {
      const t = now();
      const data = await readJson(file, { days: {} });
      data.days ??= {};
      data.days[localDate(t)] = { ...summarize(items, t), at: new Date(t).toISOString() };
      const keys = Object.keys(data.days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete data.days[k];
      await writeJson(file, data);
    },
    /** The last `n` days, oldest first; days without a reading are null. */
    async last(n = 14) {
      const data = await readJson(file, { days: {} });
      const t = now();
      const out = [];
      for (let i = n - 1; i >= 0; i--) {
        // Step back by calendar day, not 24 h, so daylight-saving changes don't skip a date.
        const d = new Date(t);
        d.setHours(12, 0, 0, 0);
        d.setDate(d.getDate() - i);
        const key = localDate(d.getTime());
        const row = data.days?.[key];
        out.push({ date: key, ...(row ? { open: row.open, now: row.now, today: row.today, later: row.later, done: row.done } : { missing: true }) });
      }
      return out;
    },
    /** Write whole days at once (the demo uses this to look lived-in). */
    async seed(rows) {
      const data = await readJson(file, { days: {} });
      for (const r of rows) data.days[r.date] = { open: r.open, now: r.now, today: r.today, later: r.later, done: r.done, snoozed: 0, at: `${r.date}T18:00:00.000Z` };
      await writeJson(file, data);
    },
  };
}

