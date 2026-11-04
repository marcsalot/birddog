// Calendar source.
//
// Reads an iCalendar feed (the "secret address in iCal format" from Google, Outlook,
// Fastmail, iCloud…) and/or a local .ics file, and lists your meetings:
//   • now    in progress, or starting within 15 minutes
//   • today  later today
//   • later  all-day events today, and tomorrow's meetings
//
// The feed URL usually works like a password, so it lives in your OS keychain
// (secret "cal-url") and is never shown in the UI, the API or error messages.
// Read-only: one GET per refresh.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expandHome, tildify } from '../config.mjs';
import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { getText } from './http.mjs';
import { expand, parseCalendar } from './ical.mjs';

export const id = 'cal';
export const name = 'Calendar';
export const description = 'Upcoming meetings from any iCal link or .ics file, so nothing sneaks up on you.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ url: 'cal-url' });

const MEETING_HOSTS = /(^|\.)(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|gotomeeting\.com|chime\.aws|around\.co)$/i;
const LINK = /https?:\/\/[^\s<>"'()[\]]+/gi;

// ---------------------------------------------------------------------------
// Settings

/** webcal:// → https://; only https (or a local http server) so the secret link isn't sent in the clear. */
export function normalizeFeedUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new TypeError('Paste your calendar\'s iCal link');
  s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch { throw new TypeError('That is not a link. Paste the full iCal address (it usually ends in .ics)'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new TypeError('The calendar link must start with https:// (or webcal://)');
  return u.toString();
}

/** Called by the server for the secret fields before they are tested or stored. */
export function validateSecrets(values) {
  const out = { ...values };
  if (out[secretFields.url]) out[secretFields.url] = normalizeFeedUrl(out[secretFields.url]);
  return out;
}

export function normalizeSettings(input = {}) {
  const out = {};
  const file = String(input.file ?? '').trim();
  out.file = file ? tildify(expandHome(file)) : '';
  const email = String(input.email ?? '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new TypeError('That email address does not look right');
  out.email = email;
  return out;
}

// ---------------------------------------------------------------------------
// Reading calendars

async function readCalendars(config, ctx) {
  const url = await ctx.secret?.(secretFields.url);
  const file = config.file ? String(config.file) : '';
  if (!url && !file) throw new Error('Add a calendar link or an .ics file in setup.');
  const cals = [];
  if (url) {
    const host = new URL(url).host;
    const text = await getText(ctx.fetch ?? fetch, url, { headers: { accept: 'text/calendar, */*', 'user-agent': 'birddog' }, label: host });
    cals.push({ label: host, text });
  }
  if (file) {
    let text;
    try { text = await fs.readFile(expandHome(file), 'utf8'); } catch (err) {
      throw new Error(err.code === 'ENOENT' ? `${file} does not exist` : `Could not read ${file}: ${err.message}`);
    }
    cals.push({ label: path.basename(file), text });
  }
  return cals;
}

/** The best "join" link: a known meeting host first, then the URL property. Always http(s). */
export function meetingLink(ev) {
  const found = [ev.location, ev.description].filter(Boolean).flatMap((t) => t.match(LINK) ?? []);
  const isMeeting = (l) => { try { return MEETING_HOSTS.test(new URL(l).hostname); } catch { return false; } };
  const safe = (l) => (l && /^https?:\/\//i.test(l) ? l.replace(/[.,;]+$/, '') : null);
  return safe(found.find(isMeeting)) ?? safe(ev.url) ?? safe(found.find((l) => ev.location?.includes(l))) ?? null;
}

function whereOf(ev, link) {
  const loc = ev.location?.replace(LINK, '').replace(/\s+/g, ' ').trim();
  if (loc) return loc.length > 60 ? `${loc.slice(0, 57)}…` : loc;
  if (!link) return null;
  const host = new URL(link).hostname;
  if (/zoom\.us$/.test(host)) return 'Zoom';
  if (/meet\.google\.com$/.test(host)) return 'Google Meet';
  if (/teams\.(microsoft|live)\.com$/.test(host)) return 'Teams';
  if (/webex\.com$/.test(host)) return 'Webex';
  return null;
}

const localDay = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const addDays = (dayStart, n) => { const d = new Date(dayStart); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
const hash = (...parts) => crypto.createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16);
const timeRange = (o) => {
  const day = new Date(o.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  if (o.allDay) return `${day}, all day`;
  const t = (x) => new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${t(o.start)}–${t(o.end)}`;
};

/** Turn calendar text into meeting items for today and tomorrow. Exported for tests. */
export function meetingItems(cals, { now, email = '', warn = () => {} }) {
  const today = localDay(now);
  const tomorrow = addDays(today, 1);
  const window = { from: now, to: addDays(today, 2) };
  const items = new Map();
  for (const cal of cals) {
    const { events, warnings } = parseCalendar(cal.text);
    warnings.forEach((w) => warn(`${cal.label}: ${w}`));
    for (const o of expand(events, window)) {
      const ev = o.event;
      if (o.end <= now && !(o.start === o.end && o.start >= now)) continue; // over
      if (email && ev.attendees.some((a) => a.email === email && a.partstat === 'DECLINED')) continue;
      const link = meetingLink(ev);
      const where = whereOf(ev, link);
      const signal = {
        allDay: o.allDay,
        start: o.start,
        end: o.end,
        startsIn: o.start - now,
        endsIn: o.end - now,
        today: o.allDay ? o.start <= now && o.end > now && o.start < tomorrow : o.start < tomorrow,
        where,
      };
      if (!signal.today && o.start >= addDays(today, 2)) continue;
      const r = rank('meeting', signal);
      const itemId = `cal:${hash(cal.label, ev.uid ?? ev.summary, String(o.start))}`;
      items.set(itemId, createItem({
        id: itemId,
        source: id,
        kind: 'meeting',
        title: `${o.allDay ? 'All day' : new Date(o.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${ev.summary}`,
        url: link,
        why: r.why,
        urgency: r.urgency,
        updatedAt: o.start,
        meta: {
          rule: r.rule,
          fingerprint: [o.start, o.end, ev.summary, ev.location ?? ''].join('|'),
          startsAt: new Date(o.start).toISOString(),
          endsAt: new Date(o.end).toISOString(),
          allDay: o.allDay,
          fields: {
            When: timeRange(o),
            Where: where ?? 'not set',
            Join: link ? new URL(link).hostname : 'no link',
            Organizer: ev.organizer ?? 'unknown',
            Repeats: o.recurring ? 'yes' : 'no',
            Calendar: cal.label,
          },
        },
      }));
    }
  }
  return [...items.values()];
}

// ---------------------------------------------------------------------------
// Plugin interface

export async function test(config = {}, ctx = {}) {
  try {
    const cals = await readCalendars(config, ctx);
    const now = ctx.now ?? Date.now();
    let events = 0;
    let warnings = [];
    for (const c of cals) { const p = parseCalendar(c.text); events += p.events.length; warnings = warnings.concat(p.warnings); }
    if (!events) return { ok: false, message: `${cals.map((c) => c.label).join(' and ')}: no events found. Is this an iCal (.ics) link?` };
    const soon = meetingItems(cals, { now, email: config.email }).length;
    return {
      ok: true,
      message: `Read ${plural(events, 'event')} from ${cals.map((c) => c.label).join(' and ')} · ${plural(soon, 'meeting')} today or tomorrow${warnings.length ? ` (${warnings[0]})` : ''}`,
    };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const cals = await readCalendars(config, ctx);
  const items = meetingItems(cals, { now, email: config.email, warn: ctx.warn });
  const todayCount = items.filter((i) => i.urgency !== 'later' || i.meta.rule.id === 'meeting-all-day').length;
  ctx.summary?.(`${cals.map((c) => c.label).join(' + ')} · ${todayCount} today · ${items.length - todayCount} tomorrow`);
  return items;
}

