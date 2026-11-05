// Microsoft Teams source: 1:1 chats waiting for your reply, and @mentions of you in
// group and meeting chats. Read through Microsoft Graph with "Sign in with Microsoft
// Teams" (the "teams" sign-in in src/auth/oauth.mjs, delegated Chat.Read).
//
// Work or school accounts only: Graph has no chat API for personal Microsoft accounts.
// Chat.Read is a permission users can usually grant themselves; some organizations
// require an admin to approve every app, and then the sign-in page says so.
// Channel posts aren't read: that needs ChannelMessage.Read.All, which only an admin
// can grant.
//
// Reading never changes anything (no read receipts, no reactions). Birddog posts only
// when you turn on "Allow replies" (which adds ChatMessage.Send at your next sign-in)
// and send a reply (src/replies.mjs). A reply goes into the chat, as plain text: Teams
// only pings someone through a structured @mention, which Birddog never sends.

import { createItem } from '../items.mjs';
import { ReplyError } from '../replies.mjs';
import { plural, rank } from '../rules.mjs';
import { mapLimit } from './http.mjs';
import { jsonClient } from './web.mjs';

export const id = 'teams';
export const name = 'Microsoft Teams';
export const description = 'Chats waiting for your reply, and @mentions in group chats.';
export const enabledByDefault = false;
export const capabilities = Object.freeze(['reply']);
export const REPLY_SCOPE = 'ChatMessage.Send';
export const setup = Object.freeze({
  oauthOnly: true,
  oauth: 'teams',
  fields: [],
  token: null,
  notes: 'Work or school Microsoft 365 accounts. Birddog reads your chats (Chat.Read) and never marks anything read. If your organization makes an admin approve apps, the sign-in page will say so.',
  replyNote: 'Turning this on asks Microsoft for permission to send chat messages (ChatMessage.Send) the next time you sign in.',
});

// "Allow replies" is switched from the card (PUT /api/sources/teams/replies).
export function normalizeSettings() { return {}; }

const GRAPH = 'https://graph.microsoft.com/v1.0';
const WINDOW_DAYS = 7;
const MAX_CHATS = 50;
const MAX_GROUP_CHATS = 15; // group chats whose recent messages are checked for @mentions
const MESSAGES_PER_CHAT = 20;

async function client(ctx) {
  if (!ctx.oauth) throw new Error('Sign in with Microsoft Teams in setup.');
  const token = await ctx.oauth.accessToken('teams');
  return jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'Microsoft Teams', headers: { authorization: `Bearer ${token}` }, fix: 'Sign in with Microsoft Teams again in setup. If it keeps failing, your organization may not allow Birddog to read chats.' });
}

/** Teams message HTML to one line of plain text. @mentions become "@Name". */
export function plainText(body) {
  let t = String(body?.content ?? '');
  if (body?.contentType !== 'text') {
    t = t.replace(/<at\b[^>]*>(.*?)<\/at>/gi, '@$1').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, ' ').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
  }
  return t.replace(/\s+/g, ' ').trim();
}

