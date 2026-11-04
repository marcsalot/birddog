// Replying from Birddog (the "reply" capability), against a fake Slack. Nothing reaches the network.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_MODEL } from '../src/chat.mjs';
import { createMcpHandler } from '../src/mcp.mjs';
import { canReply, cleanReply, MAX_REPLY } from '../src/replies.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import * as git from '../src/sources/git.mjs';
import * as slack from '../src/sources/slack.mjs';
import { tmpDir } from './helpers.mjs';

const TOKEN = 'xoxp-test-not-a-real-token-123';
const ME = 'U0ME';
const KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
const NOW_S = Date.now() / 1000;
const DM_TS = (NOW_S - 600).toFixed(6);
const MENTION_TS = (NOW_S - 1200).toFixed(6);
const PARENT_TS = (NOW_S - 3600).toFixed(6);

/** A fake slack.com that records posts. opts.scopes: the x-oauth-scopes header; opts.post: override chat.postMessage. */
function fakeSlack(opts = {}) {
  const posts = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin === 'https://api.anthropic.com') return fn.anthropic(url, init);
    if (u.origin !== 'https://slack.com') return { ok: false, status: 404, headers: new Headers(), text: async () => '', json: async () => ({}) };
    if (init.headers?.authorization !== `Bearer ${TOKEN}`) throw new Error('fake slack: wrong token');
    const method = u.pathname.replace('/api/', '');
    const body = init.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams);
    const reply = (data, status = 200, headers = {}) => ({ ok: status < 400, status, headers: new Headers({ 'x-oauth-scopes': opts.scopes ?? 'search:read,im:read,im:history,users:read,chat:write', ...headers }), text: async () => JSON.stringify(data), json: async () => data });
    if (method === 'chat.postMessage') {
      const custom = opts.post?.(body, posts);
      if (custom) return custom;
      posts.push(body);
      return reply({ ok: true, channel: body.channel, ts: `${NOW_S.toFixed(0)}.00${posts.length}` });
    }
    if (method === 'chat.getPermalink') return reply({ ok: true, permalink: `https://acme.slack.com/archives/${body.channel}/p${String(body.message_ts).replace('.', '')}` });
    if (method === 'auth.test') return reply({ ok: true, team: 'Acme', user: 'me', user_id: ME });
    if (method === 'users.info') return reply({ ok: true, user: { name: body.user === 'U0TRI' ? 'tritonburn' : 'jonas', profile: {} } });
    if (method === 'search.messages') {
      return reply({ ok: true, messages: { matches: [{ ts: MENTION_TS, user: 'U0JON', text: `<@${ME}> can you look?`, channel: { id: 'C0NEW', name: 'new-channel' }, permalink: `https://acme.slack.com/archives/C0NEW/p${MENTION_TS.replace('.', '')}?thread_ts=${PARENT_TS}&cid=C0NEW` }] } });
    }
    if (method === 'conversations.list') return reply({ ok: true, channels: [{ id: 'D0TRI', user: 'U0TRI', is_im: true }] });
    if (method === 'conversations.history') return reply({ ok: true, messages: [{ ts: DM_TS, user: 'U0TRI', text: 'got a minute?' }] });
    return reply({ ok: false, error: 'unknown_method' });
  };
  fn.posts = posts;
  fn.anthropic = async () => ({ ok: false, status: 404, text: async () => '' });
  return fn;
}

async function setup({ allow = false, slackOpts, undoMs = 80, mcp } = {}) {
  const dir = await tmpDir();
  const secrets = await createSecretStore({ dir, backend: 'file' });
  await secrets.set('slack-token', TOKEN);
  const fetchImpl = fakeSlack(slackOpts);
  const logs = [];
  const log = { warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), log: (...a) => logs.push(a.join(' ')) };
  const fs = await import('node:fs/promises');
  await fs.writeFile(`${dir}/config.json`, JSON.stringify({ sources: { git: { enabled: false }, slack: { enabled: true, ...(allow ? { allowReplies: true } : {}) } }, ...(mcp ? { mcp } : {}) }));
  const app = await createBirddog({ dir, sources: [git, slack], autoRefresh: false, log, secrets, fetchImpl, replyUndoMs: undoMs });
  const port = await app.start(0);
  await app.refresh();
  const bodies = [];
  const call = async (p, method = 'GET', body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const text = await r.text();
    bodies.push(text);
    const ct = r.headers.get('content-type') ?? '';
    return { status: r.status, json: ct.includes('ndjson') ? text.trim().split('\n').map((l) => JSON.parse(l)) : JSON.parse(text) };
  };
  const items = async () => (await call('/api/items')).json.items;
  const dm = async () => (await items()).find((i) => i.id === 'slack:dm:D0TRI');
  const mention = async () => (await items()).find((i) => i.kind === 'mention');
  const until = async (pid, states = ['sent', 'failed']) => {
    for (let n = 0; n < 100; n++) {
      const r = (await call(`/api/replies/${pid}`)).json;
      if (states.includes(r.state)) return r;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('reply never finished');
  };
  return { app, call, items, dm, mention, until, fetchImpl, secrets, logs, bodies };
}

