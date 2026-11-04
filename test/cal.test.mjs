// Calendar fixtures are read as if this machine were in New York, on Tuesday 3 Nov 2026 at 09:50.
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cal from '../src/sources/cal.mjs';
import { expand, parseCalendar, parseLine, toEpoch, unfold } from '../src/sources/ical.mjs';
import { fakeFetch } from './helpers.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f) => fs.readFile(path.join(FIX, f), 'utf8');
const NOW = new Date(2026, 10, 3, 9, 50).getTime();
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const byTitle = (items) => Object.fromEntries(items.map((i) => [i.title, i]));

describe('iCalendar parsing', () => {
  it('unfolds lines, reads quoted parameters and unescapes text', () => {
    assert.deepEqual(unfold('A:one\r\n two\r\nB:x\n\tY\n'), ['A:onetwo', 'B:xY']);
    const p = parseLine('ATTENDEE;CN="Lopez, Ana";PARTSTAT=ACCEPTED:mailto:ana@acme.com');
    assert.equal(p.name, 'ATTENDEE');
    assert.deepEqual(p.params, { CN: 'Lopez, Ana', PARTSTAT: 'ACCEPTED' });
    assert.equal(p.value, 'mailto:ana@acme.com');
    const { events } = parseCalendar('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:a\\, b\; c\\nd\nDTSTART:20261103T150000Z\nEND:VEVENT\nEND:VCALENDAR');
    assert.equal(events[0].summary, 'a, b; c\nd');
  });

  it('converts zone wall-clock time to instants across daylight saving', () => {
    assert.equal(new Date(toEpoch({ y: 2026, m: 7, d: 6, h: 17, mi: 0, s: 0 }, 'Europe/Berlin')).toISOString(), '2026-07-06T15:00:00.000Z');
    assert.equal(new Date(toEpoch({ y: 2026, m: 11, d: 3, h: 17, mi: 0, s: 0 }, 'Europe/Berlin')).toISOString(), '2026-11-03T16:00:00.000Z');
    assert.equal(new Date(toEpoch({ y: 2026, m: 11, d: 3, h: 7, mi: 0, s: 0 }, 'America/Los_Angeles')).toISOString(), '2026-11-03T15:00:00.000Z');
  });

  it('ignores properties of nested alarms', async () => {
    const { events } = parseCalendar(await read('google.ics'));
    assert.equal(events.find((e) => e.uid === 'standup@acme').summary, 'Standup');
  });
});

