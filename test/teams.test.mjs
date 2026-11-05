// Microsoft Teams: the source (chats waiting on you, @mentions), its sign-in, and replies.
// Everything talks to a fake Microsoft Graph; nothing reaches the network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOAuth } from '../src/auth/oauth.mjs';
import { createDemo } from '../src/demo.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import * as teams from '../src/sources/teams.mjs';
import { tmpDir } from './helpers.mjs';

const NOW = Date.parse('2026-11-04T15:00:00Z');
const MIN = 60_000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const ME = { id: 'u-me', displayName: 'Sam' };
const PAT = { user: { id: 'u-pat', displayName: 'Pat Lee' } };
const YOU = { user: { id: 'u-me', displayName: 'Sam' } };
const msg = (id, from, html, agoMs, extra = {}) => ({ id, createdDateTime: ago(agoMs), messageType: 'message', from, body: { contentType: 'html', content: html }, ...extra });
const mentionOfMe = { mentions: [{ id: 0, mentionText: 'Sam', mentioned: { user: { id: 'u-me', displayName: 'Sam' } } }] };

/** A fake Graph. `chats` and `messages` can be changed between calls; every request is recorded. */
function fakeGraph({ chats, messages = {}, post } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u.href, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const json = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), text: async () => JSON.stringify(body), json: async () => body });
    if (u.origin !== 'https://graph.microsoft.com') return json({}, 404);
    const p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
    if (p === '/me') return json({ ...ME, mail: 'sam@acme.example' });
    if (p === '/me/chats') return json({ value: chats });
    const m = /^\/chats\/([^/]+)\/messages$/.exec(p);
    if (m && init.method === 'POST') return post ? post(m[1], JSON.parse(init.body), calls.filter((c) => c.method === 'POST').length) : json({ id: 'new', webUrl: 'https://teams.microsoft.com/l/message/new' }, 201);
    if (m) return json({ value: messages[m[1]] ?? [] });
    return json({ error: { message: 'nope' } }, 404);
  };
  fn.calls = calls;
  return fn;
}

const ctxFor = (fetchImpl, { scopes = 'User.Read Chat.Read ChatMessage.Send' } = {}) => ({
  now: NOW, fetch: fetchImpl, warn() {}, summary() {}, sleep: async () => {},
  oauth: { accessToken: async (p) => { assert.equal(p, 'teams'); return 'graph-token'; }, grantedScopes: async () => (scopes === null ? null : scopes.split(' ')) },
});

const CHATS = () => [
  { id: '19:pat', chatType: 'oneOnOne', webUrl: 'https://teams.microsoft.com/l/chat/19%3Apat/0', lastMessagePreview: msg('p1', PAT, '<p>Got a minute &amp; a coffee?</p>', 20 * MIN) },
  { id: '19:mine', chatType: 'oneOnOne', webUrl: 'https://teams.microsoft.com/l/chat/19%3Amine/0', lastMessagePreview: msg('y1', YOU, 'thanks!', 10 * MIN) },
  { id: '19:old', chatType: 'oneOnOne', webUrl: 'https://teams.microsoft.com/l/chat/19%3Aold/0', lastMessagePreview: msg('o1', PAT, 'old news', 9 * 86_400_000) },
  { id: '19:sys', chatType: 'oneOnOne', webUrl: 'javascript:alert(1)', lastMessagePreview: { ...msg('s1', PAT, 'joined', 5 * MIN), messageType: 'systemEventMessage' } },
  { id: '19:launch', chatType: 'group', topic: 'Launch crew', webUrl: 'https://teams.microsoft.com/l/chat/19%3Alaunch/0', lastMessagePreview: msg('l3', PAT, 'ok', 30 * MIN) },
  { id: '19:answered', chatType: 'group', topic: 'Answered', webUrl: 'https://teams.microsoft.com/l/chat/19%3Aanswered/0', lastMessagePreview: msg('a2', YOU, 'done', 5 * MIN) },
];
const MESSAGES = {
  '19:launch': [
    msg('l3', PAT, 'ok', 30 * MIN),
    msg('l2', PAT, '<p><at id="0">Sam</at> can you confirm the window?</p>', 60 * MIN, mentionOfMe),
    msg('l1', PAT, 'no mention here', 90 * MIN),
  ],
  '19:answered': [msg('a2', YOU, 'done', 5 * MIN), msg('a1', PAT, '<at id="0">Sam</at> ping', 50 * MIN, mentionOfMe)],
};

