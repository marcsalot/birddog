// A small iCalendar (RFC 5545) reader: enough to turn a calendar feed into the
// meetings of the next day or two. No dependencies.
//
//   parseCalendar(text)            → { events, warnings }
//   expand(events, { from, to })   → occurrences in that window, recurring events expanded
//
// Supported: line folding and escapes, UTC / TZID / floating times, all-day
// events, DURATION, RRULE (DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, COUNT,
// UNTIL, BYDAY incl. "2MO"/"-1FR", BYMONTHDAY, BYMONTH, WKST), EXDATE, RDATE,
// and moved or cancelled instances (RECURRENCE-ID). Time zones come from the
// IANA database built into Node, with Windows zone names mapped.

const DAY = 86_400_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_CANDIDATES = 200_000; // safety nets against pathological rules
const MAX_PERIODS = 100_000;  // e.g. BYMONTHDAY=31;BYMONTH=2 matches nothing, ever

// Outlook and Exchange often write Windows zone names.
const WINDOWS_ZONES = {
  'UTC': 'UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Helsinki',
  'GTB Standard Time': 'Europe/Bucharest', 'Russian Standard Time': 'Europe/Moscow', 'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem', 'Arabian Standard Time': 'Asia/Dubai', 'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul', 'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Pacific Standard Time': 'America/Bogota', 'Central Standard Time (Mexico)': 'America/Mexico_City', 'South Africa Standard Time': 'Africa/Johannesburg',
};

// ---------------------------------------------------------------------------
// Lines and properties

/** Undo line folding (a line break followed by a space or tab continues the line). */
export function unfold(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.trim());
}

/** "DTSTART;TZID=\"Europe/Berlin\":20261103T090000" → { name, params, value } */
export function parseLine(line) {
  let i = 0;
  const read = (stops) => {
    let out = '';
    while (i < line.length && !stops.includes(line[i])) out += line[i++];
    return out;
  };
  const name = read([';', ':']).toUpperCase();
  const params = {};
  while (line[i] === ';') {
    i++;
    const key = read(['=', ';', ':']).toUpperCase();
    let val = '';
    if (line[i] === '=') {
      i++;
      while (i < line.length && line[i] !== ';' && line[i] !== ':') {
        if (line[i] === '"') { i++; val += read(['"']); i++; } else val += line[i++];
      }
    }
    params[key] = val;
  }
  return { name, params, value: line[i] === ':' ? line.slice(i + 1) : '' };
}

export const unescapeText = (s) => s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

// ---------------------------------------------------------------------------
// Time zones

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return fmtCache.get(tz);
}

export function isZone(tz) {
  try { formatter(tz); return true; } catch { fmtCache.delete(tz); return false; }
}

/** UTC offset of `tz` at instant `t`, in ms. */
function offsetAt(tz, t) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

/**
 * A TZID → an IANA zone Node knows, or null.
 * Handles plain IANA names, Windows names, and prefixed ids like "/mozilla.org/…/Europe/Berlin".
 */
