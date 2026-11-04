// Slack source: messages that mention you, and direct messages waiting for your reply.
// A user token (xoxp-…) from your own Slack app with these scopes:
//   search:read (mentions), im:read + im:history (DMs), users:read (names)
//   chat:write, only if you want to reply from Birddog
// kept in your keychain. Reading never changes anything: Birddog doesn't react or mark
// anything read. It posts only when you turn on "Allow replies" and send a reply
// (see src/replies.mjs): as you, into the DM, or in the thread of a mention.

import { createItem } from '../items.mjs';
import { ReplyError } from '../replies.mjs';
import { plural, rank } from '../rules.mjs';
import { mapLimit } from './http.mjs';
import { jsonClient, tokenSetup } from './web.mjs';

export const id = 'slack';
export const name = 'Slack';
export const description = 'Mentions and direct messages waiting for your reply.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'slack-token' });
export const capabilities = Object.freeze(['reply']);
export const REPLY_SCOPE = 'chat:write';
export const setup = tokenSetup({
  fields: [],
  token: { label: 'User OAuth token (xoxp-…) with search:read, im:read, im:history, users:read', help: 'https://api.slack.com/apps', placeholder: 'xoxp-…' },
  notes: 'Create a Slack app for your workspace, add those four User Token Scopes, install it, and copy the User OAuth Token. To reply from Birddog, also add chat:write and reinstall.',
});

// "Allow replies" is switched on and off from the card (PUT /api/sources/slack/replies),
// so saving the token form never changes it.
export function normalizeSettings() { return {}; }

const WINDOW_DAYS = 7;
const MAX_DMS = 25;

async function client(ctx) {
  const token = await ctx.secret?.(secretFields.token);
  if (!token) throw new Error('Add a Slack user token (xoxp-…) in setup.');
  if (!token.startsWith('xoxp-')) throw new Error('Use a Slack user token (xoxp-…): bot tokens cannot see your mentions or DMs.');
  const http = jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'Slack', headers: { authorization: `Bearer ${token}` } });
  // Slack answers HTTP 200 with { ok: false, error } for most problems.
  return async (method, params = {}) => {
    const r = await http.get(`https://slack.com/api/${method}?${new URLSearchParams(params)}`);
    if (!r?.ok) {
      const e = r?.error ?? 'unknown_error';
      if (e === 'missing_scope') throw new Error(`Slack: the token is missing the ${r.needed ?? 'needed'} scope. Add it to your Slack app and reinstall it.`);
      if (['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'].includes(e)) throw new Error('Slack rejected the token. Copy the User OAuth Token again and update it in setup.');
      throw new Error(`Slack ${method}: ${e}`);
    }
    return r;
  };
}

const tsToMs = (ts) => Math.round(Number(ts) * 1000);

