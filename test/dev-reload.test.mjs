import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { fakeItem, tmpDir } from './helpers.mjs';

const src = { id: 'fake', name: 'Fake', test: async () => ({ ok: true }), collect: async () => [fakeItem()] };
const quiet = { warn() {}, error() {}, log() {} };

async function start(liveReload) {
  const dir = await tmpDir();
  const app = await createBirddog({ dir, sources: [src], autoRefresh: false, log: quiet, liveReload, secrets: await createSecretStore({ dir, backend: 'file' }) });
  return { app, port: await app.start(0) };
}

describe('live reload (npm run dev:watch)', () => {
  it('is off by default', async () => {
    const { app, port } = await start(false);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.liveReload, undefined);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/dev/events`)).status, 404);
    await app.close();
  });

  it('streams events when on, and close() ends the stream', async () => {
    const { app, port } = await start(true);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).liveReload, true);
    const first = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/dev/events', headers: { host: `127.0.0.1:${port}` } }, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        res.once('data', (d) => resolve(String(d)));
      }).on('error', reject);
    });
    assert.match(first, /^retry: 500/);
    await app.close();
  });
});
