import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_MODEL, echoContent, validateInput } from '../src/chat.mjs';
import { createDemo } from '../src/demo.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { fakeItem, tmpDir } from './helpers.mjs';

const KEY = 'sk-ant-test-0123456789abcdefghijklmnop';

/** SSE text for one model response, split into awkward chunks like a real network would. */
function sse(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const chunks = [];
  for (let i = 0; i < text.length; i += 37) chunks.push(new TextEncoder().encode(text.slice(i, i + 37)));
  return new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });
}
const textTurn = (text) => [
  { type: 'message_start', message: { id: 'msg_1', model: DEFAULT_MODEL, content: [] } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  ...text.match(/.{1,5}/g).map((t) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];
const toolTurn = (name, input, { raw } = {}) => {
  const json = raw ?? JSON.stringify(input);
  return [
    { type: 'message_start', message: { id: 'msg_2', model: DEFAULT_MODEL, content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${name}`, name, input: {} } },
    ...json.match(/.{1,4}/g).map((p) => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: p } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
};

function fakeAnthropic(script) {
  const requests = [];
  const fn = async (url, init) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return { ok: false, status: 404, text: async () => '' };
    requests.push({ headers: init.headers, body: JSON.parse(init.body) });
    const next = script.shift();
    if (typeof next === 'number') return { ok: false, status: next, text: async () => JSON.stringify({ error: { message: 'nope' } }) };
    return { ok: true, status: 200, body: sse(next) };
  };
  fn.requests = requests;
  return fn;
}

async function setup(script, { secretsEnv } = {}) {
  const dir = await tmpDir();
  const logs = [];
  const log = { warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), log() {} };
  const src = { id: 'fake', name: 'Fake', test: async () => ({ ok: true }), collect: async () => [fakeItem({ id: 'fake:fire', source: 'fake', title: 'Put out the fire', why: '**Hot**', urgency: 'now', meta: { fingerprint: 'f' } })] };
  const fetchImpl = fakeAnthropic(script);
  const secrets = secretsEnv ? await createSecretStore({ dir, backend: 'env', env: secretsEnv }) : await createSecretStore({ dir, backend: 'file' });
  const app = await createBirddog({ dir, sources: [src], autoRefresh: false, log, secrets, fetchImpl });
  const port = await app.start(0);
  await app.refresh();
  const call = async (p, method = 'GET', body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const text = await r.text();
    const ct = r.headers.get('content-type') ?? '';
    return { status: r.status, json: ct.includes('ndjson') ? text.trim().split('\n').map((l) => JSON.parse(l)) : JSON.parse(text) };
  };
  return { app, call, fetchImpl, secrets, logs };
}

describe('Ask Birddog (chat)', () => {
  it('is off until there is a key and consent, and never shows the key', async () => {
    const { app, call, secrets } = await setup([]);
    try {
      assert.deepEqual((await call('/api/chat/status')).json, { enabled: false, hasKey: false, keyFrom: null, keyVariable: null, consented: false, model: DEFAULT_MODEL });
      assert.equal((await call('/api/chat', 'POST', { message: 'hi' })).status, 409);
      assert.match((await call('/api/chat/setup', 'POST', { apiKey: KEY })).json.error, /Agree that inbox content is sent to Anthropic/);
      assert.equal((await call('/api/chat/setup', 'POST', { apiKey: 'short', consent: true })).status, 400);
      const on = await call('/api/chat/setup', 'POST', { apiKey: KEY, consent: true });
      assert.equal(on.json.enabled, true);
      assert.equal(await secrets.get('anthropic-api-key'), KEY);
      assert.doesNotMatch(JSON.stringify(on.json) + JSON.stringify((await call('/api/setup')).json), /sk-ant/);
      const off = await call('/api/chat/setup', 'DELETE', {});
      assert.equal(off.json.enabled, false);
      assert.equal(await secrets.get('anthropic-api-key'), null);
    } finally { await app.close(); }
  });

  it('answers from the inbox: streams text and runs reading tools', async () => {
    const { app, call, fetchImpl, logs } = await setup([toolTurn('list_items', { urgency: 'now' }), textTurn('One thing: put out the fire.')]);
    try {
      await call('/api/chat/setup', 'POST', { apiKey: KEY, consent: true });
      const { json: events } = await call('/api/chat', 'POST', { message: 'What needs me now?' });
      assert.equal(events[0].type, 'session');
      assert.deepEqual(events.filter((e) => e.type === 'tool'), [{ type: 'tool', name: 'list_items', input: { urgency: 'now' } }]);
      assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'One thing: put out the fire.');
      assert.equal(events.at(-1).type, 'done');

      const [first, second] = fetchImpl.requests;
      assert.equal(first.headers['x-api-key'], KEY);
      assert.equal(first.headers['anthropic-version'], '2026-10-21');
      assert.equal(first.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
      assert.equal(first.body.model, 'claude-sonnet-5-5');
      assert.equal(first.body.stream, true);
      assert.equal(first.body.fallbacks, 'default');
      assert.ok(first.body.tools.every((t) => t.eager_input_streaming === true && t.input_schema.type === 'object'));
      assert.deepEqual(first.body.tools.map((t) => t.name), ['list_items', 'get_item', 'list_sources', 'mark_done', 'snooze', 'restore']);
      assert.equal(second.body.messages.length, 3, 'user, assistant tool call, tool result');
      assert.deepEqual(second.body.messages[1].content[0], { type: 'tool_use', id: 'toolu_list_items', name: 'list_items', input: { urgency: 'now' } });
      const result = second.body.messages[2].content[0];
      assert.equal(result.tool_use_id, 'toolu_list_items');
      assert.match(result.content, /Put out the fire/);
      assert.ok(!logs.some((l) => l.includes(KEY)), 'the key is never logged');

      // The next question continues the same conversation, thinking blocks passed back unchanged.
      fetchImpl.requests.length = 0;
    } finally { await app.close(); }
  });

  it('asks before changing anything; approve runs it, decline does not', async () => {
    const { app, call, fetchImpl } = await setup([
      toolTurn('mark_done', { id: 'fake:fire' }), textTurn('Done.'),
      toolTurn('snooze', { id: 'fake:fire', until: '2h' }), textTurn('Okay, I left it.'),
    ]);
    try {
      await call('/api/chat/setup', 'POST', { apiKey: KEY, consent: true });
      const ask = (await call('/api/chat', 'POST', { message: 'mark the fire done' })).json;
      const sessionId = ask[0].id;
      const confirm = ask.find((e) => e.type === 'confirm');
      assert.deepEqual(confirm, { type: 'confirm', id: 'toolu_mark_done', name: 'mark_done', summary: 'Mark done: Put out the fire' });
      assert.equal(app.triage.apply(app.collector.snapshot().items)[0].status, 'open', 'nothing changed yet');
      assert.equal((await call('/api/chat', 'POST', { sessionId, message: 'and?' })).status, 409, 'must answer first');

      const yes = (await call('/api/chat/confirm', 'POST', { sessionId, decisions: { toolu_mark_done: true } })).json;
      assert.deepEqual(yes.find((e) => e.type === 'changed'), { type: 'changed', id: 'toolu_mark_done', summary: 'Mark done: Put out the fire', ok: true });
      assert.equal(app.triage.apply(app.collector.snapshot().items)[0].status, 'done');

      await call('/api/chat', 'POST', { sessionId, message: 'snooze it instead' });
      const no = (await call('/api/chat/confirm', 'POST', { sessionId, decisions: { toolu_snooze: false } })).json;
      assert.equal(no.find((e) => e.type === 'declined').id, 'toolu_snooze');
      assert.equal(app.triage.apply(app.collector.snapshot().items)[0].status, 'done', 'still done, not snoozed');
      const last = fetchImpl.requests.at(-1).body.messages.at(-1).content[0];
      assert.match(last.content, /declined/);
      assert.equal(fetchImpl.requests.at(-1).body.messages.filter((m) => m.role === 'user').length, 4, 'one append-only conversation');
    } finally { await app.close(); }
  });

  it('never runs tools with invalid input or after a refusal', async () => {
    const refusal = [
      { type: 'message_start', message: { id: 'm', model: DEFAULT_MODEL } },
      { type: 'message_delta', delta: { stop_reason: 'refusal' } },
      { type: 'message_stop' },
    ];
    const { app, call, fetchImpl } = await setup([toolTurn('mark_done', null, { raw: '{"id": "fake:fi' }), textTurn('Sorry.'), refusal]);
    try {
      await call('/api/chat/setup', 'POST', { apiKey: KEY, consent: true });
      const ev = (await call('/api/chat', 'POST', { message: 'x' })).json;
      assert.ok(!ev.some((e) => e.type === 'confirm'));
      const bad = fetchImpl.requests[1].body.messages.at(-1).content[0];
      assert.equal(bad.is_error, true);
      assert.match(bad.content, /INVALID_INPUT/);
      const refused = (await call('/api/chat', 'POST', { message: 'y' })).json;
      assert.match(refused.find((e) => e.type === 'error').message, /declined/);
    } finally { await app.close(); }
  });

  it('explains API errors without leaking the key', async () => {
    const { app, call } = await setup([401]);
    try {
      await call('/api/chat/setup', 'POST', { apiKey: KEY, consent: true });
      const r = await call('/api/chat', 'POST', { message: 'hi' });
      assert.equal(r.status, 200, 'the stream has started; the error arrives as an event');
      assert.match(r.json.find((e) => e.type === 'error').message, /rejected the API key/);
      assert.equal(r.json.at(-1).type, 'done');
      assert.doesNotMatch(JSON.stringify(r.json), /sk-ant/);
    } finally { await app.close(); }
  });

  it('in Docker the key comes from ANTHROPIC_API_KEY', async () => {
    const { app, call } = await setup([], { secretsEnv: { ANTHROPIC_API_KEY: KEY } });
    try {
      const s = (await call('/api/chat/status')).json;
      assert.deepEqual([s.hasKey, s.keyFrom, s.enabled], [true, 'ANTHROPIC_API_KEY', false]);
      assert.match((await call('/api/chat/setup', 'POST', { apiKey: KEY, consent: true })).json.error, /ANTHROPIC_API_KEY/);
      assert.equal((await call('/api/chat/setup', 'POST', { consent: true })).json.enabled, true);
    } finally { await app.close(); }
  });

  it('helpers: input validation and echoing turns after a fallback', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 5 }, u: { type: 'string', enum: ['now'] } }, required: ['id'], additionalProperties: false };
    assert.equal(validateInput(schema, { id: 'a', limit: 3, u: 'now' }), null);
    assert.match(validateInput(schema, {}), /"id" is required/);
    assert.match(validateInput(schema, { id: 'a', limit: 9 }), /at most 5/);
    assert.match(validateInput(schema, { id: 'a', x: 1 }), /unknown field/);
    assert.match(validateInput(schema, { id: 'a', u: 'later' }), /one of now/);
    const echoed = echoContent([
      { type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'partial' }, { type: 'tool_use', id: 't', name: 'x', input: {}, _json: '{}' },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } }, { type: 'text', text: 'rest' },
    ]);
    assert.deepEqual(echoed.map((b) => b.type), ['text', 'fallback', 'text']);
    assert.ok(!('_json' in echoContent([{ type: 'tool_use', _json: '{}' }])[0]));
  });

  it('demo mode has a scripted stand-in that never reaches Anthropic', async () => {
    const demo = await createDemo();
    const app = await createBirddog({ ...demo.options, autoRefresh: false, log: { warn() {}, error() {} } });
    const port = await app.start(0);
    try {
      await app.refresh();
      const post = async (p, body) => (await (await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).text());
      assert.equal(JSON.parse(await post('/api/chat/setup', { consent: true })).demo, true);
      const events = (await post('/api/chat', { message: 'What needs me now?' })).trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(events.some((e) => e.type === 'tool' && e.name === 'list_items'));
      assert.match(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), /Here's what needs you first/);
    } finally { await app.close(); await demo.cleanup(); }
  });
});