describe('Teams source', () => {
  it('turns Teams HTML into plain text', () => {
    assert.equal(teams.plainText({ contentType: 'html', content: '<p><at id="0">Sam</at> 5 &lt; 6 &amp; <b>bold</b><br>next&nbsp;line</p>' }), '@Sam 5 < 6 & bold next line');
    assert.equal(teams.plainText({ contentType: 'text', content: 'keep <b> as typed' }), 'keep <b> as typed');
  });

  it('collects 1:1 chats waiting on you and unanswered @mentions, and nothing else', async () => {
    const f = fakeGraph({ chats: CHATS(), messages: MESSAGES });
    const items = await teams.collect({}, ctxFor(f));
    assert.deepEqual(items.map((i) => i.id).sort(), ['teams:chat:19:pat', 'teams:mention:19:launch:l2']);
    const chat = items.find((i) => i.kind === 'dm');
    assert.equal(chat.title, 'Teams chat with Pat Lee · Got a minute & a coffee?');
    assert.equal(chat.url, 'https://teams.microsoft.com/l/chat/19%3Apat/0');
    assert.equal(chat.urgency, 'today');
    const mention = items.find((i) => i.kind === 'mention');
    assert.equal(mention.title, 'Launch crew · @Sam can you confirm the window?');
    assert.deepEqual(mention.meta.fields, { Chat: 'Launch crew', From: 'Pat Lee' });
    assert.ok(f.calls.every((c) => c.method === 'GET' && c.headers.authorization === 'Bearer graph-token'), 'reading only ever GETs');
    assert.ok(!f.calls.some((c) => c.url.includes('19%3Apat/messages') || c.url.includes('19:pat/messages')), '1:1 chats need no message scan');
  });

  it('says who and where a reply goes', () => {
    assert.deepEqual(teams.replyTarget({ meta: { reply: { chatId: '19:pat', kind: 'chat', to: 'Pat Lee' } } }), { label: 'Reply to Pat Lee in Teams', to: 'Pat Lee', where: 'Teams chat', thread: false, canBroadcast: false });
    assert.equal(teams.replyTarget({ meta: { reply: { chatId: '19:l', kind: 'group', to: 'Pat Lee', where: 'Launch crew' } } }).label, 'Reply in Launch crew (Teams)');
    assert.equal(teams.replyTarget({ meta: {} }), null);
  });
});

describe('Teams replies', () => {
  const item = { id: 'teams:chat:19:pat', url: 'https://teams.microsoft.com/l/chat/19%3Apat/0', meta: { reply: { chatId: '19:pat', kind: 'chat', to: 'Pat Lee' } } };

  it('posts plain text into the chat, as you, and links to it', async () => {
    const f = fakeGraph({ chats: [] });
    const r = await teams.reply(item, 'Sure <b>3pm</b> @everyone', ctxFor(f));
    assert.deepEqual(r, { ok: true, url: 'https://teams.microsoft.com/l/message/new' });
    const [post] = f.calls;
    assert.equal(post.method, 'POST');
    assert.match(post.url, /\/v1\.0\/chats\/19%3Apat\/messages$/);
    assert.equal(post.headers.authorization, 'Bearer graph-token');
    assert.deepEqual(post.body, { body: { contentType: 'text', content: 'Sure <b>3pm</b> @everyone' } }, 'plain text, no mentions array: it pings nobody extra');
  });

  it('without ChatMessage.Send it refuses before any request, and says how to fix it', async () => {
    const f = fakeGraph({ chats: [] });
    await assert.rejects(teams.reply(item, 'hi', ctxFor(f, { scopes: 'User.Read Chat.Read' })), (e) => e.code === 'missing_scope' && e.scope === 'ChatMessage.Send' && /Sign in with Microsoft Teams again/.test(e.message));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await teams.replyCheck(ctxFor(f, { scopes: 'User.Read Chat.Read' })), { missingScope: 'ChatMessage.Send' });
    assert.deepEqual(await teams.replyCheck(ctxFor(f)), { missingScope: null });
    assert.deepEqual(await teams.replyCheck(ctxFor(f, { scopes: null })), {}, 'unknown: let the send say');
  });

  it('maps Graph errors: 403 permission, 404 gone, 429 retried then explained', async () => {
    const json = (body, status, headers = {}) => ({ ok: false, status, headers: new Headers(headers), json: async () => body });
    const forbidden = fakeGraph({ chats: [], post: () => json({ error: { message: 'Missing scope permissions on the request.' } }, 403) });
    await assert.rejects(teams.reply(item, 'hi', ctxFor(forbidden, { scopes: null })), (e) => e.code === 'missing_scope');
    const gone = fakeGraph({ chats: [], post: () => json({ error: { message: 'NotFound' } }, 404) });
    await assert.rejects(teams.reply(item, 'hi', ctxFor(gone)), (e) => e.code === 'gone');
    const busy = fakeGraph({ chats: [], post: (_c, _b, n) => (n < 3 ? json({}, 429, { 'retry-after': '2' }) : { ok: true, status: 201, json: async () => ({ id: 'x' }) }) });
    assert.equal((await teams.reply(item, 'hi', ctxFor(busy))).ok, true, 'two short waits, then it goes through');
    const slow = fakeGraph({ chats: [], post: () => json({}, 429, { 'retry-after': '120' }) });
    await assert.rejects(teams.reply(item, 'hi', ctxFor(slow)), (e) => e.code === 'rate_limited' && e.retryAfter === 120 && /Nothing was sent/.test(e.message));
  });
});

