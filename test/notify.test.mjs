import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createNotifier, DEFAULT_NOTIFY, inQuietHours, normalizeNotify, suppressedBecause, systemCommand } from '../src/notify.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { fakeItem, tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const item = (id, over = {}) => fakeItem({ id, source: 'github', kind: 'review-request', title: `PR ${id}`, why: '**@ana** asked', urgency: 'now', status: 'open', ...over });
const src = (id, over = {}) => ({ id, name: id, status: 'ok', staleSince: null, error: null, ...over });

async function notifier(settings = {}, start = new Date(2026, 10, 4, 12, 0).getTime()) {
  let clock = start;
  const shown = [];
  let s = { ...DEFAULT_NOTIFY, enabled: true, ...settings };
  const n = createNotifier({ dir: await tmpDir(), getSettings: () => s, system: async (title, body) => { shown.push({ title, body }); }, now: () => clock, log: quiet });
  return { n, shown, tick: (ms) => { clock += ms; }, set: (patch) => { s = { ...s, ...patch }; } };
}

describe('notifications', () => {
  it('stay quiet on the first look, then announce each new "now" item once', async () => {
    const { n } = await notifier();
    assert.equal((await n.observe({ items: [item('a')], sources: [] })).length, 0, 'already there: no burst');
    const second = await n.observe({ items: [item('a'), item('b'), item('c', { urgency: 'today' })], sources: [] });
    assert.deepEqual(second.map((e) => e.itemId), ['b']);
    assert.equal(second[0].body, '@ana asked');
    assert.equal((await n.observe({ items: [item('a'), item('b')], sources: [] })).length, 0, 'never twice');
    assert.equal((await n.observe({ items: [item('b', { urgency: 'today' })], sources: [] })).length, 0);
    assert.equal((await n.observe({ items: [item('b')], sources: [] })).length, 0, 'not even after it left and came back');
    assert.equal((await n.observe({ items: [item('d', { status: 'snoozed' }), item('e', { stale: { since: 1 } })], sources: [] })).length, 0, 'snoozed and stale items are not news');
  });

  it('remembers what it announced across restarts (notified.json)', async () => {
    const dir = await tmpDir();
    const s = { ...DEFAULT_NOTIFY, enabled: true };
    const a = createNotifier({ dir, getSettings: () => s, system: async () => {}, log: quiet });
    await a.observe({ items: [], sources: [] });
    assert.equal((await a.observe({ items: [item('x')], sources: [] })).length, 1);
    const b = createNotifier({ dir, getSettings: () => s, system: async () => {}, log: quiet });
    await b.load();
    assert.equal((await b.observe({ items: [item('x')], sources: [] })).length, 0);
  });

  it('announces a source once per outage', async () => {
    const { n } = await notifier();
    await n.observe({ items: [], sources: [src('jira')] });
    const down = await n.observe({ items: [], sources: [src('jira', { status: 'stale', staleSince: 100, error: 'HTTP 401' })] });
    assert.equal(down.length, 1);
    assert.equal(down[0].title, 'jira stopped refreshing');
    assert.match(down[0].body, /HTTP 401/);
    assert.equal((await n.observe({ items: [], sources: [src('jira', { status: 'stale', staleSince: 100 })] })).length, 0);
    assert.equal((await n.observe({ items: [], sources: [src('jira', { status: 'stale', staleSince: 900 })] })).length, 1, 'a new outage is new');
  });

  it('respects per-source and per-kind switches, snooze-all and quiet hours (and never replays them)', async () => {
    const { n, set, tick } = await notifier({ sources: { jira: false }, kinds: { meeting: false } });
    await n.observe({ items: [], sources: [] });
    const got = await n.observe({ items: [item('j', { source: 'jira', kind: 'jira-issue' }), item('m', { source: 'cal', kind: 'meeting' }), item('g')], sources: [] });
    assert.deepEqual(got.map((e) => e.itemId), ['g']);
    set({ sources: {}, kinds: {} });
    assert.equal((await n.observe({ items: [item('j', { source: 'jira', kind: 'jira-issue' })], sources: [] })).length, 0, 'filtered items do not pop up later');

    set({ snoozeUntil: new Date(Date.now() + 3_600_000 * 24 * 365 * 5).toISOString() });
    assert.equal((await n.observe({ items: [item('s1')], sources: [] })).length, 0);
    set({ snoozeUntil: null, quietHours: { enabled: true, start: '11:00', end: '13:00' } });
    assert.equal((await n.observe({ items: [item('q1')], sources: [] })).length, 0, 'noon is quiet');
    tick(2 * 3_600_000);
    assert.equal((await n.observe({ items: [item('q2')], sources: [] })).length, 1, '14:00 is not');
  });

  it('quiet hours work across midnight', () => {
    const at = (h, m = 0) => new Date(2026, 10, 4, h, m).getTime();
    const q = { enabled: true, start: '22:00', end: '07:30' };
    assert.equal(inQuietHours(q, at(23)), true);
    assert.equal(inQuietHours(q, at(3)), true);
    assert.equal(inQuietHours(q, at(7, 29)), true);
    assert.equal(inQuietHours(q, at(7, 30)), false);
    assert.equal(inQuietHours(q, at(12)), false);
    assert.equal(inQuietHours({ ...q, enabled: false }, at(23)), false);
    assert.equal(suppressedBecause({ ...DEFAULT_NOTIFY }, { type: 'item' }, at(12)), 'notifications are off');
  });

  it('an open tab gets them first; otherwise the system shows them after a short grace period', async () => {
    const { n, shown, tick } = await notifier();
    await n.observe({ items: [], sources: [] });
    await n.observe({ items: [item('a')], sources: [] });
    assert.deepEqual(n.claim({ canShow: true }).map((e) => e.itemId), ['a'], 'the tab takes it');
    tick(20_000);
    assert.equal(await n.flush(), 0, 'and the system does not show it again');

    await n.observe({ items: [item('a'), item('b')], sources: [] });
    tick(5_000);
    assert.equal(await n.flush(), 0, 'a tab was seen recently: wait for it');
    tick(200_000);
    assert.equal(await n.flush(), 1, 'no tab for a while: the system shows it');
    assert.deepEqual(shown, [{ title: 'PR b', body: '@ana asked' }]);
    assert.deepEqual(n.claim({ canShow: true }), [], 'already shown');
  });

  it('a tab without permission does not take them, "browser" never uses the system, bursts are summarised', async () => {
    const { n, shown, tick, set } = await notifier();
    await n.observe({ items: [], sources: [] });
    await n.observe({ items: [item('a')], sources: [] });
    assert.deepEqual(n.claim({ canShow: false }), []);
    set({ channel: 'browser' });
    tick(60_000);
    assert.equal(await n.flush(), 0);
    set({ channel: 'system' });
    await n.observe({ items: [item('a'), ...['b', 'c', 'd', 'e'].map((x) => item(x))], sources: [] });
    assert.equal(await n.flush(), 5);
    assert.equal(shown.length, 1);
    assert.match(shown[0].title, /^5 things need you now$/);
  });

  it('validates settings', () => {
    const s = normalizeNotify({ enabled: true, kinds: { meeting: false }, quietHours: { enabled: true } });
    assert.equal(s.enabled, true);
    assert.deepEqual(s.quietHours, { enabled: true, start: '22:00', end: '08:00' });
    assert.throws(() => normalizeNotify({ channel: 'pager' }), /channel/);
    assert.throws(() => normalizeNotify({ quietHours: { start: '25:00' } }), /HH:MM/);
    assert.throws(() => normalizeNotify({ kinds: { meeting: 'yes' } }), /true or false/);
    assert.throws(() => normalizeNotify({ volume: 11 }), /unknown/);
  });

  it('system notifications pass text as arguments, never inside a script', () => {
    const evil = 'x" & do shell script "rm -rf ~" & "';
    const mac = systemCommand('Title', evil, 'darwin');
    assert.equal(mac.cmd, 'osascript');
    assert.equal(mac.args.at(-1), evil);
    assert.ok(!mac.args.slice(0, -2).some((a) => a.includes('rm -rf')));
    assert.deepEqual(systemCommand('T', 'B', 'linux'), { cmd: 'notify-send', args: ['--app-name=Birddog', 'T', 'B'] });
    const win = systemCommand('T', evil, 'win32');
    assert.ok(!win.args.join(' ').includes('rm -rf'));
    assert.equal(win.env.BIRDDOG_BODY, evil);
    assert.equal(systemCommand('T', 'B', 'aix'), null);
  });
});