describe('replies: the capability', () => {
  it('Slack declares it; git does not', () => {
    assert.equal(canReply(slack), true);
    assert.equal(canReply(git), false);
    assert.deepEqual([...slack.capabilities], ['reply']);
  });

  it('shows on Slack items, off until "Allow replies"; the switch turns it on and off', async () => {
    const { app, call, dm, mention } = await setup();
    try {
      const d = await dm();
      assert.deepEqual([d.reply.label, d.reply.allowed, d.reply.thread], ['Reply to @tritonburn in DM', false, false]);
      assert.equal((await mention()).reply.label, 'Reply in thread in #new-channel');
      const card = (await call('/api/setup')).json.sources.find((s) => s.id === 'slack');
      assert.deepEqual([card.capabilities, card.replies], [['reply'], { allowed: false }]);
      assert.equal((await call('/api/setup')).json.sources.find((s) => s.id === 'git').replies, null);
      // Off: queueing is refused, nothing posts.
      const refused = await call(`/api/items/${encodeURIComponent(d.id)}/reply`, 'POST', { text: 'hi' });
      assert.deepEqual([refused.status, refused.json.code], [403, 'not_allowed']);
      const on = await call('/api/sources/slack/replies', 'PUT', { allow: true });
      assert.equal(on.json.sources.find((s) => s.id === 'slack').replies.allowed, true);
      assert.equal(app.config.sources.slack.allowReplies, true);
      assert.equal((await dm()).reply.allowed, true);
      assert.equal((await call('/api/sources/git/replies', 'PUT', { allow: true })).status, 400, 'git cannot reply');
      await call('/api/sources/slack/replies', 'PUT', { allow: false });
      assert.equal((await dm()).reply.allowed, false);
    } finally { await app.close(); }
  });
});

