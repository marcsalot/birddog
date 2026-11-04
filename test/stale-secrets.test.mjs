import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { backoffMs, Collector } from '../src/collector.mjs';
import { createSecretStore, fromKeychain, toKeychain } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { fakeItem, tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const MIN = 60_000;

function flaky() {
  const src = { id: 'flaky', name: 'Flaky', fail: false, calls: 0, test: async () => ({ ok: true }) };
  src.collect = async () => { src.calls++; if (src.fail) throw new Error('down'); return [fakeItem({ id: 'flaky:1', source: 'flaky' })]; };
  return src;
}

describe('stale sources back off', () => {
  it('backoff doubles from 2 minutes up to an hour', () => {
    assert.deepEqual([0, 1, 2, 3, 6, 7, 20].map((n) => backoffMs(n) / MIN), [0, 2, 4, 8, 60, 60, 60]);
  });

  it('scheduled refreshes skip a failing source until its retry time; manual ones always try', async () => {
    let clock = 0;
    const src = flaky();
    const other = { id: 'ok', name: 'Ok', test: async () => ({ ok: true }), collect: async () => [fakeItem({ id: 'ok:1', source: 'ok' })] };
    const c = new Collector({ sources: [src, other], dir: await tmpDir(), getConfig: () => ({}), now: () => clock, log: quiet });
    await c.refresh();
    src.fail = true;

    clock = 1 * MIN;
    let snap = await c.refresh({ scheduled: true });
    let s = snap.sources.find((x) => x.id === 'flaky');
    assert.equal(s.status, 'stale');
    assert.equal(s.failures, 1);
    assert.equal(s.nextRetryAt, 3 * MIN);
    assert.equal(snap.items.length, 2, 'the last good item stays, and other sources keep working');
    assert.ok(snap.items.find((i) => i.id === 'flaky:1').stale);

    const calls = src.calls;
    clock = 2 * MIN;
    await c.refresh({ scheduled: true });
    assert.equal(src.calls, calls, 'still backing off');

    clock = 3 * MIN;
    snap = await c.refresh({ scheduled: true });
    s = snap.sources.find((x) => x.id === 'flaky');
    assert.equal(src.calls, calls + 1);
    assert.equal(s.failures, 2);
    assert.equal(s.nextRetryAt, 7 * MIN);

    await c.refresh(); // by hand
    assert.equal(src.calls, calls + 2);

    src.fail = false;
    snap = await c.refresh({ only: 'flaky' });
    s = snap.sources.find((x) => x.id === 'flaky');
    assert.deepEqual([s.status, s.failures, s.nextRetryAt], ['ok', 0, null]);
  });

  it('runs never overlap, and the same request while one is waiting is shared', async () => {
    const src = flaky();
    let running = 0;
    let max = 0;
    src.collect = async () => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 10)); running--; return []; };
    const c = new Collector({ sources: [src], dir: await tmpDir(), getConfig: () => ({}), log: quiet });
    const a = c.refresh();
    const b = c.refresh({ only: 'flaky' });
    const b2 = c.refresh({ only: 'flaky' });
    assert.equal(b, b2);
    await Promise.all([a, b]);
    assert.equal(max, 1);
  });
});

describe('secrets', () => {
  it('keychain values that are not plain ASCII survive the round trip', () => {
    for (const v of ['plain', 'https://x/a"b\\c', 'ünï ✓', 'b64:looks-encoded']) assert.equal(fromKeychain(toKeychain(v)), v);
    assert.equal(toKeychain('plain-token'), 'plain-token', 'ordinary tokens are stored as they are');
  });

  it('the file fallback explains itself', async () => {
    const dir = await tmpDir();
    const s = await createSecretStore({ dir, backend: 'file' });
    assert.equal(s.secure, false);
    assert.match(s.warning, /not encrypted/);
  });

  it('secrets typed into config.json move to the secret store; the API never returns them', async () => {
    const dir = await tmpDir();
    const src = {
      id: 'svc', name: 'Svc', secretFields: { token: 'svc-token' }, enabledByDefault: false,
      test: async (_c, ctx) => ({ ok: (await ctx.secret('svc-token')) === 'abc', message: 'x' }),
      collect: async () => [],
      normalizeSettings: (x) => ({ site: x.site }),
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ sources: { svc: { enabled: true, site: 's', token: 'abc', apiKey: 'zzz' } } }));
    const secrets = await createSecretStore({ dir, backend: 'file' });
    const app = await createBirddog({ dir, sources: [src], autoRefresh: false, log: quiet, secrets });
    const port = await app.start(0);
    try {
      assert.equal(await secrets.get('svc-token'), 'abc');
      const onDisk = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
      assert.doesNotMatch(onDisk, /"token"/);
      const setup = await (await fetch(`http://127.0.0.1:${port}/api/setup`)).json();
      const svc = setup.sources[0];
      assert.deepEqual(svc.settings, { enabled: true, site: 's' }, 'secret-looking keys (apiKey) are not sent either');
      assert.deepEqual(svc.secrets, { token: true });
      assert.match(setup.secretWarning, /not encrypted/);
      assert.doesNotMatch(JSON.stringify(setup), /abc|zzz/);
    } finally { await app.close(); }
  });
});

describe('source API: retry and on/off', () => {
  it('retries one source and switches sources on and off', async () => {
    const dir = await tmpDir();
    const src = flaky();
    const app = await createBirddog({ dir, sources: [src], autoRefresh: false, log: quiet, secrets: await createSecretStore({ dir, backend: 'file' }) });
    const port = await app.start(0);
    const call = async (p, method = 'GET', body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    try {
      src.fail = true;
      await app.refresh();
      src.fail = false;
      const r = await call('/api/sources/flaky/retry', 'POST', {});
      assert.equal(r.json.sources[0].status, 'ok');
      const off = await call('/api/sources/flaky/enabled', 'PUT', { enabled: false });
      assert.equal(off.json.sources[0].enabled, false);
      assert.equal((await call('/api/items')).json.sources.length, 0);
      assert.equal((await call('/api/sources/flaky/retry', 'POST', {})).status, 400);
      assert.equal((await call('/api/sources/flaky/enabled', 'PUT', { enabled: 'yes' })).status, 400);
      const on = await call('/api/sources/flaky/enabled', 'PUT', { enabled: true });
      assert.equal(on.json.sources[0].status.status, 'ok');
    } finally { await app.close(); }
  });
});