describe('notifications over the API', () => {
  it('settings live in prefs; the tab claims events; test notifications work', async () => {
    const dir = await tmpDir();
    const items = [];
    const source = { id: 'fake', name: 'Fake', test: async () => ({ ok: true }), collect: async () => items };
    const system = [];
    const app = await createBirddog({ dir, sources: [source], autoRefresh: false, log: quiet, secrets: await createSecretStore({ dir, backend: 'file' }), notifySystem: async (t) => { system.push(t); } });
    const port = await app.start(0);
    const call = async (p, method = 'GET', body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) })).json();
    try {
      await app.refresh();
      const prefs = await call('/api/prefs', 'PUT', { notifications: { enabled: true, kinds: { thing: true } } });
      assert.equal(prefs.notifications.enabled, true);
      const bad = await fetch(`http://127.0.0.1:${port}/api/prefs`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notifications: { channel: 'fax' } }) });
      assert.equal(bad.status, 400);
      items.push(fakeItem({ id: 'fake:1', source: 'fake', urgency: 'now', title: 'Hot' }));
      await app.refresh();
      const { events } = await call('/api/notifications/claim', 'POST', { canShow: true });
      assert.deepEqual(events.map((e) => [e.itemId, e.title]), [['fake:1', 'Hot']]);
      assert.deepEqual((await call('/api/notifications/claim', 'POST', { canShow: true })).events, []);
      await call('/api/notifications/test', 'POST', { channel: 'system' });
      assert.deepEqual(system, ['Birddog test notification']);
      assert.ok(Array.isArray((await call('/api/notifications/kinds')).kinds));
    } finally { await app.close(); }
  });
});