export function resolveZone(tzid, vtimezones = {}) {
  if (!tzid) return null;
  const id = tzid.trim();
  if (WINDOWS_ZONES[id]) return WINDOWS_ZONES[id];
  if (isZone(id)) return id;
  const loc = vtimezones[id]?.location;
  if (loc && isZone(loc)) return loc;
  const m = /([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/.exec(id);
  if (m && isZone(m[1])) return m[1];
  return null;
}

/** Wall-clock time in a zone → epoch ms. zone: 'UTC', an IANA name, a fixed offset in ms, or null (this machine's local time). */
export function toEpoch(w, zone) {
  if (zone === 'UTC') return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  if (typeof zone === 'number') return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - zone;
  if (!zone) return new Date(w.y, w.m - 1, w.d, w.h, w.mi, w.s).getTime();
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  let t = guess - offsetAt(zone, guess);
  const second = guess - offsetAt(zone, t);
  if (second !== t) t = second; // crossed a DST change
  return t;
}

// ---------------------------------------------------------------------------
// Dates

/** Parse a DATE or DATE-TIME value. Returns { w, allDay, zone } where w is wall-clock time. */
export function parseDate(value, params = {}, zoneOf = () => null) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const w = { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  if (params.VALUE === 'DATE' || m[4] === undefined) return { w, allDay: true, zone: null };
  if (m[7]) return { w, allDay: false, zone: 'UTC' };
  return { w, allDay: false, zone: params.TZID ? zoneOf(params.TZID) : null };
}

export function parseDuration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const ms = (((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 + +(m[4] ?? 0)) * 60 + +(m[5] ?? 0)) * 60_000 + +(m[6] ?? 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// Day numbers: days since 1970-01-01 for a calendar date, independent of zones.
const dayNum = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY);
const fromDayNum = (n) => { const x = new Date(n * DAY); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
const weekday = (n) => ((n % 7) + 7 + 4) % 7; // 1970-01-01 was a Thursday
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// ---------------------------------------------------------------------------
// Parsing a calendar

export function parseRule(value) {
  const r = {};
  for (const part of String(value).split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) r[k.toUpperCase()] = v;
  }
  return r;
}

export function parseCalendar(text) {
  const warnings = [];
  const vtimezones = {};
  const raw = [];
  const stack = [];
  let cur = null;
  let tz = null;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (p.name === 'BEGIN') {
      const kind = p.value.toUpperCase();
      stack.push(kind);
      if (kind === 'VEVENT') cur = { props: [] };
      if (kind === 'VTIMEZONE') tz = { id: null, location: null, offsets: [] };
      continue;
    }
    if (p.name === 'END') {
      const kind = stack.pop();
      if (kind === 'VEVENT' && cur) { raw.push(cur); cur = null; }
      if (kind === 'VTIMEZONE' && tz) { if (tz.id) vtimezones[tz.id] = tz; tz = null; }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === 'VEVENT' && cur) cur.props.push(p); // properties of a nested VALARM are skipped
    if (tz) {
      if (top === 'VTIMEZONE' && p.name === 'TZID') tz.id = p.value;
      if (top === 'VTIMEZONE' && p.name === 'X-LIC-LOCATION') tz.location = p.value;
      if ((top === 'STANDARD') && p.name === 'TZOFFSETTO') tz.offsets.push(p.value);
    }
  }
  if (!stack.length && !raw.length && !/BEGIN:VCALENDAR/i.test(text)) warnings.push('This does not look like an iCalendar (.ics) file');

  const unknownZones = new Set();
  const fixedOffset = (id) => {
    const o = /^([+-])(\d{2})(\d{2})$/.exec(vtimezones[id]?.offsets?.[0] ?? '');
    return o ? (o[1] === '-' ? -1 : 1) * (+o[2] * 60 + +o[3]) * 60_000 : null;
  };
  const zoneOf = (tzid) => {
    const z = resolveZone(tzid, vtimezones);
    if (z) return z;
    unknownZones.add(tzid);
    return fixedOffset(tzid); // the zone's standard offset, without daylight saving; else local time
  };

  const events = raw.map(({ props }) => {
    const one = (n) => props.find((x) => x.name === n);
    const all = (n) => props.filter((x) => x.name === n);
    const date = (p) => (p ? parseDate(p.value, p.params, zoneOf) : null);
    const dates = (n) => all(n).flatMap((p) => p.value.split(',').map((v) => parseDate(v, p.params, zoneOf)).filter(Boolean));
    const text = (n) => (one(n) ? unescapeText(one(n).value) : null);
    return {
      uid: one('UID')?.value ?? null,
      summary: text('SUMMARY') ?? '(no title)',
      description: text('DESCRIPTION'),
      location: text('LOCATION'),
      url: one('URL')?.value?.trim() || null,
      status: one('STATUS')?.value?.toUpperCase() ?? null,
      organizer: one('ORGANIZER') ? (one('ORGANIZER').params.CN || one('ORGANIZER').value.replace(/^mailto:/i, '')) : null,
      attendees: all('ATTENDEE').map((a) => ({ email: a.value.replace(/^mailto:/i, '').toLowerCase(), partstat: (a.params.PARTSTAT ?? '').toUpperCase() })),
      start: date(one('DTSTART')),
      end: date(one('DTEND')),
      duration: one('DURATION') ? parseDuration(one('DURATION').value) : null,
      rrule: one('RRULE') ? parseRule(one('RRULE').value) : null,
      exdates: dates('EXDATE'),
      rdates: dates('RDATE'),
      recurrenceId: date(one('RECURRENCE-ID')),
    };
  }).filter((e) => e.start);
  for (const z of unknownZones) warnings.push(`Unknown time zone "${z}"; using its standard offset or local time`);
  return { events, warnings };
}

// ---------------------------------------------------------------------------
// Expanding recurring events

const epochOf = (d) => toEpoch(d.w, d.allDay ? null : d.zone);

/** Calendar dates (day numbers) a rule produces, in order, starting at the event's first day. */
function* ruleDays(rule, startDay) {
  const freq = rule.FREQ;
  const interval = Math.max(1, parseInt(rule.INTERVAL ?? '1', 10) || 1);
  const byDay = rule.BYDAY ? rule.BYDAY.split(',').map((x) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim().toUpperCase());
    return m ? { n: m[1] ? +m[1] : 0, wd: WEEKDAYS.indexOf(m[2]) } : null;
  }).filter(Boolean) : null;
  const byMonthDay = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number).filter((n) => n && Math.abs(n) <= 31) : null;
  const byMonth = rule.BYMONTH ? rule.BYMONTH.split(',').map(Number).filter((n) => n >= 1 && n <= 12) : null;
  const start = fromDayNum(startDay);
  const okDay = (n) => {
    const { m } = fromDayNum(n);
    if (byMonth && !byMonth.includes(m)) return false;
    if (byDay && freq === 'DAILY' && !byDay.some((b) => b.wd === weekday(n))) return false;
    if (byMonthDay && (freq === 'DAILY' || freq === 'WEEKLY')) {
      const { y, d } = fromDayNum(n);
      const dim = daysInMonth(y, m);
      if (!byMonthDay.some((x) => (x > 0 ? x : dim + x + 1) === d)) return false;
    }
    return true;
  };
  /** Days of one month that match BYDAY / BYMONTHDAY (or the start's day of month). */
  const monthDays = (y, m) => {
    const dim = daysInMonth(y, m);
    const first = dayNum(y, m, 1);
    let days;
    if (byMonthDay) days = byMonthDay.map((x) => (x > 0 ? x : dim + x + 1)).filter((d) => d >= 1 && d <= dim).map((d) => first + d - 1);
    else if (byDay) days = null;
    else days = start.d <= dim ? [first + start.d - 1] : [];
    if (byDay) {
      const hits = [];
      for (const b of byDay) {
        const matching = [];
        for (let d = 0; d < dim; d++) if (weekday(first + d) === b.wd) matching.push(first + d);
        if (!b.n) hits.push(...matching);
        else { const pick = b.n > 0 ? matching[b.n - 1] : matching[matching.length + b.n]; if (pick !== undefined) hits.push(pick); }
      }
      days = days ? days.filter((d) => hits.includes(d)) : hits;
    }
    return [...new Set(days)].sort((a, b) => a - b);
  };

  if (freq === 'DAILY') {
    for (let i = 0, n = startDay; i < MAX_PERIODS; i++, n += interval) if (okDay(n)) yield n;
  } else if (freq === 'WEEKLY') {
    const wkst = WEEKDAYS.indexOf((rule.WKST ?? 'MO').toUpperCase());
    const weekStart = startDay - ((weekday(startDay) - (wkst < 0 ? 1 : wkst) + 7) % 7);
    const wds = byDay ? byDay.map((b) => b.wd) : [weekday(startDay)];
    for (let i = 0, w = weekStart; i < MAX_PERIODS; i++, w += 7 * interval) {
      const days = [];
      for (let i = 0; i < 7; i++) if (wds.includes(weekday(w + i))) days.push(w + i);
      for (const n of days) if (okDay(n)) yield n;
    }
  } else if (freq === 'MONTHLY') {
    for (let k = 0; k < MAX_PERIODS; k += interval) {
      const y = start.y + Math.floor((start.m - 1 + k) / 12);
      const m = ((start.m - 1 + k) % 12) + 1;
      if (byMonth && !byMonth.includes(m)) continue;
      yield* monthDays(y, m);
    }
  } else if (freq === 'YEARLY') {
    for (let y = start.y; y < start.y + 10_000; y += interval) {
      for (const m of byMonth ?? [start.m]) yield* monthDays(y, m);
    }
  }
}

