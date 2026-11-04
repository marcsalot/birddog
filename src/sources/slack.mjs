// Slack source: messages that mention you, and direct messages waiting for your reply.
// A user token (xoxp-…) from your own Slack app with read-only scopes:
//   search:read (mentions), im:read + im:history (DMs), users:read (names)
// kept in your keychain. Read-only: Birddog never posts, reacts or marks anything read.

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { mapLimit } from './http.mjs';
import { jsonClient, tokenSetup } from './web.mjs';

export const id = 'slack';
export const name = 'Slack';
export const description = 'Mentions and direct messages waiting for your reply.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'slack-token' });
export const setup = tokenSetup({
  fields: [],
  token: { label: 'User OAuth token (xoxp-…) with search:read, im:read, im:history, users:read', help: 'https://api.slack.com/apps', placeholder: 'xoxp-…' },
  notes: 'Create a Slack app for your workspace, add those four User Token Scopes, install it, and copy the User OAuth Token.',
});

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
    items.push(createItem({
      id: `slack:mention:${m.channel?.id ?? 'c'}:${m.ts}`, source: id, kind: 'mention', title: `${where} · ${String(m.text ?? '').replace(/<@[A-Z0-9]+>/g, '@…').slice(0, 90)}`,
      url: /^https:\/\//.test(m.permalink ?? '') ? m.permalink : null, why: r.why, urgency: r.urgency, updatedAt: new Date(at).toISOString(),
      meta: { rule: r.rule, fingerprint: m.ts, fields: { Channel: where, From: by ?? 'someone' } },
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
      meta: { rule: r.rule, fingerprint: m.ts, fields: { From: by ?? 'someone' } },
    }));
  }
  ctx.summary?.(`${me.team} · ${plural(items.filter((i) => i.kind === 'mention').length, 'mention')} · ${plural(items.filter((i) => i.kind === 'dm').length, 'DM')} waiting`);
  return items;
}
