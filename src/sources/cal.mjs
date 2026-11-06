// Calendar source: one unified list of meetings from every calendar you connect.
//
// It reads all of these that are set up, together: Google (sign-in), Outlook /
// Microsoft 365 (sign-in), iCloud (CalDAV), an iCal link or .ics file, and
// Thunderbird's calendars on this computer. A meeting that shows up in two of them
// (you were invited at work and at home) is listed once. One calendar failing is a
// warning; the others still show.
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
import { caldavClient, googleOccurrences, graphOccurrences } from './calendar-apis.mjs';
import { expand, parseCalendar } from './ical.mjs';
import { thunderbirdCalendars } from './thunderbird-cal.mjs';

export const id = 'cal';
export const name = 'Calendar';
export const description = 'Upcoming meetings from Google, Outlook, iCloud, Thunderbird and any iCal link, in one list.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ url: 'cal-url', caldavPassword: 'caldav-password' });

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

export const PROVIDERS = ['ics', 'google', 'microsoft', 'caldav'];

export function normalizeSettings(input = {}) {
  const out = {};
  if (input.provider !== undefined) {
    if (!PROVIDERS.includes(input.provider)) throw new TypeError(`provider must be one of ${PROVIDERS.join(', ')}`);
    out.provider = input.provider;
  }
  if (input.caldavUser !== undefined) {
    const u = String(input.caldavUser).trim();
    if (u && !/^[^\s@]+@[^\s@]+$/.test(u)) throw new TypeError('Enter your Apple ID email address');
    out.caldavUser = u;
  }
  if (input.caldavUrl !== undefined && String(input.caldavUrl).trim()) {
    let u;
    try { u = new URL(String(input.caldavUrl).trim()); } catch { throw new TypeError('That CalDAV address is not a link'); }
    if (u.protocol !== 'https:') throw new TypeError('The CalDAV address must start with https://');
    out.caldavUrl = u.toString();
  }
  // Only what the form sent changes, so switching to iCloud keeps a saved .ics path.
  if (input.file !== undefined || !Object.keys(input).length) {
    const file = String(input.file ?? '').trim();
    out.file = file ? tildify(expandHome(file)) : '';
  }
  if (input.thunderbird !== undefined) out.thunderbird = input.thunderbird === true || input.thunderbird === 'true' || input.thunderbird === 'on';
  if (input.thunderbirdProfile !== undefined) {
    const f = String(input.thunderbirdProfile).trim();
    if (f && !(path.isAbsolute(f) || f.startsWith('~'))) throw new TypeError('The Thunderbird profile folder must be a full path');
    out.thunderbirdProfile = f;
  }
  if (input.email !== undefined || !Object.keys(input).length) {
    const email = String(input.email ?? '').trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new TypeError('That email address does not look right');
    out.email = email;
  }
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

/** The window Birddog looks at: from now to the end of tomorrow. */
export function meetingWindow(now) {
  const today = localDay(now);
  return { from: now, to: addDays(today, 2) };
}

/** iCalendar text → plain occurrences (see calendar-apis.mjs for the shape). */
export function icsOccurrences(cals, { now, email = '', warn = () => {} }) {
  const out = [];
  for (const cal of cals) {
    const { events, warnings } = parseCalendar(cal.text);
    warnings.forEach((w) => warn(`${cal.label}: ${w}`));
    for (const o of expand(events, meetingWindow(now))) {
      const ev = o.event;
      out.push({
        uid: ev.uid ?? ev.summary, summary: ev.summary, location: ev.location, description: ev.description, url: ev.url, joinUrl: null,
        organizer: ev.organizer, declined: !!email && ev.attendees.some((a) => a.email === email && a.partstat === 'DECLINED'),
        start: o.start, end: o.end, allDay: o.allDay, recurring: o.recurring, label: cal.label,
      });
    }
  }
  return out;
}

/** Occurrences (from any back end) → meeting items for today and tomorrow. */
export function itemsFromOccurrences(occs, { now, label: defaultLabel = 'Calendar' }) {
  const today = localDay(now);
  const tomorrow = addDays(today, 1);
  const items = new Map();
  for (const o of occs) {
    if (o.end <= now && !(o.start === o.end && o.start >= now)) continue; // over
    if (o.declined) continue;
    const link = o.joinUrl && /^https?:\/\//i.test(o.joinUrl) ? o.joinUrl : meetingLink(o);
    const where = whereOf(o, link);
    const signal = {
      allDay: o.allDay, start: o.start, end: o.end, startsIn: o.start - now, endsIn: o.end - now,
      today: o.allDay ? o.start <= now && o.end > now && o.start < tomorrow : o.start < tomorrow,
      where,
    };
    if (!signal.today && o.start >= addDays(today, 2)) continue;
    const r = rank('meeting', signal);
    const cal = o.label ?? defaultLabel;
    const itemId = `cal:${hash(cal, o.uid ?? o.summary, String(o.start))}`;
    items.set(itemId, createItem({
      id: itemId,
      source: id,
      kind: 'meeting',
      title: `${o.allDay ? 'All day' : new Date(o.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${o.summary}`,
      url: link,
      why: r.why,
      urgency: r.urgency,
      updatedAt: o.start,
      meta: {
        rule: r.rule,
        fingerprint: [o.start, o.end, o.summary, o.location ?? ''].join('|'),
        startsAt: new Date(o.start).toISOString(),
        endsAt: new Date(o.end).toISOString(),
        allDay: o.allDay,
        fields: {
          When: timeRange(o),
          Where: where ?? 'not set',
          Join: link ? new URL(link).hostname : 'no link',
          Organizer: o.organizer ?? 'unknown',
          Repeats: o.recurring ? 'yes' : 'no',
          Calendar: cal,
        },
      },
    }));
  }
  return [...items.values()];
}

/** Turn calendar text into meeting items for today and tomorrow. Exported for tests. */
export function meetingItems(cals, { now, email = '', warn = () => {} }) {
  return itemsFromOccurrences(icsOccurrences(cals, { now, email, warn }), { now });
}

export const BACKENDS = Object.freeze(['google', 'microsoft', 'caldav', 'ics', 'thunderbird']);
export const BACKEND_NAMES = Object.freeze({ google: 'Google Calendar', microsoft: 'Outlook', caldav: 'iCloud', ics: 'iCal link or file', thunderbird: 'Thunderbird' });

/** Which calendars are set up. A sign-in counts when it's connected (or, without status, when it's the chosen provider). */
export async function backends(config = {}, ctx = {}) {
  const out = [];
  for (const p of ['google', 'microsoft']) {
    const st = ctx.oauth?.status ? await ctx.oauth.status(p).catch(() => null) : null;
    if (st ? st.connected : config.provider === p && !!ctx.oauth) out.push(p);
  }
  if (config.caldavUser && (await ctx.secret?.(secretFields.caldavPassword))) out.push('caldav');
  if (config.file || (await ctx.secret?.(secretFields.url))) out.push('ics');
  if (config.thunderbird === true) out.push('thunderbird');
  return out;
}

/** One back end → { label, occs, events }. */
async function readOne(kind, config, ctx) {
  const now = ctx.now ?? Date.now();
  const fetchImpl = ctx.fetch ?? fetch;
  const win = meetingWindow(now);
  if (kind === 'google' || kind === 'microsoft') {
    const token = await ctx.oauth.accessToken(kind);
    const occs = kind === 'google'
      ? await googleOccurrences({ fetchImpl, token, from: now - 86_400_000, to: win.to })
      : await graphOccurrences({ fetchImpl, token, from: now - 86_400_000, to: win.to });
    const conn = await ctx.oauth.connection?.(kind).catch(() => null);
    const label = conn?.account ? `${kind === 'google' ? 'Google' : 'Outlook'} · ${conn.account}` : kind === 'google' ? 'Google Calendar' : 'Outlook';
    return { label, occs: occs.map((o) => ({ ...o, label })), events: occs.length };
  }
  if (kind === 'caldav') {
    const password = await ctx.secret?.(secretFields.caldavPassword);
    const client = caldavClient({ fetchImpl, baseUrl: config.caldavUrl || 'https://caldav.icloud.com/', username: config.caldavUser, password });
    const cals = await client.calendars({ from: now - 86_400_000, to: win.to });
    const occs = icsOccurrences(cals, { now, email: config.email, warn: ctx.warn });
    return { label: client.label, occs, events: occs.length };
  }
  if (kind === 'thunderbird') {
    const cals = await thunderbirdCalendars({ profile: config.thunderbirdProfile || undefined, from: now - 86_400_000, to: win.to, thunderbird: ctx.thunderbird });
    let events = 0;
    for (const c of cals) events += parseCalendar(c.text).events.length;
    return { label: cals.length ? `Thunderbird (${plural(cals.length, 'calendar')})` : 'Thunderbird', occs: icsOccurrences(cals, { now, email: config.email, warn: ctx.warn }), events };
  }
  const cals = await readCalendars(config, ctx);
  let events = 0;
  for (const c of cals) events += parseCalendar(c.text).events.length;
  return { label: cals.map((c) => c.label).join(' + '), occs: icsOccurrences(cals, { now, email: config.email, warn: ctx.warn }), events };
}

/** The same meeting in two calendars (by title and time) is listed once, naming both. */
export function mergeOccurrences(occs) {
  const seen = new Map();
  for (const o of occs) {
    const k = `${String(o.summary ?? '').trim().toLowerCase()}|${o.start}|${o.end}|${!!o.allDay}`;
    const prev = seen.get(k);
    if (!prev) { seen.set(k, { ...o }); continue; }
    if (o.label && !String(prev.label ?? '').split(' + ').includes(o.label)) prev.label = `${prev.label} + ${o.label}`;
    prev.joinUrl ??= o.joinUrl;
    prev.declined = prev.declined && o.declined;
  }
  return [...seen.values()];
}

/** Read every calendar that's set up. Returns { label, occs, events, read }. */
async function readSource(config, ctx) {
  const kinds = await backends(config, ctx);
  if (!kinds.length) throw new Error('Add a calendar in setup: sign in with Google or Microsoft, iCloud, an iCal link or file, or Thunderbird.');
  const results = await Promise.allSettled(kinds.map((k) => readOne(k, config, ctx)));
  const ok = [];
  results.forEach((r, n) => {
    if (r.status === 'fulfilled') ok.push(r.value);
    else if (kinds.length > 1) (ctx.warn ?? (() => {}))(`${BACKEND_NAMES[kinds[n]]}: ${r.reason?.message ?? r.reason}`);
  });
  if (!ok.length) throw results[0].reason;
  return {
    label: ok.map((r) => r.label).join(' + '),
    occs: mergeOccurrences(ok.flatMap((r) => r.occs)),
    events: ok.reduce((n, r) => n + r.events, 0),
    read: kinds.filter((_, n) => results[n].status === 'fulfilled'),
  };
}

// ---------------------------------------------------------------------------
// Plugin interface

export async function test(config = {}, ctx = {}) {
  try {
    const now = ctx.now ?? Date.now();
    const src = await readSource(config, ctx);
    if (!src.events && src.read.length === 1 && src.read[0] === 'ics') return { ok: false, message: `${src.label}: no events found. Is this an iCal (.ics) link?` };
    const soon = itemsFromOccurrences(src.occs, { now, label: src.label }).length;
    return { ok: true, message: `Read ${plural(src.events, 'event')} from ${src.label} · ${plural(soon, 'meeting')} today or tomorrow` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const src = await readSource(config, ctx);
  const items = itemsFromOccurrences(src.occs, { now, label: src.label });
  const todayCount = items.filter((i) => i.urgency !== 'later' || i.meta.rule.id === 'meeting-all-day').length;
  ctx.summary?.(`${src.label} · ${todayCount} today · ${items.length - todayCount} tomorrow`);
  return items;
}
