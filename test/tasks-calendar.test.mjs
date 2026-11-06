// Two-way task lists (Microsoft To Do, Google Tasks, Todoist) and the unified calendar
// (every connected calendar at once, including Thunderbird's).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createDemo } from '../src/demo.mjs';
import { createMcpHandler } from '../src/mcp.mjs';
import { dueWhen } from '../src/rules.mjs';
import { createBirddog } from '../src/server.mjs';
import * as cal from '../src/sources/cal.mjs';
import * as gtasks from '../src/sources/gtasks.mjs';
import { calendarNames, icalTime, thunderbirdCalendars } from '../src/sources/thunderbird-cal.mjs';
import * as todo from '../src/sources/todo.mjs';
import * as todoist from '../src/sources/todoist.mjs';
import { taskItem, wanted } from '../src/sources/tasklib.mjs';
import { fakeFetch, tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const DAY = 86_400_000;
const at = (y, mo, d, h = 0) => new Date(y, mo - 1, d, h).getTime();
const NOW = at(2026, 11, 6, 10); // a Friday, 10:00 local
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const oauth = (scopes = null) => ({ accessToken: async () => 'tok', grantedScopes: async () => scopes, connection: async () => ({ account: 'me@x' }) });

describe('task rules', () => {
  it('lists overdue, due this week and important; the rest only with showAll', () => {
    assert.equal(wanted({ dueDays: -1, important: false }), true);
    assert.equal(wanted({ dueDays: 6.5, important: false }), true);
    assert.equal(wanted({ dueDays: 9, important: false }), false);
    assert.equal(wanted({ dueDays: null, important: true }), true);
    assert.equal(wanted({ dueDays: null, important: false }), false);
    assert.equal(wanted({ dueDays: null, important: false }, { showAll: true }), true);
  });

  it('ranks overdue, due today and important as Today, the rest Later', () => {
    const t = (due, important = false) => taskItem({ source: 'todo', key: 'k', title: 'T', list: 'Work', due, important, ref: {} }, NOW);
    assert.deepEqual([t(ymd(NOW - DAY)).meta.rule.id, t(ymd(NOW)).meta.rule.id, t(null, true).meta.rule.id, t(ymd(NOW + 3 * DAY)).meta.rule.id], ['task-overdue', 'task-due-today', 'task-important', 'task']);
    assert.match(t(ymd(NOW - DAY)).why, /\*\*Overdue\*\*, due yesterday · Work/);
    assert.equal(t(ymd(NOW + 3 * DAY)).urgency, 'later');
    assert.deepEqual([dueWhen(-0.4), dueWhen(-1.6), dueWhen(0.5), dueWhen(1.5), dueWhen(4.2)], ['yesterday', '2 days ago', 'today', 'tomorrow', 'in 4 days']);
  });
});

describe('Microsoft To Do', () => {
  const graph = () => fakeFetch((u, init) => {
    if (u.pathname === '/v1.0/me/todo/lists') return { body: { value: [{ id: 'L1', displayName: 'Work' }] } };
    if (u.pathname === '/v1.0/me/todo/lists/L1/tasks' && (init.method ?? 'GET') === 'GET') {
      assert.equal(u.searchParams.get('$filter'), "status ne 'completed'");
      return { body: { value: [
        { id: 'a', title: 'Overdue thing', importance: 'normal', dueDateTime: { dateTime: `${ymd(NOW - DAY)}T00:00:00.0000000`, timeZone: 'UTC' } },
        { id: 'b', title: 'Important, no date', importance: 'high' },
        { id: 'c', title: 'Someday', importance: 'normal' },
      ] } };
    }
    if (u.pathname === '/v1.0/me/todo/lists/L1/tasks/a' && init.method === 'PATCH') return { body: { id: 'a', status: JSON.parse(init.body).status } };
    return undefined;
  });

  it('lists the tasks that need you, with the list name', async () => {
    const items = await todo.collect({}, { fetch: graph(), now: NOW, oauth: oauth() });
    assert.deepEqual(items.map((i) => [i.id, i.urgency]), [['todo:a', 'today'], ['todo:b', 'today']]);
    assert.equal(items[0].meta.fields.List, 'Work');
    assert.deepEqual(items[0].meta.task, { list: 'L1', task: 'a' });
    assert.equal((await todo.collect({ showAll: true }, { fetch: graph(), now: NOW, oauth: oauth() })).length, 3);
  });

  it('completes and reopens only with Sync done on and the write scope granted', async () => {
    const fetch = graph();
    const [item] = await todo.collect({}, { fetch, now: NOW, oauth: oauth() });
    await assert.rejects(todo.complete(item, { fetch, oauth: oauth() }, true, {}), /Sync done is off/);
    await assert.rejects(todo.complete(item, { fetch, oauth: oauth(['Tasks.Read']) }, true, { syncDone: true }), /allow Tasks\.ReadWrite/);
    await todo.complete(item, { fetch, oauth: oauth(['Tasks.ReadWrite']) }, true, { syncDone: true });
    await todo.complete(item, { fetch, oauth: oauth(['Tasks.ReadWrite']) }, false, { syncDone: true });
    const patches = fetch.calls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 2);
  });
});

