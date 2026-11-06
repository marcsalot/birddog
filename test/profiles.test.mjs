// Profiles (Work, Home, …): the rules, the API, notifications, MCP and the UI builders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { createMcpHandler } from '../src/mcp.mjs';
import { createNotifier } from '../src/notify.mjs';
import { defaultProfiles, inSchedule, isChoice, normalizeProfiles, resolveProfile, showsSource, slugify } from '../src/profiles.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { buttonLabel, editorHTML, pickerHTML, scheduleText } from '../public/js/profiles.js';
import { fakeItem, tmpDir } from './helpers.mjs';

delete process.env.BIRDDOG_PROFILE; // these tests are about the real default, Auto

const quiet = { warn() {}, error() {}, log() {} };
// Local times, so the tests pass in any time zone.
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const WED_10 = at(2026, 11, 4, 10); // a Wednesday
const WED_20 = at(2026, 11, 4, 20);
const SAT_10 = at(2026, 11, 7, 10);

describe('profile rules', () => {
  it('starts with Work (weekdays 8–18, every source) and Home', () => {
    const [work, home] = defaultProfiles();
    assert.deepEqual([work.id, home.id], ['work', 'home']);
    assert.equal(work.sources, null);
    assert.deepEqual(work.schedule, { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' });
    assert.equal(home.schedule, null);
    assert.deepEqual(normalizeProfiles(undefined), defaultProfiles());
  });

  it('Auto picks Work in work hours and Home otherwise', () => {
    const list = defaultProfiles();
    assert.equal(resolveProfile(list, 'auto', WED_10).profile.id, 'work');
    assert.equal(resolveProfile(list, 'auto', WED_20).profile.id, 'home');
    assert.equal(resolveProfile(list, 'auto', SAT_10).profile.id, 'home');
    assert.equal(resolveProfile(list, 'auto', WED_10).auto, true);
    assert.deepEqual(resolveProfile(list, 'home', WED_10), { choice: 'home', profile: list[1], auto: false });
    assert.equal(resolveProfile(list, 'all', WED_10).profile, null);
    // A deleted profile falls back to Auto.
    assert.equal(resolveProfile(list, 'side-project', WED_10).choice, 'auto');
  });

  it('handles overnight schedules (22:00–06:00 belongs to the day it starts)', () => {
    const night = { days: [5], from: '22:00', to: '06:00' }; // Friday night
    assert.equal(inSchedule(night, at(2026, 11, 6, 23)), true); // Fri 23:00
    assert.equal(inSchedule(night, at(2026, 11, 7, 5, 59)), true); // Sat 05:59
    assert.equal(inSchedule(night, at(2026, 11, 7, 6)), false); // Sat 06:00
    assert.equal(inSchedule(night, at(2026, 11, 5, 23)), false); // Thu 23:00
    assert.equal(inSchedule(null, WED_10), false);
  });

  it('checks a profile list and makes ids from names', () => {
    const list = normalizeProfiles([{ name: 'On call!', sources: ['pagerduty', 'nope', 'pagerduty'], schedule: { days: [6, 0, 6], from: '09:00', to: '21:00' }, notify: false }], ['pagerduty', 'git']);
    assert.deepEqual(list, [{ id: 'on-call', name: 'On call!', sources: ['pagerduty'], schedule: { days: [0, 6], from: '09:00', to: '21:00' }, notify: false }]);
    assert.equal(slugify('  Side   Project_2 '), 'side-project-2');
    for (const [bad, why] of [
      [[], /at least one/],
      ['work', /must be a list/],
      [[{ name: '' }], /needs a name/],
      [[{ name: 'A' }, { name: 'a' }], /Two profiles/],
      [[{ name: 'All' }], /reserved/],
      [[{ name: 'X', schedule: { days: [], from: '09:00', to: '17:00' } }], /at least one day/],
      [[{ name: 'X', schedule: { days: [1], from: '9am', to: '17:00' } }], /08:00/],
      [[{ name: 'X', sources: 'git' }], /list of source ids/],
      [Array.from({ length: 13 }, (_, n) => ({ name: `P${n}` })), /At most 12/],
    ]) assert.throws(() => normalizeProfiles(bad), why);
  });

  it('knows what a profile shows and what a valid choice is', () => {
    assert.equal(showsSource(null, 'slack'), true);
    assert.equal(showsSource({ sources: null }, 'slack'), true);
    assert.equal(showsSource({ sources: ['git'] }, 'slack'), false);
    for (const ok of ['auto', 'all', 'work', 'side-project']) assert.equal(isChoice(ok), true, ok);
    for (const bad of ['', 'Work', '../x', 7, null]) assert.equal(isChoice(bad), false, String(bad));
  });
});

describe('profiles API', () => {
  let app; let api; let dir;
  const src = (id) => ({ id, name: id.toUpperCase(), test: async () => ({ ok: true }), collect: async () => [fakeItem({ id: `${id}:1`, source: id, urgency: 'now', title: `${id} thing` })] });
  before(async () => {
    dir = await tmpDir();
    fs.writeFileSync(`${dir}/config.json`, JSON.stringify({ sources: { git: { enabled: true }, slack: { enabled: true } } }));
    app = await createBirddog({ dir, sources: [src('git'), src('slack')], autoRefresh: false, log: quiet, secrets: await createSecretStore({ dir, backend: 'file' }) });
    const port = await app.start(0);
    api = async (p, { method = 'GET', body } = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    await app.refresh();
  });
  after(() => app.close());

  it('lists Work and Home by default, with every source for the editor', async () => {
    const r = await api('/api/profiles');
    assert.equal(r.status, 200);
    assert.equal(r.json.choice, 'auto');
    assert.deepEqual(r.json.list.map((p) => p.id), ['work', 'home']);
    assert.deepEqual(r.json.sources.map((s) => s.id), ['git', 'slack']);
  });

  it('filters /api/items by the chosen profile, and says how many are hidden', async () => {
    await api('/api/prefs', { method: 'PUT', body: { profile: 'home' } });
    let r = await api('/api/items');
    assert.deepEqual(r.json.items.map((i) => i.source), ['git'], 'Home has git but not Slack');
    assert.deepEqual(r.json.sources.map((s) => s.id), ['git']);
    assert.equal(r.json.profile.active, 'home');
    assert.equal(r.json.profile.hidden, 1);
    r = await api('/api/items?profile=all');
    assert.equal(r.json.items.length, 2);
    assert.equal((await api('/api/items?profile=../etc')).status, 400);
    assert.equal((await api('/api/prefs', { method: 'PUT', body: { profile: 'Not OK' } })).status, 400);
  });

  it('saves edited profiles to config.json, refuses bad ones, and resets', async () => {
    let r = await api('/api/profiles', { method: 'PUT', body: { profiles: [{ name: 'Day job', sources: ['slack'] }, { name: 'Evenings', sources: ['git', 'ghost'] }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.list.map((p) => [p.id, p.sources]), [['day-job', ['slack']], ['evenings', ['git']]]);
    assert.deepEqual(JSON.parse(fs.readFileSync(app.configFile, 'utf8')).profiles.map((p) => p.id), ['day-job', 'evenings']);
    assert.equal(r.json.choice, 'auto', 'the chosen profile (home) was deleted, so the choice went back to auto');
    r = await api('/api/items');
    assert.deepEqual(r.json.items.map((i) => i.source), ['slack'], 'auto with no schedule: the first profile');
    assert.equal((await api('/api/profiles', { method: 'PUT', body: { profiles: [] } })).status, 400);
    r = await api('/api/profiles', { method: 'DELETE', body: {} });
    assert.deepEqual(r.json.list.map((p) => p.id), ['work', 'home']);
    assert.equal(JSON.parse(fs.readFileSync(app.configFile, 'utf8')).profiles, undefined);
  });

  it('MCP list_items looks in the profile that shows, unless asked for all or one source', async () => {
    await api('/api/prefs', { method: 'PUT', body: { profile: 'home' } });
    const mcp = createMcpHandler({ app, version: 'test', refreshAfterMs: 1e12 });
    const call = async (args) => (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_items', arguments: args } })).result;
    let r = await call({});
    assert.deepEqual(r.structuredContent.items.map((i) => i.source), ['git']);
    assert.match(r.content[0].text, /Home profile/);
    r = await call({ profile: 'all' });
    assert.equal(r.structuredContent.items.length, 2);
    r = await call({ source: 'slack' });
    assert.deepEqual(r.structuredContent.items.map((i) => i.source), ['slack'], 'an explicit source ignores the profile');
    assert.equal((await call({ profile: 'Bad Id' })).isError, true);
    await api('/api/prefs', { method: 'PUT', body: { profile: 'auto' } });
  });
});

describe('notifications follow the profile', () => {
  it('marks muted events as known without announcing them, so switching later is no burst', async () => {
    const dir = await tmpDir();
    let t = 1_000_000;
    const n = createNotifier({ dir, now: () => t, log: quiet, getSettings: () => ({ enabled: true, channel: 'browser', minUrgency: 'now', quiet: null }), system: async () => {} });
    await n.load();
    await n.observe({ items: [], sources: [] }); // first run: the baseline
    const item = (id, source) => ({ ...fakeItem({ id, source, urgency: 'now' }), status: 'open' });
    t += 1000;
    const q1 = await n.observe({ items: [item('a', 'slack'), item('b', 'git')], sources: [], muted: (e) => e.source === 'slack' });
    assert.deepEqual(q1.map((e) => e.itemId), ['b']);
    t += 1000;
    const q2 = await n.observe({ items: [item('a', 'slack'), item('b', 'git')], sources: [] });
    assert.deepEqual(q2, [], 'the muted Slack item was already known');
  });
});

describe('profile UI builders', () => {
  const view = { choice: 'auto', active: 'work', name: 'Work', auto: true, hidden: 3, list: defaultProfiles(), sources: [{ id: 'git', name: 'Local git', enabled: true }, { id: 'discord', name: 'Discord', enabled: false }] };

  it('labels the button and describes schedules', () => {
    assert.equal(buttonLabel(view), 'Work · auto');
    assert.equal(buttonLabel({ ...view, auto: false, name: 'Home' }), 'Home');
    assert.equal(scheduleText({ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }), 'Mon–Fri 08:00–18:00');
    assert.equal(scheduleText({ days: [0, 6], from: '10:00', to: '12:00' }), 'Sun, Sat 10:00–12:00');
    assert.equal(scheduleText(null), 'no schedule');
  });

  it('shows the switcher with the current choice and what is hidden', () => {
    const html = pickerHTML(view);
    assert.match(html, /data-pf-pick="auto"[^>]*aria-checked="true"/);
    assert.match(html, /Now: Work, by schedule/);
    assert.match(html, /data-pf-pick="home"/);
    assert.match(html, /data-pf-pick="all"/);
    assert.match(html, /3 items hidden/);
    assert.match(html, /Local git, GitHub|Local git, github/i);
  });

  it('builds the editor without inline handlers and escapes names', () => {
    const html = editorHTML([{ id: 'x', name: '<img src=x onerror=alert(1)>', sources: ['git'], schedule: { days: [1], from: '09:00', to: '17:00' }, notify: false }], view.sources);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /value="&lt;img src=x onerror=alert\(1\)&gt;"/);
    assert.doesNotMatch(html.replaceAll('&lt;img src=x onerror=alert(1)&gt;', ''), /\son[a-z]+=/i);
    assert.match(html, /data-pf-src="0" value="git" checked/);
    assert.match(html, /class="pf-check off"><input type="checkbox" data-pf-src="0" value="discord" >/);
    assert.match(html, /data-pf-day="0:1" aria-pressed="true"/);
    assert.doesNotMatch(html, /data-pf-remove/, 'the last profile can\'t be removed');
  });
});
