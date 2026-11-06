// Thunderbird's calendars, for the Calendar source: local calendars, and the offline
// copies Thunderbird keeps of Google, CalDAV and iCal calendars it's subscribed to.
//
// Thunderbird stores them in SQLite (calendar-data/local.sqlite, and cache.sqlite in
// older versions). Birddog copies the file to a temporary folder and reads the copy
// with Node's built-in node:sqlite (Node 22.13 or newer), so it never touches or locks
// Thunderbird's own file. Events are turned back into iCalendar text, so repeats,
// exceptions and time zones go through the same parser as every other calendar.
//
// Schema notes (Thunderbird's storage calendar):
//   cal_events     id, cal_id, title, flags, event_start/_end (µs since 1970, UTC; or
//                  wall-clock time when the zone is "floating"), recurrence_id for
//                  moved occurrences. flags: 0x8 all day, 0x10 repeats, 0x200 all-day
//                  recurrence id.
//   cal_properties item_id, key (LOCATION, DESCRIPTION, URL, STATUS…), value
//   cal_recurrence item_id, icalString ("RRULE:…", "EXDATE:…")
//   cal_attendees  item_id, icalString ("ATTENDEE;PARTSTAT=…:mailto:…")

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findProfile } from './thunderbird.mjs';

const ALL_DAY = 0x8;
const REPEATS = 0x10;
const RID_ALL_DAY = 0x200;
const DB_FILES = ['local.sqlite', 'cache.sqlite'];

async function sqlite() {
  try { return (await import('node:sqlite')).DatabaseSync; } catch {
    throw new Error(`Reading Thunderbird calendars needs Node 22.13 or newer (this is ${process.version}).`);
  }
}

/** prefs.js → { calendarId: { name, disabled } }. */
export function calendarNames(prefs) {
  const out = {};
  for (const m of String(prefs).matchAll(/user_pref\("calendar\.registry\.([^.]+)\.(name|disabled|type)",\s*("(?:[^"\\]|\\.)*"|true|false)\);/g)) {
    const [, id, key, raw] = m;
    let v = raw;
    if (raw.startsWith('"')) { try { v = JSON.parse(raw); } catch { v = raw.slice(1, -1); } } else v = raw === 'true';
    (out[id] ??= {})[key] = v;
  }
  return out;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** µs → an iCalendar date-time: UTC ("…Z"), floating wall-clock, or a DATE. */
export function icalTime(us, tz, allDay) {
  const d = new Date(Number(us) / 1000);
  const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  if (allDay) return { params: ';VALUE=DATE', value: ymd };
  const hms = `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return { params: '', value: tz === 'floating' ? ymd + hms : `${ymd}${hms}Z` };
}
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const line = (name, t) => `${name}${t.params}:${t.value}`;

/** Rows from one database → iCalendar text per calendar id. */
export function toIcs(db, { from, to }) {
  const has = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!has('cal_events')) return new Map();
  const fromUs = from * 1000;
  const toUs = to * 1000;
  const events = db.prepare(`SELECT cal_id, id, title, flags, event_start, event_start_tz, event_end, event_end_tz, recurrence_id, recurrence_id_tz
    FROM cal_events WHERE (flags & ${REPEATS}) != 0 OR recurrence_id IS NOT NULL OR (event_end >= ? AND event_start <= ?)`).all(fromUs, toUs);
  const keyOf = (calId, id) => `${calId}\0${id}`;
  const props = new Map();
  if (has('cal_properties')) {
    for (const p of db.prepare("SELECT cal_id, item_id, key, value, recurrence_id FROM cal_properties WHERE key IN ('LOCATION', 'DESCRIPTION', 'URL', 'STATUS')").all()) {
      const k = `${keyOf(p.cal_id, p.item_id)}\0${p.recurrence_id ?? ''}`;
      (props.get(k) ?? props.set(k, {}).get(k))[p.key] = p.value;
    }
  }
  const lines = (table) => {
    const m = new Map();
    if (!has(table)) return m;
    for (const r of db.prepare(`SELECT cal_id, item_id, icalString FROM ${table}`).all()) {
      const k = keyOf(r.cal_id, r.item_id);
      (m.get(k) ?? m.set(k, []).get(k)).push(String(r.icalString).trim());
    }
    return m;
  };
  const rules = lines('cal_recurrence');
  const attendees = lines('cal_attendees');
  const byCal = new Map();
  for (const e of events) {
    const allDay = (Number(e.flags) & ALL_DAY) !== 0;
    const k = keyOf(e.cal_id, e.id);
    const p = props.get(`${k}\0${e.recurrence_id ?? ''}`) ?? {};
    if (p.STATUS === 'CANCELLED' && e.recurrence_id === null) continue;
    const v = ['BEGIN:VEVENT', `UID:${esc(e.id)}`, `SUMMARY:${esc(e.title || '(no title)')}`,
      line('DTSTART', icalTime(e.event_start, e.event_start_tz, allDay)), line('DTEND', icalTime(e.event_end ?? e.event_start, e.event_end_tz, allDay))];
    if (e.recurrence_id !== null && e.recurrence_id !== undefined) v.push(line('RECURRENCE-ID', icalTime(e.recurrence_id, e.recurrence_id_tz, (Number(e.flags) & RID_ALL_DAY) !== 0)));
    for (const [key, val] of Object.entries(p)) v.push(`${key}:${esc(val)}`);
    if (e.recurrence_id === null || e.recurrence_id === undefined) v.push(...(rules.get(k) ?? []));
    v.push(...(attendees.get(k) ?? []), 'END:VEVENT');
    (byCal.get(e.cal_id) ?? byCal.set(e.cal_id, []).get(e.cal_id)).push(v.join('\r\n'));
  }
  const out = new Map();
  for (const [cal, vevents] of byCal) out.set(cal, `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Birddog//Thunderbird//EN\r\n${vevents.join('\r\n')}\r\nEND:VCALENDAR\r\n`);
  return out;
}

/**
 * Thunderbird's calendars as [{ label, text }] (iCalendar), for the Calendar source.
 * @param {object} o  { profile (optional folder), from, to (ms), thunderbird (test options) }
 */
export async function thunderbirdCalendars({ profile: folder, from, to, thunderbird: opts } = {}) {
  const DatabaseSync = await sqlite();
  const profile = await findProfile({ profile: folder }, opts);
  const names = calendarNames(await fs.readFile(path.join(profile, 'prefs.js'), 'utf8').catch(() => ''));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'birddog-tbcal-'));
  const merged = new Map();
  let found = 0;
  try {
    for (const f of DB_FILES) {
      const src = path.join(profile, 'calendar-data', f);
      const copy = path.join(tmp, f);
      try { await fs.copyFile(src, copy); } catch { continue; }
      found++;
      for (const ext of ['-wal', '-shm']) await fs.copyFile(src + ext, copy + ext).catch(() => {}); // the newest changes may be in the WAL
      const db = new DatabaseSync(copy);
      try { for (const [cal, text] of toIcs(db, { from, to })) if (!merged.has(cal)) merged.set(cal, text); } finally { db.close(); }
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  if (!found) throw new Error('Thunderbird has no calendars on this computer yet (no calendar-data folder in its profile).');
  return [...merged].filter(([cal]) => names[cal]?.disabled !== true).map(([cal, text]) => ({ label: `Thunderbird · ${names[cal]?.name ?? 'Calendar'}`, text }));
}
