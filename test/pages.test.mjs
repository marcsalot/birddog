// The GitHub Pages site: the build, and the in-browser API the static demo runs on.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import vm from 'node:vm';
import { build, relativize } from '../scripts/build-pages.mjs';
import { tmpDir } from './helpers.mjs';

const SHIM = await fs.readFile(new URL('../site/static-demo.js', import.meta.url), 'utf8');

/** Run static-demo.js in a fake page whose own fetch serves demo-data.json. */
function page(data, { now } = {}) {
  const location = new URL('https://marcsalot.github.io/birddog/app/');
  const realFetch = async (url) => {
    if (String(url).endsWith('demo-data.json')) return new Response(JSON.stringify(data));
    throw new Error(`unexpected network request: ${url}`);
  };
  const window = { fetch: realFetch, location };
  const document = { currentScript: null, addEventListener() {} };
  const ctx = { window, document, location, URL, Response, ReadableStream, TextEncoder, JSON, Date: now ? class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } } : Date, setTimeout, Promise, Object, Array, Map, Number, String, Math, RegExp };
  vm.runInNewContext(SHIM, ctx);
  const call = (p, method = 'GET', body) => window.fetch(p, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { window, call };
}

describe('Pages build', () => {
  it('makes the app work under /birddog/app/: relative assets, the demo shim first', () => {
    const html = relativize('index.html', '<link rel="stylesheet" href="/css/birddog.css">\n<script src="/js/boot.js"></script>\n<script type="module" src="/js/app.js"></script><a href="//x.com">');
    assert.match(html, /href="css\/birddog\.css"/);
    assert.match(html, /<script src="static-demo\.js"><\/script>\n<script src="js\/boot\.js"><\/script>/);
    assert.match(html, /src="js\/app\.js"/);
    assert.match(html, /href="\/\/x\.com"/, 'protocol-relative links are left alone');
    assert.equal(relativize('js/guide.js', 'img.src = `/guide/${n}.jpg`; icon: \'/favicon.svg\''), 'img.src = `guide/${n}.jpg`; icon: \'favicon.svg\'');
  });

  let out;
  let data;
  before(async () => {
    out = await tmpDir();
    await build(out);
    data = JSON.parse(await fs.readFile(path.join(out, 'app', 'demo-data.json'), 'utf8'));
  });

  it('writes the landing page, the app, assets and .nojekyll', async () => {
    for (const f of ['index.html', '.nojekyll', 'favicon.svg', 'assets/screenshot.png', 'app/index.html', 'app/static-demo.js', 'app/js/app.js', 'app/css/birddog.css']) {
      await fs.access(path.join(out, f));
    }
    const landing = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    assert.doesNotMatch(landing, /\{\{/);
    assert.match(landing, new RegExp(`v${data.version.replace(/\./g, '\\.')}`));
    assert.match(landing, /href="app\/"/);
    const app = await fs.readFile(path.join(out, 'app', 'index.html'), 'utf8');
    assert.doesNotMatch(app, /(href|src)="\/[^/]/, 'no root-absolute asset paths');
  });

  it('records every screen\'s data and working Ask Fetch answers', () => {
    for (const p of ['/api/items', '/api/setup', '/api/board', '/api/workspace', '/api/history?days=14', '/api/chat/status', '/api/chat/status#on']) assert.ok(data.responses[p], p);
    assert.ok(data.responses['/api/items'].items.length > 10);
    assert.equal(data.responses['/api/chat/status#on'].enabled, true);
    assert.ok(Object.keys(data.chats).length >= 5);
    for (const [q, c] of Object.entries(data.chats)) {
      assert.ok(c.events.some((e) => e.type === 'text'), `"${q}" has an answer`);
      assert.ok(!c.events.some((e) => e.error || e.type === 'error'), `"${q}" recorded no error`);
    }
    assert.ok(data.chats['Remember that my password is hunter2-rocks'].events.some((e) => e.type === 'boundary'), 'the secret probe shows the boundary');
  });

  it('holds no secrets: only the demo\'s made-up values', async () => {
    const text = await fs.readFile(path.join(out, 'app', 'demo-data.json'), 'utf8');
    assert.doesNotMatch(text, /demo-not-a-real-token|xox[abposr]-[\w-]{6,}|sk-ant-[\w-]{6,}|ghp_\w{6,}|BEGIN [A-Z ]*PRIVATE KEY/);
  });

  describe('the in-browser API', () => {
    it('shifts recorded times to now, so "in 8 minutes" stays true', async () => {
      const later = data.capturedAt + 3 * 86_400_000 + 3_600_000;
      const { window } = page(data, { now: later });
      await new Promise((r) => setTimeout(r, 10));
      const shift = window.__birddogShift;
      const plain = (v) => JSON.parse(JSON.stringify(v)); // objects from the page's own realm
      assert.equal(shift({ at: '2026-11-05T10:00:00.000Z' }, 3_600_000).at, '2026-11-05T11:00:00.000Z');
      assert.deepEqual(plain(shift({ '2026-11-05': { due: '2026-11-05' }, note: 'not a date', n: 5 }, 2 * 86_400_000)), { '2026-11-07': { due: '2026-11-07' }, note: 'not a date', n: 5 });
    });

    it('answers reads, triage, replies, chat and slot claims; refuses settings', async () => {
      const { call } = page(data);
      const items = await (await call('/api/items')).json();
      const first = items.items.find((i) => i.status === 'open');
      assert.equal((await call(`/api/items/${encodeURIComponent(first.id)}/done`, 'POST', {})).status, 200);
      assert.equal((await (await call('/api/items')).json()).items.find((i) => i.id === first.id).status, 'done');
      await call(`/api/items/${encodeURIComponent(first.id)}/restore`, 'POST', {});
      assert.equal((await (await call('/api/items')).json()).items.find((i) => i.id === first.id).status, 'open');

      const target = items.items.find((i) => i.reply);
      const q = await (await call(`/api/items/${encodeURIComponent(target.id)}/reply`, 'POST', { text: 'On it' })).json();
      assert.equal(q.state, 'pending');
      const undone = await (await call(`/api/replies/${q.id}/undo`, 'POST', {})).json();
      assert.equal(undone.state, 'undone');

      const status = await (await call('/api/chat/status')).json();
      assert.equal(status.enabled, false);
      assert.equal(status.keyVariable, 'none', 'no API key field on a public page');
      assert.equal((await call('/api/chat/setup', 'POST', { consent: true })).status, 200);
      assert.equal((await (await call('/api/chat/status')).json()).enabled, true);
      const answer = await (await call('/api/chat', 'POST', { message: 'What needs me now?' })).text();
      const events = answer.trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(events[0].type, 'session');
      assert.ok(events.some((e) => e.type === 'tool'));
      assert.ok(events.filter((e) => e.type === 'text').map((e) => e.text).join('').length > 40);
      const other = (await (await call('/api/chat', 'POST', { message: 'tell me a joke' })).text()).trim().split('\n').map((l) => JSON.parse(l));
      assert.match(other.filter((e) => e.type === 'text').map((e) => e.text).join(''), /only replay a few recorded answers/);

      const ws = await (await call('/api/workspace/slots/qa/1', 'PUT', { owner: 'Sam', ticket: 'pay-1' })).json();
      assert.deepEqual([ws.qaSlots[0].claim.owner, ws.qaSlots[0].claim.ticket], ['Sam', 'PAY-1']);
      assert.equal((await call('/api/workspace/slots/qa/1', 'PUT', { ticket: 'nope' })).status, 400);
      assert.equal((await (await call('/api/workspace/slots/qa/1', 'DELETE')).json()).qaSlots[0].claim, null);

      for (const [p, m] of [['/api/sources/jira', 'PUT'], ['/api/oauth/google/start', 'POST'], ['/api/board/settings', 'PUT'], ['/api/connections/github/device', 'POST']]) {
        const r = await call(p, m, {});
        assert.equal(r.status, 400);
        assert.match((await r.json()).error, /static demo/);
      }
      assert.equal((await call('/api/nope')).status, 404);
    });
  });
});