export async function test(config = {}, ctx = {}) {
  try {
    const api = await client(ctx);
    const me = await api('auth.test');
    return { ok: true, message: `Connected to ${me.team} as @${me.user}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const warn = ctx.warn ?? (() => {});
  const api = await client(ctx);
  const me = await api('auth.test');
  const items = [];
  const names = new Map();
  const nameOf = async (uid) => {
    if (!uid) return null;
    if (!names.has(uid)) names.set(uid, api('users.info', { user: uid }).then((r) => r.user?.profile?.display_name || r.user?.real_name || r.user?.name || uid, () => uid));
    return names.get(uid);
  };

  const search = await api('search.messages', { query: `<@${me.user_id}>`, sort: 'timestamp', sort_dir: 'desc', count: '30' }).catch((err) => { warn(err.message); return null; });
  for (const m of search?.messages?.matches ?? []) {
    if (m.user === me.user_id) continue;
    const at = tsToMs(m.ts);
    if (now - at > WINDOW_DAYS * 86_400_000) continue;
    const by = m.username || (await nameOf(m.user));
    const s = { by, team: false, ageDays: (now - at) / 86_400_000 };
    const r = rank('mention', s);
    const where = m.channel?.is_im ? 'a DM' : m.channel?.name ? `#${m.channel.name}` : 'Slack';
    const threadTs = m.thread_ts ?? threadFromLink(m.permalink) ?? m.ts;
    items.push(createItem({
      id: `slack:mention:${m.channel?.id ?? 'c'}:${m.ts}`, source: id, kind: 'mention', title: `${where} · ${String(m.text ?? '').replace(/<@[A-Z0-9]+>/g, '@…').slice(0, 90)}`,
      url: /^https:\/\//.test(m.permalink ?? '') ? m.permalink : null, why: r.why, urgency: r.urgency, updatedAt: new Date(at).toISOString(),
      meta: {
        rule: r.rule, fingerprint: m.ts, fields: { Channel: where, From: by ?? 'someone' },
        reply: m.channel?.id ? (m.channel.is_im
          ? { channel: m.channel.id, kind: 'dm', to: by ?? null }
          : { channel: m.channel.id, kind: 'thread', threadTs, where: m.channel.is_mpim ? 'a group DM' : m.channel.name ? `#${m.channel.name}` : 'the channel', to: by ?? null, broadcast: !m.channel.is_mpim }) : undefined,
      },
    }));
  }

  const ims = (await api('conversations.list', { types: 'im', limit: '200', exclude_archived: 'true' }).catch((err) => { warn(err.message); return null; }))?.channels ?? [];
  const latest = await mapLimit(ims.slice(0, MAX_DMS), 4, async (c) => {
    const h = await api('conversations.history', { channel: c.id, limit: '1' }).catch(() => null);
    return { c, m: h?.messages?.[0] };
  });
  for (const { c, m } of latest) {
    if (!m || m.user === me.user_id || m.bot_id || m.subtype) continue;
    const at = tsToMs(m.ts);
    if (now - at > WINDOW_DAYS * 86_400_000) continue;
    const by = await nameOf(m.user ?? c.user);
    const s = { by, ageDays: (now - at) / 86_400_000 };
    const r = rank('dm', s);
    const link = await api('chat.getPermalink', { channel: c.id, message_ts: m.ts }).then((x) => x.permalink, () => null);
    items.push(createItem({
      id: `slack:dm:${c.id}`, source: id, kind: 'dm', title: `DM from ${by ?? 'someone'} · ${String(m.text ?? '').slice(0, 90)}`,
      url: /^https:\/\//.test(link ?? '') ? link : null, why: r.why, urgency: r.urgency, updatedAt: new Date(at).toISOString(),
      meta: { rule: r.rule, fingerprint: m.ts, fields: { From: by ?? 'someone' }, reply: { channel: c.id, kind: 'dm', to: by ?? null } },
    }));
  }
  ctx.summary?.(`${me.team} · ${plural(items.filter((i) => i.kind === 'mention').length, 'mention')} · ${plural(items.filter((i) => i.kind === 'dm').length, 'DM')} waiting`);
  return items;
}

// ---------------------------------------------------------------------------
// Replying (the "reply" capability; see src/replies.mjs)

function threadFromLink(link) {
  try { return new URL(link).searchParams.get('thread_ts') || null; } catch { return null; }
}

/** Who and where a reply goes. No network. */
export function replyTarget(item) {
  const r = item?.meta?.reply;
  if (!r?.channel) return null;
  const who = r.to ? `@${r.to}` : 'them';
  return r.kind === 'dm'
    ? { label: `Reply to ${who} in DM`, to: who, where: 'DM', thread: false, canBroadcast: false }
    : { label: `Reply in thread in ${r.where}`, to: who, where: r.where, thread: true, canBroadcast: !!r.broadcast };
}

/**
 * Slack's plain-text rules: &, < and > must be escaped, or text like "<!channel>" or "<@U123>"
 * would turn into mentions. @channel / @here / @everyone that YOU typed (mentions: true, the
 * dashboard) become real mentions; text drafted by Fetch or an MCP client stays inert.
 */
export function slackText(text, { mentions = false } = {}) {
  let t = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (mentions) t = t.replace(/(^|[\s(])@(channel|here|everyone)\b/g, (_m, pre, w) => `${pre}<!${w}>`);
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function slackPost(ctx, method, body) {
  const token = await ctx.secret?.(secretFields.token);
  if (!token) throw new ReplyError('Add a Slack user token (xoxp-…) in setup.', { code: 'not_allowed' });
  const wait = ctx.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await (ctx.fetch ?? fetch)(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8', accept: 'application/json', 'user-agent': 'birddog' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ReplyError('Slack is not reachable (are you offline?). Nothing was sent.');
    }
    if (res.status === 429) {
      const after = Math.max(1, Number(res.headers?.get?.('retry-after')) || 30);
      // Slack's per-channel limit is about one message a second: wait briefly, twice at most.
      if (attempt < 2 && after <= 20) { await wait(after * 1000); continue; }
      throw new ReplyError(`Slack is rate limiting replies. Try again in ${after} seconds. Nothing was sent.`, { code: 'rate_limited', status: 429, retryAfter: after });
    }
    const r = await res.json().catch(() => null);
    if (r?.ok) return r;
    const e = r?.error ?? `HTTP ${res.status}`;
    if (e === 'missing_scope') {
      throw new ReplyError(`Your Slack token can't post yet: it needs the ${REPLY_SCOPE} scope. Add it under User Token Scopes in your Slack app, reinstall the app, and paste the new token in setup.`, { code: 'missing_scope', status: 403, scope: REPLY_SCOPE });
    }
    if (['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'].includes(e)) throw new ReplyError('Slack rejected the token. Copy the User OAuth Token again and update it in setup.', { code: 'not_allowed', status: 401 });
    if (['channel_not_found', 'not_in_channel', 'is_archived', 'restricted_action', 'cannot_dm_bot'].includes(e)) throw new ReplyError(`Slack won't let you post there (${e}).`, { status: 403 });
    if (e === 'msg_too_long') throw new ReplyError('Slack says that reply is too long.', { code: 'invalid' });
    throw new ReplyError(`Slack ${method}: ${e}`);
  }
}

/** Post a reply as you. DMs go into the DM; mentions in a channel go into that thread. */
export async function reply(item, text, ctx = {}, { broadcast = false, mentions = false } = {}) {
  const r = item?.meta?.reply;
  if (!r?.channel) throw new ReplyError('This Slack item has nowhere to reply to.', { code: 'not_allowed' });
  const body = { channel: r.channel, text: slackText(text, { mentions }), unfurl_links: false, unfurl_media: false };
  if (r.kind === 'thread') {
    body.thread_ts = r.threadTs;
    if (broadcast && r.broadcast) body.reply_broadcast = true;
  }
  const posted = await slackPost(ctx, 'chat.postMessage', body);
  const link = await slackPost(ctx, 'chat.getPermalink', { channel: posted.channel ?? r.channel, message_ts: posted.ts }).then((x) => x.permalink, () => null);
  return { ok: true, url: /^https:\/\//.test(link ?? '') ? link : null };
}

/** Before you type: does the token have chat:write? Slack lists a token's scopes in x-oauth-scopes. */
export async function replyCheck(ctx = {}) {
  const token = await ctx.secret?.(secretFields.token);
  if (!token) return { missingScope: null };
  const res = await (ctx.fetch ?? fetch)('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const scopes = res?.headers?.get?.('x-oauth-scopes');
  if (!scopes) return {}; // can't tell; sending will say so if it's missing
  return scopes.split(',').map((x) => x.trim()).includes(REPLY_SCOPE) ? { missingScope: null } : { missingScope: REPLY_SCOPE };
}

