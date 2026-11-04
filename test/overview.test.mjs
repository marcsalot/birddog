import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHistory, localDate, summarize } from '../src/history.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { loadLevel, overviewData, overviewHTML } from '../public/js/overview.js';
import { fakeItem, tmpDir } from './helpers.mjs';

const NOW = new Date(2026, 10, 4, 10, 0).getTime();
const it_ = (id, over) => fakeItem({ id, source: 'github', kind: 'review-request', status: 'open', urgency: 'now', updatedAt: new Date(NOW - 3600_000).toISOString(), ...over });

describe('history', () => {
  it('summarises a day: open by urgency, done today', () => {
    const row = summarize([
      it_('a'), it_('b', { urgency: 'later' }), it_('c', { status: 'snoozed' }),
      it_('d', { status: 'done', doneAt: new Date(NOW - 60_000).toISOString() }),
      it_('e', { status: 'done', doneAt: new Date(NOW - 3 * 86_400_000).toISOString() }),
    ], NOW);
    assert.deepEqual(row, { open: 2, now: 1, today: 0, later: 1, done: 1, snoozed: 1 });
  });

  it('keeps one row per day (the last reading), fills gaps, and trims old days', async () => {
    let t = NOW;
    const h = createHistory({ dir: await tmpDir(), now: () => t });
    await h.record([it_('a')]);
    await h.record([it_('a'), it_('b')]);
    t += 2 * 86_400_000;
    await h.record([]);
    const days = await h.last(4);
    assert.deepEqual(days.map((d) => d.date), [localDate(NOW - 86_400_000), localDate(NOW), localDate(NOW + 86_400_000), localDate(t)]);
    assert.equal(days[1].open, 2, 'last reading of the day wins');
    assert.equal(days[2].missing, true);
    assert.equal(days[3].open, 0);
    for (let i = 0; i < 70; i++) { t += 86_400_000; await h.record([]); }
    assert.ok((await h.last(60)).every((d) => !d.missing));
  });

  it('is served at /api/history and recorded on refresh', async () => {
    const dir = await tmpDir();
    const src = { id: 'fake', name: 'Fake', test: async () => ({ ok: true }), collect: async () => [fakeItem({ id: 'fake:1', source: 'fake', urgency: 'now' })] };
    const app = await createBirddog({ dir, sources: [src], autoRefresh: false, log: { warn() {}, error() {} }, secrets: await createSecretStore({ dir, backend: 'file' }) });
    const port = await app.start(0);
    try {
      await app.refresh();
      const { days } = await (await fetch(`http://127.0.0.1:${port}/api/history?days=3`)).json();
      assert.equal(days.length, 3);
      assert.deepEqual([days[2].open, days[2].now], [1, 1]);
      assert.equal(days[0].missing, true);
    } finally { await app.close(); }
  });
});

describe('overview', () => {
  const items = [
    it_('r1', { updatedAt: new Date(NOW - 3 * 86_400_000).toISOString(), title: 'api#1 · Old review' }),
    it_('r2', { title: 'api#2 · New review' }),
    it_('j1', { source: 'jira', kind: 'ticket', urgency: 'today' }),
    it_('m1', { source: 'cal', kind: 'meeting', urgency: 'today', title: '2:00 PM · Planning', meta: { startsAt: new Date(NOW + 4 * 3600_000).toISOString(), endsAt: new Date(NOW + 4.5 * 3600_000).toISOString() } }),
    it_('m2', { source: 'cal', kind: 'meeting', urgency: 'later', title: 'All day · Offsite', meta: { allDay: true, startsAt: new Date(NOW).toISOString(), endsAt: new Date(NOW + 86_400_000).toISOString() } }),
    it_('x', { status: 'done' }),
  ];
  const sources = [{ id: 'github', name: 'GitHub', status: 'ok', count: 3 }, { id: 'jira', name: 'Jira', status: 'stale', staleSince: NOW, error: 'HTTP 401', count: 1 }, { id: 'cal', name: 'Calendar', status: 'ok', count: 2 }];
  const history = [{ date: '2026-10-28', open: 9, now: 3, done: 2 }, ...Array.from({ length: 6 }, (_, i) => ({ date: `2026-10-${29 + i}`, missing: true })), { date: '2026-11-04', done: 1 }];

  it('computes the numbers the page shows', () => {
    const d = overviewData({ items, sources, history, now: NOW });
    assert.deepEqual([d.now, d.today, d.later, d.open], [2, 2, 1, 5]);
    assert.equal(d.longest.title, 'api#1 · Old review');
    assert.ok(Math.abs(d.longest.days - 3) < 0.01);
    assert.deepEqual(d.meetings, { count: 1, minutes: 30, next: d.meetings.next });
    assert.equal(d.meetings.next.title, 'Planning', 'all-day events are not meetings to attend');
    assert.equal(d.weekAgoOpen, 9);
    assert.deepEqual(d.bySource.map((r) => [r.id, r.total]), [['github', 2], ['jira', 1], ['cal', 2]]);
    assert.equal(d.byKind[0].label, 'Review requests');
    assert.deepEqual([d.days.at(-1).open, d.days.at(-1).done], [5, 1], "today's row is live");
  });

  it('labels the load with words and icons, not just color', () => {
    assert.deepEqual([0, 3, 4, 7, 8].map((n) => loadLevel(n).label), ['Calm', 'Calm', 'Busy', 'Busy', 'Swamped']);
    assert.ok(new Set(['good', 'warn', 'crit'].map((k) => [0, 5, 9].map(loadLevel).find((l) => l.key === k).icon)).size === 3);
  });

  it('renders accessible SVG: names, values and a table for every chart', () => {
    const html = overviewHTML(overviewData({ items, sources, history, now: NOW }), { width: 900 });
    assert.match(html, /role="img" aria-label="2 items need you now: Calm"/);
    assert.match(html, /aria-label="Open items and items that need you now, over the last 8 days\. Today: 5 open, 2 now\."/);
    assert.match(html, /aria-label="Open items by source: GitHub 2 \(2 now\), Jira 1 \(0 now\), Calendar 2 \(0 now\)"/);
    assert.equal((html.match(/Show the numbers/g) ?? []).length, 3);
    assert.match(html, /Stale since .*HTTP 401/);
    assert.match(html, /data-retry="jira"/);
    assert.doesNotMatch(html, /<script/);
    const evil = overviewHTML(overviewData({ items: [it_('z', { title: '<img src=x onerror=alert(1)>' })], sources, history, now: NOW }), { width: 900 });
    assert.doesNotMatch(evil, /<img src=x/);
  });
});
