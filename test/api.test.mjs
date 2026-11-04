import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { fakeItem, tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };

function fakeSource() {
  const src = {
    id: 'fake', name: 'Fake', fail: false,
    items: [
      fakeItem({ id: 'fake:a', title: 'Alpha', urgency: 'now', meta: { fingerprint: 'a1' } }),
      fakeItem({ id: 'fake:b', title: 'Beta', urgency: 'later' }),
    ],
    test: async (cfg) => ({ ok: true, message: `roots=${(cfg.roots ?? []).join('|')}` }),
    collect: async () => { if (src.fail) throw new Error('boom'); return src.items; },
    normalizeSettings: (input) => {
      if (!Array.isArray(input.roots)) throw new TypeError('roots must be a list');
      return { roots: input.roots };
    },
  };
  return src;
}

/** Raw request so tests can set Host and Origin headers, which fetch() forbids. */
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body));
    else req.end();
  });
}

const json = (body) => ({ headers: { 'content-type': 'application/json' }, body });

describe('HTTP API', () => {
  let dir;
  let app;
  let port;
  let src;
  const api = (p, opts = {}) => request(port, { path: p, ...opts });

  before(async () => {
    dir = await tmpDir();
    src = fakeSource();
    app = await createBirddog({ dir, sources: [src], autoRefresh: false, log: quiet, secrets: await createSecretStore({ dir, backend: 'file' }) });
    port = await app.start(0);
    await app.refresh();
  });
  after(() => app.close());

  it('binds to 127.0.0.1 only', () => {
    assert.equal(app.server.address().address, '127.0.0.1');
  });

  it('serves the UI with a strict CSP', async () => {
    const res = await api('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>Birddog<\/title>/);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal((await api('/js/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await api('/../package.json')).status, 404);
    assert.equal((await api('/%2e%2e/package.json')).status, 404);
  });

  it('GET /api/items returns ranked items and source status', async () => {
    const res = await api('/api/items');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items.map((i) => [i.id, i.status]), [['fake:a', 'open'], ['fake:b', 'open']]);
    assert.equal(res.json.sources[0].status, 'ok');
    assert.equal(typeof res.json.refreshedAt, 'number');
  });

  it('done, snooze and restore round-trip', async () => {
    assert.equal((await api('/api/items/fake%3Aa/done', { method: 'POST', ...json({}) })).status, 200);
    let items = (await api('/api/items')).json.items;
    assert.equal(items.find((i) => i.id === 'fake:a').status, 'done');

    const until = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal((await api('/api/items/fake:b/snooze', { method: 'POST', ...json({ until }) })).status, 200);
    items = (await api('/api/items')).json.items;
    assert.equal(items.find((i) => i.id === 'fake:b').status, 'snoozed');

    await api('/api/items/fake:b/restore', { method: 'POST', ...json({}) });
    items = (await api('/api/items')).json.items;
    assert.equal(items.find((i) => i.id === 'fake:b').status, 'open');
  });

  it('validates snooze input and unknown items', async () => {
    assert.equal((await api('/api/items/fake:b/snooze', { method: 'POST', ...json({ until: '2001-01-01T00:00:00Z' }) })).status, 400);
    assert.equal((await api('/api/items/nope/done', { method: 'POST', ...json({}) })).status, 404);
  });

  it('persists done/snooze and prefs across a restart', async () => {
    await api('/api/prefs', { method: 'PUT', ...json({ palette: 'violet', mode: 'dark' }) });
    await app.close();
    app = await createBirddog({ dir, sources: [src], autoRefresh: false, log: quiet, secrets: await createSecretStore({ dir, backend: 'file' }) });
    port = await app.start(0);
    const items = (await api('/api/items')).json.items;
    assert.equal(items.find((i) => i.id === 'fake:a').status, 'done');
    assert.deepEqual((await api('/api/prefs')).json, { palette: 'violet', mode: 'dark', seenSetup: false, hiddenSources: [] });
  });

  it('rejects bad prefs', async () => {
    const res = await api('/api/prefs', { method: 'PUT', ...json({ palette: '<script>' }) });
    assert.equal(res.status, 400);
  });

  it('POST /api/refresh keeps stale data when a source fails', async () => {
    src.fail = true;
    const res = await api('/api/refresh', { method: 'POST', ...json({}) });
    assert.equal(res.json.sources[0].status, 'stale');
    assert.equal(res.json.items.length, 2);
    assert.ok(res.json.items.every((i) => i.stale?.error === 'boom'));
    src.fail = false;
    await api('/api/refresh', { method: 'POST', ...json({}) });
  });

  it('setup: lists sources, tests and saves settings', async () => {
    const setup = (await api('/api/setup')).json;
    assert.equal(setup.sources[0].id, 'fake');
    assert.deepEqual(setup.comingSoon.map((c) => c.id), ['cal']);
    const t = await api('/api/sources/fake/test', { method: 'POST', ...json({ roots: ['/x'] }) });
    assert.equal(t.json.message, 'roots=/x');
    const saved = await api('/api/sources/fake', { method: 'PUT', ...json({ roots: ['/y'] }) });
    assert.deepEqual(saved.json.sources[0].settings.roots, ['/y']);
    const cfg = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(cfg.sources.fake.roots, ['/y']);
    assert.equal((await api('/api/sources/fake', { method: 'PUT', ...json({ roots: 'nope' }) })).status, 400);
  });

  describe('security', () => {
    it('rejects foreign Host headers (DNS rebinding)', async () => {
      const res = await api('/api/items', { headers: { host: 'evil.example:80' } });
      assert.equal(res.status, 403);
    });

    it('rejects cross-origin writes', async () => {
      const res = await api('/api/items/fake:b/done', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
      assert.equal(res.status, 403);
    });

    it('requires JSON for writes (blocks simple form posts)', async () => {
      const res = await api('/api/items/fake:b/done', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(res.status, 415);
    });

    it('answers same-origin requests', async () => {
      const res = await api('/api/health', { headers: { origin: `http://127.0.0.1:${port}` } });
      assert.equal(res.json.app, 'birddog');
    });
  });
});
