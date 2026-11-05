import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDemo, demoFetch } from '../src/demo.mjs';
import { createMcpHandler, PROTOCOL_VERSIONS, snoozeUntil } from '../src/mcp.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { Triage } from '../src/triage.mjs';
import { fakeItem, tmpDir } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { warn() {}, error() {}, log() {} };

async function setup() {
  const dir = await tmpDir();
  const secrets = await createSecretStore({ dir, backend: 'file' });
  await secrets.set('fake-token', 'sup3r-s3cret-value');
  const src = {
    id: 'fake', name: 'Fake', secretFields: { token: 'fake-token' }, calls: 0,
    test: async () => ({ ok: true }),
    collect: async (_c, ctx) => {
      src.calls++;
      ctx.summary('2 things');
      return [
        fakeItem({ id: 'fake:now', source: 'fake', title: 'Fire', why: '**Hot** now', urgency: 'now', url: 'https://example.com/fire', meta: { command: 'put-it-out', fields: { Where: 'kitchen' }, fingerprint: 'f1' } }),
        fakeItem({ id: 'fake:later', source: 'fake', title: 'Laundry', urgency: 'later', meta: { fingerprint: 'l1' } }),
      ];
    },
  };
  const app = await createBirddog({ dir, sources: [src], autoRefresh: false, log: quiet, secrets });
  const mcp = createMcpHandler({ app, version: '9.9.9' });
  let id = 0;
  const rpc = async (method, params) => mcp.handle({ jsonrpc: '2.0', id: ++id, method, params });
  const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  return { dir, app, mcp, rpc, tool, src };
}

describe('MCP server', () => {
  it('negotiates the protocol and lists its tools', async () => {
    const { rpc } = await setup();
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.serverInfo, { name: 'birddog', title: 'Birddog', version: '9.9.9' });
    assert.ok(init.result.capabilities.tools);
    assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, PROTOCOL_VERSIONS[0]);
    const { tools } = (await rpc('tools/list')).result;
    assert.deepEqual(tools.map((t) => t.name), ['list_items', 'get_item', 'list_sources', 'mark_done', 'snooze', 'restore']);
    for (const t of tools) assert.equal(t.inputSchema.type, 'object');
    assert.equal(tools.find((t) => t.name === 'list_items').annotations.readOnlyHint, true);
    assert.deepEqual((await rpc('ping')).result, {});
  });

  it('speaks JSON-RPC: notifications get no reply, unknown methods and tools are errors', async () => {
    const { mcp, rpc } = await setup();
    assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal((await rpc('resources/list')).error.code, -32601);
    assert.equal((await rpc('tools/call', { name: 'rm_rf' })).error.code, -32602);
    assert.equal((await mcp.handle({ hello: 'world' })).error.code, -32600);
    const batch = await mcp.handle([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
    assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 'a', result: {} }]);
  });

  it('list_items refreshes an empty cache, then filters by urgency and source', async () => {
    const { tool, src } = await setup();
    const all = await tool('list_items');
    assert.equal(src.calls, 1, 'no cache yet, so it refreshed');
    assert.equal(all.structuredContent.total, 2);
    const [first] = all.structuredContent.items;
    assert.deepEqual(first, {
      id: 'fake:now', source: 'fake', kind: 'thing', title: 'Fire', why: 'Hot now', urgency: 'now', status: 'open',
      url: 'https://example.com/fire', updatedAt: new Date(0).toISOString(), rule: null, nextStep: 'put-it-out', fields: { Where: 'kitchen' },
    });
    assert.match(all.content[0].text, /^2 open items, most urgent first:\n- \[now\] Fire\n {2}Hot now\n {2}id: fake:now/);
    await tool('list_items');
    assert.equal(src.calls, 1, 'fresh cache is reused');
    assert.deepEqual((await tool('list_items', { urgency: 'later' })).structuredContent.items.map((i) => i.id), ['fake:later']);
    assert.equal((await tool('list_items', { limit: 1 })).structuredContent.items.length, 1);
    assert.equal((await tool('list_items', { urgency: 'soon' })).isError, true);
    assert.match((await tool('list_items', { source: 'jira' })).content[0].text, /No source "jira"/);
  });

  it('mark_done, snooze and restore use the same state.json as the dashboard', async () => {
    const { dir, tool } = await setup();
    const done = await tool('mark_done', { id: 'fake:now' });
    assert.equal(done.structuredContent.status, 'done');
    assert.deepEqual((await tool('list_items')).structuredContent.items.map((i) => i.id), ['fake:later']);
    assert.deepEqual((await tool('list_items', { status: 'done' })).structuredContent.items.map((i) => i.id), ['fake:now']);

    const ui = new Triage({ dir }); // what the dashboard process has
    await ui.load();
    assert.equal(ui.data.items['fake:now'].status, 'done');

    const sn = await tool('snooze', { id: 'fake:later', until: '2h' });
    assert.equal(sn.structuredContent.status, 'snoozed');
    await ui.sync();
    assert.equal(ui.data.items['fake:later'].status, 'snoozed');
    assert.equal((await tool('snooze', { id: 'fake:later', until: 'yesterday' })).isError, true);

    await tool('restore', { id: 'fake:now' });
    assert.deepEqual((await tool('list_items')).structuredContent.items.map((i) => i.id), ['fake:now']);
    assert.match((await tool('get_item', { id: 'nope' })).content[0].text, /No item with id "nope"/);
    const detail = await tool('get_item', { id: 'fake:now' });
    assert.match(detail.content[0].text, /Why: Hot now[\s\S]*Next step: put-it-out[\s\S]*Where: kitchen/);
  });

  it('never exposes secrets or settings', async () => {
    const { tool } = await setup();
    const out = JSON.stringify([await tool('list_sources'), await tool('list_items', { status: 'all' }), await tool('get_item', { id: 'fake:now' })]);
    assert.doesNotMatch(out, /s3cret|fake-token|settings/);
    const { sources } = (await tool('list_sources')).structuredContent;
    assert.deepEqual(Object.keys(sources[0]).sort(), ['id', 'items', 'lastSuccess', 'name', 'status', 'summary']);
  });

  it('snooze targets', () => {
    const now = new Date(2026, 10, 4, 15, 0).getTime(); // Wednesday
    assert.equal(snoozeUntil('3h', now), new Date(now + 3 * 3_600_000).toISOString());
    assert.equal(snoozeUntil('tomorrow', now), new Date(2026, 10, 5, 9, 0).toISOString());
    assert.equal(snoozeUntil('next-week', now), new Date(2026, 10, 9, 9, 0).toISOString());
    assert.equal(snoozeUntil('change', now), 'change');
    assert.throws(() => snoozeUntil('2026-01-01', now), /future/);
  });
});