/**
 * Occurrences of `events` that overlap [from, to). Each is
 * { event, start, end, allDay, recurring } with start/end in epoch ms.
 */
export function expand(events, { from, to }) {
  const out = [];
  const overrides = new Map(); // uid → Map(original start epoch → override event)
  for (const e of events) {
    if (!e.recurrenceId || !e.uid) continue;
    if (!overrides.has(e.uid)) overrides.set(e.uid, new Map());
    overrides.get(e.uid).set(epochOf(e.recurrenceId), e);
  }

  const lengthOf = (e) => {
    if (e.end) return Math.max(0, epochOf(e.end) - epochOf(e.start));
    if (e.duration !== null) return e.duration;
    return e.start.allDay ? DAY : 0;
  };
  const push = (e, start, recurring) => {
    if (e.status === 'CANCELLED') return;
    const end = start + lengthOf(e);
    if (end > from && start < to) out.push({ event: e, start, end: end === start ? start : end, allDay: e.start.allDay, recurring });
    else if (end === start && start >= from && start < to) out.push({ event: e, start, end, allDay: e.start.allDay, recurring });
  };

  for (const e of events) {
    // A moved or cancelled instance stands on its own; its series skips the original slot.
    if (e.recurrenceId) { if (e.uid) push(e, epochOf(e.start), true); continue; }
    const moved = overrides.get(e.uid);
    const first = epochOf(e.start);
    if (!e.rrule && !e.rdates.length) { push(e, first, false); continue; }

    const excluded = new Set(e.exdates.map(epochOf));
    const at = (n) => {
      const d = fromDayNum(n);
      return toEpoch({ ...e.start.w, y: d.y, m: d.m, d: d.d }, e.start.allDay ? null : e.start.zone);
    };
    const instance = (t) => {
      if (excluded.has(t) || moved?.has(t)) return;
      push(e, t, true);
    };

    const len = lengthOf(e);
    const seen = new Set();
    if (e.rrule && ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(e.rrule.FREQ)) {
      const count = e.rrule.COUNT ? parseInt(e.rrule.COUNT, 10) : Infinity;
      const until = e.rrule.UNTIL ? parseDate(e.rrule.UNTIL, {}, () => e.start.zone) : null;
      const untilT = until ? (until.allDay ? toEpoch({ ...until.w, h: 23, mi: 59, s: 59 }, e.start.allDay ? null : e.start.zone) : epochOf(until)) : Infinity;
      const startDay = dayNum(e.start.w.y, e.start.w.m, e.start.w.d);
      let n = 0;
      let tries = 0;
      for (const day of ruleDays(e.rrule, startDay)) {
        if (++tries > MAX_CANDIDATES) break;
        if (day < startDay) continue;
        const t = at(day);
        if (t < first) continue;
        if (t > untilT || n >= count || t >= to) break;
        n++;
        seen.add(t);
        if (t + Math.max(len, 1) > from) instance(t);
      }
    } else if (e.rrule) {
      push(e, first, false); // FREQ we don't expand (e.g. HOURLY): show the first one
      seen.add(first);
    }
    for (const r of e.rdates) { const t = epochOf(r); if (!seen.has(t)) { seen.add(t); instance(t); } }
    if (!seen.has(first) && !e.rrule) instance(first);
  }
  return out.sort((a, b) => a.start - b.start);
}