describe('recurrence', () => {
  const series = (rrule, dtstart, extra = '') => parseCalendar(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:r\nSUMMARY:r\nDTSTART;TZID=America/New_York:${dtstart}\nDURATION:PT30M\nRRULE:${rrule}\n${extra}END:VEVENT\nEND:VCALENDAR`).events;
  const days = (events, from, to) => expand(events, { from, to }).map((o) => new Date(o.start).toDateString().slice(4, 10));

  it('monthly by ordinal weekday, including the last one', () => {
    assert.deepEqual(days(series('FREQ=MONTHLY;BYDAY=-1FR', '20260130T090000'), at(2026, 1, 1), at(2026, 6, 1)), ['Jan 30', 'Feb 27', 'Mar 27', 'Apr 24', 'May 29']);
  });

  it('every other week, with COUNT counting from the first one', () => {
    assert.deepEqual(days(series('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5', '20261005T090000'), at(2026, 10, 1), at(2027, 1, 1)), ['Oct 05', 'Oct 07', 'Oct 19', 'Oct 21', 'Nov 02']);
  });

  it('monthly by day of month skips months without that day; yearly and UNTIL work', () => {
    assert.deepEqual(days(series('FREQ=MONTHLY', '20260131T090000'), at(2026, 1, 1), at(2026, 6, 1)), ['Jan 31', 'Mar 31', 'May 31']);
    assert.deepEqual(days(series('FREQ=YEARLY;UNTIL=20290101T000000Z', '20240229T090000'), at(2024, 1, 1), at(2031, 1, 1)), ['Feb 29', 'Feb 29']);
    assert.deepEqual(days(series('FREQ=DAILY;UNTIL=20261104', '20261102T090000'), at(2026, 11, 1), at(2026, 12, 1)), ['Nov 02', 'Nov 03', 'Nov 04']);
  });

  it('a long-running daily series is quick, and a rule that never matches ends', () => {
    const t0 = Date.now();
    assert.equal(expand(series('FREQ=DAILY', '20100101T090000'), { from: NOW, to: NOW + 86_400_000 }).length, 1);
    assert.equal(expand(series('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', '20100101T090000'), { from: NOW, to: NOW + 86_400_000 }).length, 0);
    assert.ok(Date.now() - t0 < 2000);
  });
});

describe('Calendar source', () => {
  it('Google-style feed: recurring, moved, cancelled, excluded, all-day and other-zone meetings', async () => {
    const items = cal.meetingItems([{ label: 'calendar.google.com', text: await read('google.ics') }], { now: NOW });
    const t = byTitle(items);
    assert.deepEqual(Object.keys(t).sort(), ['04:00 PM · Sprint planning (moved)', '10:00 AM · Standup', '11:00 AM · Sync with Berlin', '02:00 PM · All-hands', 'All day · Team offsite'].sort());

    const standup = t['10:00 AM · Standup'];
    assert.equal(standup.urgency, 'now');
    assert.equal(standup.why, 'Starts **in 10 minutes** · Google Meet');
    assert.equal(standup.url, 'https://meet.google.com/abc-defg-hij');
    assert.equal(standup.meta.fields.Organizer, 'Ana Lopez');
    assert.equal(standup.meta.fields.Repeats, 'yes');

    assert.equal(t['04:00 PM · Sprint planning (moved)'].urgency, 'today');
    assert.equal(t['11:00 AM · Sync with Berlin'].why, 'Starts at **11:00 AM** (in 1 hour)');
    assert.equal(t['All day · Team offsite'].why, '**All day** today');
    assert.equal(t['All day · Team offsite'].urgency, 'later');
    assert.ok(!items.some((i) => i.title.includes('1:1')), 'the cancelled instance is gone');
    assert.ok(!items.some((i) => /series/i.test(i.title)), 'finished series are gone');
    assert.ok(!items.some((i) => i.title.includes('Standup') && i.why.includes('Tomorrow')), 'EXDATE removes tomorrow\'s standup');

    const declined = cal.meetingItems([{ label: 'x', text: await read('google.ics') }], { now: NOW, email: 'me@acme.com' });
    assert.ok(!declined.some((i) => i.title.includes('All-hands')), 'meetings you declined are hidden when your email is set');
  });

  it('Outlook-style feed: Windows zone names, floating times, unknown zones, yearly all-day events', async () => {
    const warnings = [];
    const items = cal.meetingItems([{ label: 'outlook.office365.com', text: await read('outlook.ics') }], { now: NOW, warn: (w) => warnings.push(w) });
    const t = byTitle(items);
    assert.equal(t['10:00 AM · Design review'].urgency, 'now');
    assert.equal(t['10:00 AM · Design review'].url, 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x');
    assert.equal(t['10:00 AM · Design review'].why, 'Starts **in 10 minutes** · Microsoft Teams Meeting');
    assert.equal(t['03:30 PM · Focus time'].urgency, 'today');
    assert.ok(t['04:00 PM · Call with Pune'], 'falls back to the zone\'s standard offset (+05:30)');
    assert.ok(warnings.some((w) => /Unknown time zone "Made Up Zone"/.test(w)));
    assert.equal(t["All day · Ana's birthday"].why, '**All day** tomorrow');
    assert.equal(items.length, 4);
  });

  it('a meeting in progress says so; one that ended is gone', () => {
    const text = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nSUMMARY:Live\nDTSTART:20261103T143000Z\nDTEND:20261103T153000Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:b\nSUMMARY:Over\nDTSTART:20261103T130000Z\nDTEND:20261103T140000Z\nEND:VEVENT\nEND:VCALENDAR';
    const items = cal.meetingItems([{ label: 'x', text }], { now: NOW });
    assert.equal(items.length, 1);
    assert.equal(items[0].urgency, 'now');
    assert.equal(items[0].why, '**Happening now** · started 20 minutes ago, ends at 10:30 AM');
  });

  it('reads the feed URL from the secret store and never puts it in items, summaries or errors', async () => {
    const secretUrl = 'https://calendar.google.com/calendar/ical/me%40acme.com/private-s3cr3t/basic.ics';
    const text = await read('google.ics');
    const f = fakeFetch((u) => (u.href === secretUrl ? { body: undefined, status: 200 } : undefined));
    const fetchImpl = async (url, init) => { const r = await f(url, init); return { ...r, text: async () => (String(url) === secretUrl ? text : '') }; };
    let summary;
    const items = await cal.collect({}, { now: NOW, fetch: fetchImpl, secret: async (n) => (n === 'cal-url' ? secretUrl : null), summary: (s) => { summary = s; } });
    assert.equal(items.length, 5);
    assert.equal(summary, 'calendar.google.com · 5 today · 0 tomorrow');
    assert.doesNotMatch(JSON.stringify(items) + summary, /s3cr3t/);
    assert.equal(f.calls[0].method, 'GET');

    const failing = async () => ({ ok: false, status: 403, headers: new Headers(), text: async () => '' });
    await assert.rejects(cal.collect({}, { now: NOW, fetch: failing, secret: async () => secretUrl }), (err) => {
      assert.equal(err.message, 'calendar.google.com returned HTTP 403');
      return true;
    });
  });

  it('reads a local .ics file', async () => {
    const items = await cal.collect({ file: path.join(FIX, 'outlook.ics') }, { now: NOW, secret: async () => null });
    assert.equal(items.length, 4);
    assert.equal(items[0].meta.fields.Calendar, 'outlook.ics');
    await assert.rejects(cal.collect({}, { now: NOW, secret: async () => null }), /Add a calendar link or an \.ics file/);
    await assert.rejects(cal.collect({ file: '/nope/missing.ics' }, { now: NOW, secret: async () => null }), /does not exist/);
  });

  it('validates the link: webcal becomes https, http is refused', () => {
    assert.equal(cal.normalizeFeedUrl('webcal://p01-caldav.icloud.com/published/2/abc'), 'https://p01-caldav.icloud.com/published/2/abc');
    assert.throws(() => cal.normalizeFeedUrl('http://example.com/cal.ics'), /https/);
    assert.throws(() => cal.normalizeFeedUrl('not a link'), /not a link/);
    assert.deepEqual(cal.validateSecrets({ 'cal-url': 'webcal://x.example/a.ics' }), { 'cal-url': 'https://x.example/a.ics' });
    assert.deepEqual(cal.normalizeSettings({ file: '', email: ' Me@Acme.com ' }), { file: '', email: 'me@acme.com' });
  });

  it('test() reports how many events it read', async () => {
    const r = await cal.test({ file: path.join(FIX, 'google.ics') }, { now: NOW, secret: async () => null });
    assert.equal(r.ok, true);
    assert.match(r.message, /^Read 10 events from google\.ics · 5 meetings today or tomorrow/);
    const bad = await cal.test({}, { secret: async () => null });
    assert.equal(bad.ok, false);
  });
});