describe('Google Tasks', () => {
  it('lists open tasks due this week, and completes them with the tasks scope', async () => {
    const bodies = [];
    const fetch = fakeFetch((u, init) => {
      if (u.pathname === '/tasks/v1/users/@me/lists') return { body: { items: [{ id: 'G', title: 'My Tasks' }] } };
      if (u.pathname === '/tasks/v1/lists/G/tasks' && (init.method ?? 'GET') === 'GET') {
        return { body: { items: [
          { id: '1', title: 'Due today', status: 'needsAction', due: `${ymd(NOW)}T00:00:00.000Z`, webViewLink: 'https://tasks.google.com/task/1' },
          { id: '2', title: 'No date', status: 'needsAction' },
          { id: '3', title: 'Done already', status: 'completed', due: `${ymd(NOW)}T00:00:00.000Z` },
        ] } };
      }
      if (init.method === 'PATCH') { bodies.push(JSON.parse(init.body)); return { body: {} }; }
      return undefined;
    });
    const items = await gtasks.collect({}, { fetch, now: NOW, oauth: oauth() });
    assert.deepEqual(items.map((i) => [i.title, i.urgency, i.url]), [['Due today', 'today', 'https://tasks.google.com/task/1']]);
    await assert.rejects(gtasks.complete(items[0], { fetch, oauth: oauth(['https://www.googleapis.com/auth/tasks.readonly']) }, true, { syncDone: true }), /allow changing tasks/);
    await gtasks.complete(items[0], { fetch, oauth: oauth([gtasks.WRITE_SCOPE]) }, true, { syncDone: true });
    await gtasks.complete(items[0], { fetch, oauth: oauth([gtasks.WRITE_SCOPE]) }, false, { syncDone: true });
    assert.deepEqual(bodies, [{ status: 'completed' }, { status: 'needsAction', completed: null }]);
  });
});

describe('Todoist', () => {
  it('filters on Todoist, follows the cursor, names projects, and closes / reopens', async () => {
    const posts = [];
    const fetch = fakeFetch((u, init) => {
      assert.equal(init.headers.authorization, 'Bearer tok');
      if (u.pathname === '/api/v1/tasks/filter') {
        assert.equal(u.searchParams.get('query'), 'overdue | 7 days | p1');
        return u.searchParams.get('cursor')
          ? { body: { results: [{ id: '2', content: 'P1 [link](https://x.example)', priority: 4, project_id: 'P', due: null }], next_cursor: null } }
          : { body: { results: [{ id: '1', content: 'Dentist', priority: 1, project_id: 'P', due: { date: ymd(NOW - 2 * DAY), is_recurring: false } }], next_cursor: 'c2' } };
      }
      if (u.pathname === '/api/v1/projects') return { body: { results: [{ id: 'P', name: 'Home' }] } };
      if (init.method === 'POST') { posts.push(u.pathname); return { status: 204, text: '' }; }
      return undefined;
    });
    const items = await todoist.collect({}, { fetch, now: NOW, secret: async () => 'tok' });
    assert.deepEqual(items.map((i) => [i.title, i.meta.rule.id, i.meta.fields.List]), [['Dentist', 'task-overdue', 'Home'], ['P1 link', 'task-important', 'Home']]);
    assert.equal(items[0].url, 'https://app.todoist.com/app/task/1');
    await todoist.complete(items[0], { fetch, secret: async () => 'tok' }, true, { syncDone: true });
    await todoist.complete(items[0], { fetch, secret: async () => 'tok' }, false, { syncDone: true });
    assert.deepEqual(posts, ['/api/v1/tasks/1/close', '/api/v1/tasks/1/reopen']);
    await assert.rejects(todoist.complete(items[0], { fetch, secret: async () => 'tok' }, true, {}), /Sync done is off/);
  });
});