describe('replies: sending to Slack', () => {
  it('DM: posts into the DM channel after the undo window, links to it, and clears the item', async () => {
    const { app, call, dm, until, fetchImpl, bodies, logs } = await setup({ allow: true });
    try {
      const d = await dm();
      const q = (await call(`/api/items/${encodeURIComponent(d.id)}/reply`, 'POST', { text: '  On it, 5 min.  ' })).json;
      assert.equal(q.state, 'pending');
      assert.equal(fetchImpl.posts.length, 0, 'nothing goes out during the undo window');
      const r = await until(q.id);
      assert.equal(r.state, 'sent');
      assert.match(r.url, /^https:\/\/acme\.slack\.com\/archives\/D0TRI\//);
      assert.equal(fetchImpl.posts.length, 1);
      const post = fetchImpl.posts[0];
      assert.deepEqual([post.channel, post.text, post.thread_ts, post.reply_broadcast], ['D0TRI', 'On it, 5 min.', undefined, undefined]);
      assert.equal((await dm()).status, 'done', 'a DM you answered is no longer waiting');
      assert.doesNotMatch(bodies.join('\n') + logs.join('\n'), /xoxp-/, 'no token in any response or log');
    } finally { await app.close(); }
  });

  it('mention: replies in the thread, and "also send to channel" only when asked', async () => {
    const { app, call, mention, until, fetchImpl } = await setup({ allow: true });
    try {
      const m = await mention();
      assert.equal(m.reply.canBroadcast, true);
      const a = (await call(`/api/items/${encodeURIComponent(m.id)}/reply`, 'POST', { text: 'Looking now' })).json;
      await until(a.id);
      assert.deepEqual([fetchImpl.posts[0].channel, fetchImpl.posts[0].thread_ts, fetchImpl.posts[0].reply_broadcast], ['C0NEW', PARENT_TS, undefined]);
      await call(`/api/items/${encodeURIComponent(m.id)}/restore`, 'POST', {});
      const b = (await call(`/api/items/${encodeURIComponent(m.id)}/reply`, 'POST', { text: 'Fixed, everyone', broadcast: true })).json;
      await until(b.id);
      assert.equal(fetchImpl.posts[1].reply_broadcast, true);
      assert.equal((await mention()).status, 'done', 'a mention you answered counts as handled');
    } finally { await app.close(); }
  });

  it('undo: stops the reply before it goes out and hands the text back', async () => {
    const { app, call, dm, until, fetchImpl } = await setup({ allow: true, undoMs: 400 });
    try {
      const d = await dm();
      const q = (await call(`/api/items/${encodeURIComponent(d.id)}/reply`, 'POST', { text: 'Oops, wrong person' })).json;
      const again = await call(`/api/items/${encodeURIComponent(d.id)}/reply`, 'POST', { text: 'twice' });
      assert.equal(again.status, 409, 'one reply at a time per item');
      const u = (await call(`/api/replies/${q.id}/undo`, 'POST', {})).json;
      assert.deepEqual([u.state, u.text], ['undone', 'Oops, wrong person']);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(fetchImpl.posts.length, 0, 'never sent');
      assert.equal((await call(`/api/replies/${q.id}/undo`, 'POST', {})).status, 409);
      assert.equal((await dm()).status, 'open', 'still waiting for you');
      // Once it's gone out, undo is too late.
      const s = (await call(`/api/items/${encodeURIComponent(d.id)}/reply`, 'POST', { text: 'Real one' })).json;
      await until(s.id);
      assert.match((await call(`/api/replies/${s.id}/undo`, 'POST', {})).json.error, /Too late/);
    } finally { await app.close(); }
  });

  it('missing chat:write: the box says so before you type, and a send fails with the fix', async () => {
    const { app, call, dm, until, fetchImpl } = await setup({
      allow: true,
      slackOpts: { scopes: 'search:read,im:read,im:history,users:read', post: () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: false, error: 'missing_scope', needed: 'chat:write' }) }) },
    });
    try {
      const d = await dm();
      const details = (await call(`/api/items/${encodeURIComponent(d.id)}/reply`)).json;
      assert.equal(details.missingScope, 'chat:write');
      const q = (await call(`/api/items/${encodeURIComponent(d.id)}/reply`, 'POST', { text: 'hi' })).json;
      const r = await until(q.id);
      assert.deepEqual([r.state, r.error.code, r.error.scope], ['failed', 'missing_scope', 'chat:write']);
      assert.match(r.error.message, /needs the chat:write scope.*reinstall/);
      assert.equal(fetchImpl.posts.length, 0);
      assert.equal((await dm()).status, 'open', 'not cleared when nothing was sent');
    } finally { await app.close(); }
  });

  it('rate limits: waits out a short Retry-After, gives up on a long one', async () => {
    let calls = 0;
    const slept = [];
    const base = fakeSlack({ post: () => (++calls === 1 ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }), json: async () => ({}) } : null) });
    const ctx = { fetch: base, secret: async () => TOKEN, sleep: async (ms) => { slept.push(ms); } };
    const item = { source: 'slack', meta: { reply: { channel: 'D0TRI', kind: 'dm', to: 'tritonburn' } } };
    const r = await slack.reply(item, 'hello', ctx);
    assert.equal(r.ok, true);
    assert.deepEqual(slept, [2000]);
    assert.equal(base.posts.length, 1);
    const long = fakeSlack({ post: () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }), json: async () => ({}) }) });
    await assert.rejects(slack.reply(item, 'hello', { ...ctx, fetch: long }), (e) => e.code === 'rate_limited' && e.retryAfter === 90 && /Try again in 90 seconds\. Nothing was sent/.test(e.message));
  });

  it('plain text: escapes & < >, keeps @here inert unless you typed it in the dashboard, and limits length', () => {
    assert.equal(slack.slackText('a < b && c > d <!channel> <@U1>'), 'a &lt; b &amp;&amp; c &gt; d &lt;!channel&gt; &lt;@U1&gt;');
    assert.equal(slack.slackText('@here ping'), '@here ping');
    assert.equal(slack.slackText('@here ping, cc email@channel', { mentions: true }), '<!here> ping, cc email@channel');
    assert.throws(() => cleanReply('x'.repeat(MAX_REPLY + 1)), /up to 4000 characters/);
    assert.throws(() => cleanReply('   '), /Type a reply/);
    assert.equal(cleanReply('a\u0000b\r\nc'), 'ab\nc');
  });
});

