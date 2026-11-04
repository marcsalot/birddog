import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Collector } from '../src/collector.mjs';
import { Triage } from '../src/triage.mjs';
import { fakeItem, tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {} };

function fakeSource() {
  const src = {
    id: 'fake', name: 'Fake', fail: false, items: [fakeItem()],
    test: async () => ({ ok: true }),
    collect: async () => { if (src.fail) throw new Error('network down'); return src.items; },
  };
  return src;
}

describe('Collector', () => {
  it('keeps the last good data and marks a failed source stale', async () => {
    const dir = await tmpDir();
    let clock = 1000;
    const src = fakeSource();
    const c = new Collector({ sources: [src], dir, getConfig: () => ({ sources: {} }), now: () => clock, log: quiet });

    let snap = await c.refresh();
    assert.equal(snap.sources[0].status, 'ok');
    assert.equal(snap.items.length, 1);
    assert.equal(snap.items[0].stale, undefined);

    src.fail = true;
    clock = 2000;
    snap = await c.refresh();
    assert.equal(snap.sources[0].status, 'stale');
    assert.equal(snap.sources[0].error, 'network down');
    assert.equal(snap.sources[0].staleSince, 2000);
    assert.deepEqual(snap.items[0].stale, { since: 1000, error: 'network down' });

    clock = 3000;
    snap = await c.refresh();
    assert.equal(snap.sources[0].staleSince, 2000, 'staleSince sticks to the first failure');

    // Survives a restart: a new collector reads cache.json.
    const c2 = new Collector({ sources: [src], dir, getConfig: () => ({ sources: {} }), log: quiet });
    await c2.load();
    assert.equal(c2.snapshot().items[0].stale.since, 1000);

    src.fail = false;
    snap = await c.refresh();
    assert.equal(snap.sources[0].status, 'ok');
    assert.equal(snap.items[0].stale, undefined);
  });

  it('treats invalid items as a failure instead of showing junk', async () => {
    const src = fakeSource();
    src.items = [fakeItem({ urgency: 'whenever' })];
    const c = new Collector({ sources: [src], dir: await tmpDir(), getConfig: () => ({}), log: quiet });
    const snap = await c.refresh();
    assert.equal(snap.sources[0].status, 'stale');
    assert.match(snap.sources[0].error, /urgency/);
  });

  it('times out slow sources', async () => {
    const src = fakeSource();
    src.collect = () => new Promise(() => {});
    const c = new Collector({ sources: [src], dir: await tmpDir(), getConfig: () => ({}), timeoutMs: 50, log: quiet });
    const snap = await c.refresh();
    assert.match(snap.sources[0].error, /longer than/);
  });

  it('skips disabled sources and shares concurrent refreshes', async () => {
    const src = fakeSource();
    let calls = 0;
    src.collect = async () => { calls++; return []; };
    let enabled = true;
    const c = new Collector({ sources: [src], dir: await tmpDir(), getConfig: () => ({ sources: { fake: { enabled } } }), log: quiet });
    await Promise.all([c.refresh(), c.refresh()]);
    assert.equal(calls, 1);
    enabled = false;
    assert.equal((await c.refresh()).sources.length, 0);
  });
});

describe('Triage', () => {
  it('done hides an item until it changes', async () => {
    const t = new Triage({ dir: await tmpDir() });
    const item = fakeItem({ meta: { fingerprint: 'v1' } });
    await t.done(item);
    assert.equal(t.apply([item])[0].status, 'done');
    assert.equal(t.apply([{ ...item, meta: { fingerprint: 'v2' } }])[0].status, 'open');
  });

  it('snooze wakes up on time', async () => {
    let clock = Date.parse('2026-01-01T10:00:00Z');
    const t = new Triage({ dir: await tmpDir(), now: () => clock });
    const item = fakeItem();
    await t.snooze(item, '2026-01-01T11:00:00Z');
    assert.equal(t.apply([item])[0].status, 'snoozed');
    clock += 2 * 3_600_000;
    const woke = t.apply([item])[0];
    assert.equal(woke.status, 'open');
    assert.equal(woke.wokeAt, '2026-01-01T11:00:00.000Z');
  });

  it('snooze "until it changes" follows the fingerprint', async () => {
    const t = new Triage({ dir: await tmpDir() });
    const item = fakeItem({ meta: { fingerprint: 'a' } });
    await t.snooze(item, 'change');
    assert.equal(t.apply([item])[0].status, 'snoozed');
    assert.equal(t.apply([{ ...item, meta: { fingerprint: 'b' } }])[0].status, 'open');
    await assert.rejects(t.snooze(item, 'someday'), RangeError);
  });

  it('persists decisions and prefs across restarts', async () => {
    const dir = await tmpDir();
    const t = new Triage({ dir });
    await t.done(fakeItem());
    await t.setPrefs({ palette: 'sunset', mode: 'dark' });
    const again = new Triage({ dir });
    await again.load();
    assert.equal(again.apply([fakeItem()])[0].status, 'done');
    assert.equal(again.prefs.palette, 'sunset');
    await again.restore('fake:1');
    assert.equal(again.apply([fakeItem()])[0].status, 'open');
  });

  it('rejects invalid prefs', async () => {
    const t = new Triage({ dir: await tmpDir() });
    assert.deepEqual(await t.setPrefs({ palette: 'neon', mode: 'dark', bogus: 1 }), ['palette', 'bogus']);
    assert.equal(t.prefs.mode, 'dark');
    assert.equal(t.prefs.palette, 'gold');
  });

  it('prunes decisions for items gone a month', async () => {
    let clock = 0;
    const t = new Triage({ dir: await tmpDir(), now: () => clock });
    await t.done(fakeItem());
    clock = 31 * 86_400_000;
    await t.prune([]);
    assert.deepEqual(t.data.items, {});
  });
});