describe('Sync done through the API, the demo and MCP', () => {
  let demo; let app; let api;
  before(async () => {
    demo = await createDemo();
    app = await createBirddog({ ...demo.options, autoRefresh: false, log: quiet });
    const port = await app.start(0);
    api = async (p, { method = 'GET', body } = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    await app.refresh();
  });
  after(async () => { await app.close(); await demo.cleanup(); });

  it('Done completes the task in its app, and Restore reopens it', async () => {
    let r = await api('/api/items/todo%3At2/done', { method: 'POST', body: {} });
    assert.deepEqual(r.json, { ok: true, synced: 'Microsoft To Do' });
    await app.refresh({ only: 'todo' });
    assert.ok(!app.collector.snapshot().items.some((i) => i.id === 'todo:t2'), 'completed in To Do, so it left the list');
    r = await api('/api/items/todo%3At2/restore', { method: 'POST', body: {} });
    assert.deepEqual(r.json, { ok: true, reopened: 'Microsoft To Do' });
    await app.refresh({ only: 'todo' });
    assert.ok(app.collector.snapshot().items.some((i) => i.id === 'todo:t2'));
  });

  it('the switch is per source, saved to config, and only on task sources', async () => {
    let r = await api('/api/sources/todoist/sync', { method: 'PUT', body: { on: false } });
    assert.equal(r.json.sources.find((s) => s.id === 'todoist').sync.on, false);
    r = await api('/api/items/todoist%3A8002/done', { method: 'POST', body: {} });
    assert.deepEqual(r.json, { ok: true, synced: null }, 'off: only Birddog\'s list changes');
    assert.equal((await api('/api/sources/slack/sync', { method: 'PUT', body: { on: true } })).status, 400);
    assert.equal((await api('/api/sources/todo/sync', { method: 'PUT', body: { on: 'yes' } })).status, 400);
  });

  it('MCP mark_done says when it completed the task in the app', async () => {
    const mcp = createMcpHandler({ app, version: 'test', refreshAfterMs: 1e12 });
    const r = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mark_done', arguments: { id: 'todo:t1' } } })).result;
    assert.match(r.content[0].text, /Also completed in Microsoft To Do/);
    assert.equal(r.structuredContent.completedIn, 'Microsoft To Do');
  });

  it('the calendar card lists every connected calendar, and one can be removed', async () => {
    let r = await api('/api/setup');
    assert.deepEqual(r.json.sources.find((s) => s.id === 'cal').calendars, ['ics', 'thunderbird']);
    r = await api('/api/sources/cal/calendars/thunderbird', { method: 'DELETE', body: {} });
    const c = r.json.sources.find((s) => s.id === 'cal');
    assert.deepEqual(c.calendars, ['ics']);
    assert.equal(c.enabled, true, 'the iCal link is still there');
    assert.equal((await api('/api/sources/cal/calendars/nope', { method: 'DELETE', body: {} })).status, 404);
  });
});

describe('unified calendar', () => {
  const ics = (summary, start) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${summary}\r\nSUMMARY:${summary}\r\nDTSTART:${start}\r\nDTEND:${start.replace(/T(\d\d)/, (_, h) => `T${String(+h + 1).padStart(2, '0')}`)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

  it('reads every connected back end, merges the same meeting, and keeps going when one fails', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'home.ics');
    await fs.writeFile(file, ics('Standup', '20261106T150000Z') + ics('Dentist', '20261106T170000Z').replace('BEGIN:VCALENDAR\r\n', ''));
    // Google is connected and has Standup too; Outlook is connected but broken.
    const fetch = fakeFetch((u) => {
      if (u.hostname === 'www.googleapis.com') return { body: { items: [{ id: 'g1', summary: 'Standup', start: { dateTime: '2026-11-06T15:00:00Z' }, end: { dateTime: '2026-11-06T16:00:00Z' } }] } };
      if (u.hostname === 'graph.microsoft.com') return { status: 500, body: { error: { message: 'boom' } } };
      return undefined;
    });
    const o = { ...oauth(), status: async (p) => ({ connected: p === 'google' || p === 'microsoft' }) };
    const warnings = [];
    const config = { file };
    assert.deepEqual(await cal.backends(config, { oauth: o, secret: async () => null }), ['google', 'microsoft', 'ics']);
    const items = await cal.collect(config, { fetch, now: Date.parse('2026-11-06T12:00:00Z'), oauth: o, secret: async () => null, warn: (w) => warnings.push(w) });
    const standup = items.filter((i) => /Standup/.test(i.title));
    assert.equal(standup.length, 1, 'listed once');
    assert.equal(standup[0].meta.fields.Calendar, 'Google · me@x + home.ics');
    assert.ok(items.some((i) => /Dentist/.test(i.title)));
    assert.match(warnings.join(' '), /^Outlook: .*500/);
  });

  it('says what to add when no calendar is set up', async () => {
    await assert.rejects(cal.collect({}, { now: NOW, secret: async () => null }), /Add a calendar in setup/);
    assert.deepEqual(cal.normalizeSettings({ thunderbird: 'on', thunderbirdProfile: '~/tb' }).thunderbird, true);
    assert.throws(() => cal.normalizeSettings({ thunderbirdProfile: 'relative' }), /full path/);
  });
});