describe('Teams sign-in', () => {
  async function oauth(config) {
    const dir = await tmpDir();
    const secrets = await createSecretStore({ dir, backend: 'file' });
    const tokenCalls = [];
    const fetchImpl = async (url, init) => {
      tokenCalls.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(init.body)) });
      return { ok: true, status: 200, json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'User.Read Chat.Read ChatMessage.Send' }) };
    };
    return { o: createOAuth({ dir, secrets, getConfig: () => config, fetchImpl, env: {}, builtIn: {} }), secrets, tokenCalls };
  }

  it('uses the Microsoft app and tenant, asks for Chat.Read, and adds ChatMessage.Send only when replies are on', async () => {
    const off = await oauth({ oauth: { microsoft: { clientId: 'ms-app', tenant: 'contoso.onmicrosoft.com' } } });
    const a = new URL((await off.o.start('teams', 'http://127.0.0.1:4747/auth/oauth/teams/callback')).url);
    assert.equal(a.origin + a.pathname, 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
    assert.equal(a.searchParams.get('client_id'), 'ms-app');
    assert.deepEqual(a.searchParams.get('scope').split(' '), ['offline_access', 'User.Read', 'Chat.Read']);

    const on = await oauth({ oauth: { microsoft: { clientId: 'ms-app' } }, sources: { teams: { allowReplies: true } } });
    const b = new URL((await on.o.start('teams', 'http://127.0.0.1:4747/auth/oauth/teams/callback')).url);
    assert.deepEqual(b.searchParams.get('scope').split(' '), ['offline_access', 'User.Read', 'Chat.Read', 'ChatMessage.Send']);
    await on.o.callback('teams', { state: b.searchParams.get('state'), code: 'c' });
    assert.ok(await on.secrets.get('oauth-teams'), 'Teams keeps its own tokens');
    assert.equal(await on.secrets.get('oauth-microsoft'), null, 'and never touches the calendar sign-in');
    assert.deepEqual(await on.o.grantedScopes('teams'), ['User.Read', 'Chat.Read', 'ChatMessage.Send']);
    assert.equal(on.tokenCalls[0].body.client_secret, undefined, 'a public client: no secret');

    const calendar = new URL((await on.o.start('microsoft', 'http://127.0.0.1:4747/auth/oauth/microsoft/callback')).url);
    assert.ok(!calendar.searchParams.get('scope').includes('Chat'), 'the calendar sign-in never asks for chats');
  });

  it('without a Microsoft app it says how to bring one', async () => {
    const { o } = await oauth({});
    await assert.rejects(o.start('teams', 'http://x/cb'), /oauth\.microsoft\.clientId .*BIRDDOG_MICROSOFT_CLIENT_ID/);
    assert.equal((await o.status('teams')).configured, false);
  });
});

describe('Teams in the demo', () => {
  it('shows a waiting chat and a mention, and a reply clears the chat', async () => {
    const demo = await createDemo();
    const app = await createBirddog({ ...demo.options, autoRefresh: false, log: { warn() {}, error() {} }, replyUndoMs: 0 });
    try {
      await app.refresh();
      const mine = () => app.collector.snapshot().items.filter((i) => i.source === 'teams');
      assert.deepEqual(mine().map((i) => i.kind).sort(), ['dm', 'mention']);
      const chat = mine().find((i) => i.kind === 'dm');
      assert.equal(app.replies.target(chat).label, 'Reply to Lena Ortiz in Teams');
      const sent = await app.replies.sendNow(chat.id, 'On it, before 4.');
      assert.equal(sent.ok, true);
      await app.refresh();
      assert.deepEqual(mine().map((i) => i.kind), ['mention'], 'your reply is now the last message, so the chat is no longer waiting');
    } finally { await app.close(); await demo.cleanup(); }
  });
});