const https = (u) => (/^https:\/\//.test(u ?? '') ? u : null);
const isMessage = (m) => m && (m.messageType ?? 'message') === 'message' && !m.deletedDateTime && !m.isDeleted;

export async function test(config = {}, ctx = {}) {
  try {
    const http = await client(ctx);
    const me = await http.get(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`);
    await http.get(`${GRAPH}/me/chats?$top=1`);
    return { ok: true, message: `Connected to Teams as ${me.mail ?? me.userPrincipalName ?? me.displayName ?? 'you'}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const warn = ctx.warn ?? (() => {});
  const http = await client(ctx);
  const me = await http.get(`${GRAPH}/me?$select=id,displayName`);
  const recent = (iso) => now - Date.parse(iso) <= WINDOW_DAYS * 86_400_000;
  const q = new URLSearchParams({ $expand: 'lastMessagePreview', $orderby: 'lastMessagePreview/createdDateTime desc', $top: String(MAX_CHATS) });
  const chats = ((await http.get(`${GRAPH}/me/chats?${q}`))?.value ?? []).filter((c) => c.lastMessagePreview?.createdDateTime && recent(c.lastMessagePreview.createdDateTime));
  const items = [];

  // 1:1 chats whose last message is someone else's: waiting for you.
  for (const c of chats.filter((x) => x.chatType === 'oneOnOne')) {
    const m = c.lastMessagePreview;
    const from = m.from?.user;
    if (!isMessage(m) || !from || from.id === me.id) continue;
    const by = from.displayName ?? 'someone';
    const at = Date.parse(m.createdDateTime);
    const r = rank('dm', { by, ageDays: (now - at) / 86_400_000 });
    items.push(createItem({
      id: `teams:chat:${c.id}`, source: id, kind: 'dm', title: `Teams chat with ${by} · ${plainText(m.body).slice(0, 90)}`,
      url: https(c.webUrl), why: r.why, urgency: r.urgency, updatedAt: new Date(at).toISOString(),
      meta: { rule: r.rule, fingerprint: m.id, fields: { From: by, Chat: '1:1' }, reply: { chatId: c.id, kind: 'chat', to: by, where: 'chat' } },
    }));
  }

  // Group and meeting chats: recent messages that @mention you.
  const groups = chats.filter((x) => x.chatType !== 'oneOnOne').slice(0, MAX_GROUP_CHATS);
  const scanned = await mapLimit(groups, 4, async (c) => {
    const mq = new URLSearchParams({ $top: String(MESSAGES_PER_CHAT), $orderby: 'createdDateTime desc' });
    const r = await http.get(`${GRAPH}/chats/${encodeURIComponent(c.id)}/messages?${mq}`).catch((err) => { warn(`Teams: ${err.message}`); return null; });
    return { c, messages: r?.value ?? [] };
  });
  for (const { c, messages } of scanned) {
    const where = c.topic?.trim() || (c.chatType === 'meeting' ? 'a meeting chat' : 'a group chat');
    // Already answered? Anything you posted after the mention counts.
    const lastMine = Math.max(0, ...messages.filter((m) => m.from?.user?.id === me.id).map((m) => Date.parse(m.createdDateTime)));
    for (const m of messages) {
      if (!isMessage(m) || m.from?.user?.id === me.id || !recent(m.createdDateTime)) continue;
      if (!(m.mentions ?? []).some((x) => x.mentioned?.user?.id === me.id)) continue;
      const at = Date.parse(m.createdDateTime);
      if (lastMine > at) continue;
      const by = m.from?.user?.displayName ?? 'someone';
      const r = rank('mention', { by, team: false, ageDays: (now - at) / 86_400_000 });
      items.push(createItem({
        id: `teams:mention:${c.id}:${m.id}`, source: id, kind: 'mention', title: `${where} · ${plainText(m.body).slice(0, 90)}`,
        url: https(m.webUrl) ?? https(c.webUrl), why: r.why, urgency: r.urgency, updatedAt: new Date(at).toISOString(),
        meta: { rule: r.rule, fingerprint: m.id, fields: { Chat: where, From: by }, reply: { chatId: c.id, kind: 'group', to: by, where } },
      }));
    }
  }
  ctx.summary?.(`${plural(items.filter((i) => i.kind === 'mention').length, 'mention')} · ${plural(items.filter((i) => i.kind === 'dm').length, 'chat')} waiting`);
  return items;
}

// ---------------------------------------------------------------------------
// Replying (the "reply" capability; see src/replies.mjs)

/** Who and where a reply goes. No network. */
export function replyTarget(item) {
  const r = item?.meta?.reply;
  if (!r?.chatId) return null;
  return r.kind === 'chat'
    ? { label: `Reply to ${r.to ?? 'them'} in Teams`, to: r.to ?? 'them', where: 'Teams chat', thread: false, canBroadcast: false }
    : { label: `Reply in ${r.where} (Teams)`, to: r.to ?? 'them', where: r.where, thread: false, canBroadcast: false };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const missingScope = () => new ReplyError(`Birddog can't send Teams messages yet: it needs the ${REPLY_SCOPE} permission. Sign in with Microsoft Teams again (on its card in Sources & settings) and allow sending messages.`, { code: 'missing_scope', status: 403, scope: REPLY_SCOPE });

/** Post a reply as you into the chat, as plain text (no @mentions, so it pings nobody extra). */
export async function reply(item, text, ctx = {}) {
  const r = item?.meta?.reply;
  if (!r?.chatId) throw new ReplyError('This Teams item has nowhere to reply to.', { code: 'not_allowed' });
  if (!ctx.oauth) throw new ReplyError('Sign in with Microsoft Teams in setup.', { code: 'not_allowed' });
  const granted = await ctx.oauth.grantedScopes?.('teams').catch(() => null);
  if (granted && !granted.some((s) => s.toLowerCase() === REPLY_SCOPE.toLowerCase())) throw missingScope();
  let token;
  try { token = await ctx.oauth.accessToken('teams'); } catch (e) { throw new ReplyError(`${e.message} Nothing was sent.`, { code: 'not_allowed', status: 401 }); }
  const wait = ctx.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await (ctx.fetch ?? fetch)(`${GRAPH}/chats/${encodeURIComponent(r.chatId)}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'birddog' },
        body: JSON.stringify({ body: { contentType: 'text', content: String(text) } }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ReplyError('Microsoft Teams is not reachable (are you offline?). Nothing was sent.');
    }
    if (res.status === 429) {
      const after = Math.max(1, Number(res.headers?.get?.('retry-after')) || 30);
      if (attempt < 2 && after <= 20) { await wait(after * 1000); continue; }
      throw new ReplyError(`Teams is rate limiting replies. Try again in ${after} seconds. Nothing was sent.`, { code: 'rate_limited', status: 429, retryAfter: after });
    }
    const data = await res.json().catch(() => null);
    if (res.ok) return { ok: true, url: https(data?.webUrl) ?? https(item.url) };
    const why = data?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new ReplyError('Teams rejected the sign-in. Sign in with Microsoft Teams again in setup. Nothing was sent.', { code: 'not_allowed', status: 401 });
    if (res.status === 403) {
      if (/scope|permission|ChatMessage\.Send|insufficient/i.test(why)) throw missingScope();
      throw new ReplyError(`Teams won't let you post in that chat (${why.slice(0, 120)}). Nothing was sent.`, { status: 403 });
    }
    if (res.status === 404) throw new ReplyError('That Teams chat is gone, or you left it. Nothing was sent.', { code: 'gone', status: 404 });
    throw new ReplyError(`Teams didn't take the reply: ${why.slice(0, 160)}`);
  }
}

/** Before you type: did the last sign-in grant ChatMessage.Send? */
export async function replyCheck(ctx = {}) {
  const granted = await ctx.oauth?.grantedScopes?.('teams').catch(() => null);
  if (!granted) return {};
  return granted.some((s) => s.toLowerCase() === REPLY_SCOPE.toLowerCase()) ? { missingScope: null } : { missingScope: REPLY_SCOPE };
}