describe('Thunderbird calendars', () => {
  it('turns its SQLite store into iCalendar: names, all-day, floating, repeats, moved and disabled', async (t) => {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return t.skip('node:sqlite needs Node 22.13+'); }
    const prof = await tmpDir();
    await fs.writeFile(path.join(prof, 'prefs.js'), 'user_pref("calendar.registry.c1.name", "Home");\nuser_pref("calendar.registry.c2.name", "Old");\nuser_pref("calendar.registry.c2.disabled", true);\n');
    await fs.mkdir(path.join(prof, 'calendar-data'));
    const db = new DatabaseSync(path.join(prof, 'calendar-data', 'local.sqlite'));
    db.exec('CREATE TABLE cal_events (cal_id TEXT, id TEXT, title TEXT, flags INTEGER, event_start INTEGER, event_start_tz TEXT, event_end INTEGER, event_end_tz TEXT, recurrence_id INTEGER, recurrence_id_tz TEXT)');
    db.exec('CREATE TABLE cal_properties (cal_id TEXT, item_id TEXT, key TEXT, value TEXT, recurrence_id INTEGER, recurrence_id_tz TEXT)');
    db.exec('CREATE TABLE cal_recurrence (cal_id TEXT, item_id TEXT, icalString TEXT)');
    const us = (iso) => Date.parse(iso) * 1000;
    const ins = db.prepare('INSERT INTO cal_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run('c1', 'e1', 'Dinner', 0, us('2026-11-06T18:00:00Z'), 'Europe/London', us('2026-11-06T20:00:00Z'), 'Europe/London', null, null);
    ins.run('c1', 'e2', 'Holiday', 8, us('2026-11-06T00:00:00Z'), 'floating', us('2026-11-07T00:00:00Z'), 'floating', null, null);
    ins.run('c1', 'e3', 'Gym', 0x10, us('2026-11-02T07:00:00Z'), 'UTC', us('2026-11-02T08:00:00Z'), 'UTC', null, null);
    ins.run('c1', 'e3', 'Gym (moved)', 0, us('2026-11-06T09:00:00Z'), 'UTC', us('2026-11-06T10:00:00Z'), 'UTC', us('2026-11-06T07:00:00Z'), 'UTC');
    ins.run('c2', 'e4', 'Hidden', 0, us('2026-11-06T12:00:00Z'), 'UTC', us('2026-11-06T13:00:00Z'), 'UTC', null, null);
    db.prepare('INSERT INTO cal_properties (cal_id, item_id, key, value) VALUES (?, ?, ?, ?)').run('c1', 'e1', 'LOCATION', 'Luigi\'s; Main St');
    db.prepare('INSERT INTO cal_recurrence VALUES (?, ?, ?)').run('c1', 'e3', 'RRULE:FREQ=DAILY;COUNT=10');
    db.close();

    assert.deepEqual(calendarNames('user_pref("calendar.registry.x.name", "Work \\"A\\"");'), { x: { name: 'Work "A"' } });
    assert.deepEqual(icalTime(us('2026-11-06T18:30:00Z'), 'UTC', false), { params: '', value: '20261106T183000Z' });
    assert.deepEqual(icalTime(us('2026-11-06T18:30:00Z'), 'floating', false), { params: '', value: '20261106T183000' });
    assert.deepEqual(icalTime(us('2026-11-06T00:00:00Z'), 'floating', true), { params: ';VALUE=DATE', value: '20261106' });

    const cals = await thunderbirdCalendars({ profile: prof, from: Date.parse('2026-11-05T00:00:00Z'), to: Date.parse('2026-11-08T00:00:00Z') });
    assert.deepEqual(cals.map((c) => c.label), ['Thunderbird · Home'], 'the disabled calendar is skipped');
    assert.match(cals[0].text, /LOCATION:Luigi's\\; Main St/);
    const items = await cal.collect({ thunderbird: true, thunderbirdProfile: prof }, { now: Date.parse('2026-11-06T06:00:00Z'), secret: async () => null });
    const titles = items.map((i) => i.title.replace(/^.* · /, ''));
    assert.ok(titles.includes('Dinner'));
    assert.ok(titles.includes('Holiday'));
    assert.ok(titles.includes('Gym (moved)'), 'the moved occurrence replaces that day\'s Gym');
    assert.equal(titles.filter((x) => x === 'Gym').length, 1, 'tomorrow\'s Gym is still there');
    assert.ok(!titles.includes('Hidden'));
    assert.equal(items.find((i) => /Dinner/.test(i.title)).meta.fields.Calendar, 'Thunderbird · Home');
    assert.deepEqual(await fs.readdir(path.join(prof, 'calendar-data')), ['local.sqlite'], 'Thunderbird\'s folder is untouched (we read a copy)');
  });

  it('explains a profile without calendars', async () => {
    const prof = await tmpDir();
    await fs.writeFile(path.join(prof, 'prefs.js'), '');
    await assert.rejects(thunderbirdCalendars({ profile: prof, from: 0, to: 1 }), /no calendars on this computer/);
  });
});