describe('demo mode', () => {
  it('fills every source with made-up data and never reaches the network', async () => {
    const demo = await createDemo();
    const app = await createBirddog({ ...demo.options, autoRefresh: false, log: quiet });
    try {
      const snap = await app.refresh();
      assert.deepEqual(snap.sources.map((s) => [s.id, s.status]), [['git', 'ok'], ['github', 'ok'], ['jira', 'ok'], ['cal', 'ok'], ['slack', 'ok'], ['teams', 'ok']]);
      for (const id of ['git', 'github', 'jira', 'cal', 'slack', 'teams']) assert.ok(snap.items.some((i) => i.source === id), `${id} has items`);
      assert.ok(snap.items.some((i) => i.urgency === 'now') && snap.items.some((i) => i.urgency === 'today') && snap.items.some((i) => i.urgency === 'later'));
      assert.ok(demo.options.dir.includes('birddog-demo-'));
      const res = await demoFetch()('https://example.org/anything');
      assert.equal(res.status, 404);
    } finally {
      await app.close();
      await demo.cleanup();
    }
    await assert.rejects(fs.stat(demo.options.dir), /ENOENT/);
  });
});

describe('birddog mcp (stdio, end to end)', () => {
  it('answers over stdin/stdout with nothing but JSON-RPC on stdout', async () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/birddog.mjs'), 'mcp', '--demo'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout });
    const replies = [];
    const waitFor = (n) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(replies)}`)), 20_000);
      lines.on('line', (l) => { replies.push(JSON.parse(l)); if (replies.length >= n) { clearTimeout(timer); resolve(); } });
    });
    const done = waitFor(3);
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_items', arguments: { urgency: 'now' } } });
    await done;
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    assert.deepEqual(replies.map((r) => r.id), [1, 2, 3]);
    assert.equal(replies[0].result.serverInfo.name, 'birddog');
    assert.equal(replies[1].result.tools.length, 6);
    assert.ok(replies[2].result.structuredContent.items.length > 0);
    assert.ok(replies[2].result.structuredContent.items.every((i) => i.urgency === 'now'));
  });
});