describe('replies: MCP and Fetch', () => {
  const rpc = (h, name, args) => h.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const list = async (h) => (await h.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);

  it('MCP: the reply tool is off by default, even with Slack replies on', async () => {
    const { app, fetchImpl } = await setup({ allow: true });
    try {
      const h = createMcpHandler({ app, version: 't', refreshAfterMs: 1e9 });
      assert.ok(!(await list(h)).includes('reply'));
      const r = await rpc(h, 'reply', { id: 'slack:dm:D0TRI', text: 'hi' });
      assert.match(r.error?.message ?? r.result?.content?.[0]?.text, /Unknown tool|off/);
      assert.equal(fetchImpl.posts.length, 0);
    } finally { await app.close(); }
  });

  it('MCP: with mcp.allowReplies it posts exactly the text in the call, as plain text', async () => {
    const { app, fetchImpl } = await setup({ allow: true, mcp: { allowReplies: true } });
    try {
      const h = createMcpHandler({ app, version: 't', refreshAfterMs: 1e9 });
      assert.ok((await list(h)).includes('reply'));
      const listed = (await rpc(h, 'list_items', { source: 'slack' })).result.structuredContent.items;
      assert.equal(listed.find((i) => i.id === 'slack:dm:D0TRI').reply.to, 'Reply to @tritonburn in DM');
      const r = await rpc(h, 'reply', { id: 'slack:dm:D0TRI', text: '@here <b>ok</b>' });
      assert.equal(r.result.isError, undefined);
      assert.equal(fetchImpl.posts[0].text, '@here &lt;b&gt;ok&lt;/b&gt;', 'no @here from an agent');
      // The source switch still rules: off there means off for MCP too.
      app.config.sources.slack.allowReplies = false;
      await rpc(h, 'restore', { id: 'slack:dm:D0TRI' });
      const off = await rpc(h, 'reply', { id: 'slack:dm:D0TRI', text: 'again' });
      assert.match(off.result.content[0].text, /Replies are off for Slack/);
      assert.equal(fetchImpl.posts.length, 1);
    } finally { await app.close(); }
  });

  it('Fetch drafts a reply, shows the full text, and posts only after you confirm', async () => {
    const { app, call, fetchImpl } = await setup({ allow: true });
    const turns = [
      [{ type: 'message_start', message: { id: 'm1', model: DEFAULT_MODEL } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_r1', name: 'reply', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ id: 'slack:dm:D0TRI', text: 'Yes, free at 3.' }) } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
      [{ type: 'message_start', message: { id: 'm2', model: DEFAULT_MODEL } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sent.' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
    ];
    const seen = [];
    fetchImpl.anthropic = async (_u, init) => {
      seen.push(JSON.parse(init.body));
      const evs = turns.shift();
      const text = evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }) };
    };
    try {
      await call('/api/chat/setup', 'POST', { apiKey: KEY, consent: true });
      const { json: ev } = await call('/api/chat', 'POST', { message: 'reply to tritonburn that I am free at 3' });
      assert.ok(seen[0].tools.some((t) => t.name === 'reply'), 'Fetch can draft once Slack replies are on');
      const confirm = ev.find((e) => e.type === 'confirm');
      assert.equal(confirm.name, 'reply');
      assert.match(confirm.summary, /^Send as you \(Reply to @tritonburn in DM\):\n\nYes, free at 3\.$/);
      assert.equal(fetchImpl.posts.length, 0, 'nothing posted before you confirm');
      const sessionId = ev.find((e) => e.type === 'session').id;
      const { json: after } = await call('/api/chat/confirm', 'POST', { sessionId, decisions: { toolu_r1: true } });
      assert.ok(after.some((e) => e.type === 'changed' && e.ok));
      assert.deepEqual([fetchImpl.posts.length, fetchImpl.posts[0].text], [1, 'Yes, free at 3.']);
    } finally { await app.close(); }
  });

  it('Fetch: cancel means nothing is sent', async () => {
    const { app, call, fetchImpl } = await setup({ allow: true });
    const turns = [
      [{ type: 'message_start', message: { id: 'm1', model: DEFAULT_MODEL } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_r2', name: 'reply', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ id: 'slack:dm:D0TRI', text: 'nope' }) } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
      [{ type: 'message_start', message: { id: 'm2', model: DEFAULT_MODEL } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Okay.' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
    ];
    fetchImpl.anthropic = async () => {
      const text = turns.shift().map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }) };
    };
    try {
      await call('/api/chat/setup', 'POST', { apiKey: KEY, consent: true });
      const { json: ev } = await call('/api/chat', 'POST', { message: 'reply no' });
      const sessionId = ev.find((e) => e.type === 'session').id;
      const { json: after } = await call('/api/chat/confirm', 'POST', { sessionId, decisions: { toolu_r2: false } });
      assert.ok(after.some((e) => e.type === 'declined'));
      assert.equal(fetchImpl.posts.length, 0);
    } finally { await app.close(); }
  });
});
