// Discord source: messages in your servers that @mention you (or a role you have) and
// that you haven't answered in that channel since.
//
// Discord gives personal apps no read access to your own account (user tokens and
// "self-bots" are against Discord's terms), so Birddog reads through a bot you create
// and invite to your servers:
//   1. discord.com/developers/applications → New Application → Bot → Reset Token, copy it
//   2. On the Bot page, switch on "Message Content Intent" (otherwise text is blank)
//   3. OAuth2 → URL Generator: scope "bot", permissions View Channels + Read Message
//      History; open the URL and add the bot to each server you want watched
// The bot sees only channels it's allowed in, and never your DMs. Read-only: GET only.
// The token is kept in your keychain.

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { mapLimit } from './http.mjs';
import { jsonClient, tokenSetup } from './web.mjs';

export const id = 'discord';
export const name = 'Discord';
export const description = '@mentions in your servers that you haven\'t answered, through a bot you invite.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'discord-token' });
export const setup = tokenSetup({
  fields: [
    { key: 'userId', label: 'Your Discord user ID', placeholder: '17–20 digits (Developer Mode → right-click yourself → Copy User ID)' },
    { key: 'guilds', label: 'Only these server IDs', placeholder: 'comma-separated; blank = every server the bot is in', optional: true },
  ],
  token: { label: 'Bot token', help: 'https://discord.com/developers/applications', placeholder: 'from Bot → Reset Token' },
  notes: 'Make an application, add a bot, switch on Message Content Intent, then invite it with View Channels and Read Message History. The bot sees only the servers and channels you let it in, and never your DMs.',
});

const SNOWFLAKE = /^\d{17,20}$/;
const API = 'https://discord.com/api/v10';
const WINDOW_DAYS = 7;
const MAX_CHANNELS = 40; // per server, the most recently active ones
const EPOCH = 1420070400000n;
const TEXT_TYPES = new Set([0, 5, 10, 11, 12]); // text, announcement, and threads

export function normalizeSettings(input = {}) {
  const userId = String(input.userId ?? '').trim();
  if (!SNOWFLAKE.test(userId)) throw new TypeError('Enter your Discord user ID: 17 to 20 digits. In Discord, turn on Developer Mode, right-click your name and choose Copy User ID.');
  const guilds = String(Array.isArray(input.guilds) ? input.guilds.join(',') : input.guilds ?? '').split(/[\s,]+/).filter(Boolean);
  const bad = guilds.find((g) => !SNOWFLAKE.test(g));
  if (bad) throw new TypeError(`"${bad}" isn't a server ID (17 to 20 digits)`);
  return { userId, guilds: guilds.join(', ') };
}

/** When a Discord id (snowflake) was made, in ms. */
export function snowflakeTime(sf) {
  try { return Number((BigInt(sf) >> 22n) + EPOCH); } catch { return 0; }
}

async function client(ctx) {
  const token = await ctx.secret?.(secretFields.token);
  if (!token) throw new Error('Add your Discord bot token in setup.');
  const http = jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'Discord', headers: { authorization: `Bot ${token.replace(/^Bot\s+/i, '')}` }, fix: 'Reset the bot token in the Discord developer portal and update it in setup.' });
  return (p) => http.get(`${API}${p}`);
}

export async function test(config = {}, ctx = {}) {
  try {
    if (!SNOWFLAKE.test(config.userId ?? '')) throw new Error('Add your Discord user ID in setup.');
    const api = await client(ctx);
    const me = await api('/users/@me');
    const guilds = await api('/users/@me/guilds');
    if (!guilds?.length) return { ok: false, message: `The bot ${me.username} isn't in any server yet. Invite it with the OAuth2 URL Generator (scope "bot").` };
    return { ok: true, message: `Connected as the bot ${me.username} in ${plural(guilds.length, 'server')}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

/** Does this message call on you: a direct @mention, a reply to you, or a role you have? */
export function mentionsYou(m, userId, roles = new Set()) {
  if (m.author?.id === userId) return false;
  if ((m.mentions ?? []).some((u) => u.id === userId)) return true;
  return (m.mention_roles ?? []).some((r) => roles.has(r));
}

const cleanText = (t) => String(t ?? '').replace(/<@!?\d+>/g, '@…').replace(/<@&\d+>/g, '@role').replace(/<#\d+>/g, '#…').replace(/\s+/g, ' ').trim();

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const warn = ctx.warn ?? (() => {});
  const userId = config.userId;
  if (!SNOWFLAKE.test(userId ?? '')) throw new Error('Add your Discord user ID in setup.');
  const api = await client(ctx);
  const only = new Set(String(config.guilds ?? '').split(/[\s,]+/).filter(Boolean));
  const guilds = (await api('/users/@me/guilds')).filter((g) => !only.size || only.has(g.id));
  const since = now - WINDOW_DAYS * 86_400_000;
  const items = [];
  let refused = 0;
  let blank = 0;

  for (const g of guilds) {
    const [channels, member, threads] = await Promise.all([
      api(`/guilds/${g.id}/channels`).catch((e) => { warn(`Discord ${g.name}: ${e.message}`); return []; }),
      api(`/guilds/${g.id}/members/${userId}`).catch(() => null), // for role mentions; you may not be in every server
      api(`/guilds/${g.id}/threads/active`).then((r) => r?.threads ?? [], () => []),
    ]);
    const roles = new Set(member?.roles ?? []);
    const names = new Map(channels.map((c) => [c.id, c.name]));
    const recent = [...channels, ...threads]
      .filter((c) => TEXT_TYPES.has(c.type) && c.last_message_id && snowflakeTime(c.last_message_id) >= since)
      .sort((a, b) => snowflakeTime(b.last_message_id) - snowflakeTime(a.last_message_id))
      .slice(0, MAX_CHANNELS);
    await mapLimit(recent, 3, async (c) => {
      let msgs;
      try { msgs = await api(`/channels/${c.id}/messages?limit=50`); } catch (e) {
        if (e.status === 403 || e.status === 404) { refused++; return; } // the bot isn't allowed in there
        throw e;
      }
      // Newest first. Your own later message in the channel counts as an answer.
      let answeredAt = 0;
      for (const m of msgs ?? []) {
        const at = Date.parse(m.timestamp);
        if (m.author?.id === userId) { answeredAt = Math.max(answeredAt, at); continue; }
        if (at < since || at <= answeredAt || !mentionsYou(m, userId, roles)) continue;
        if (!m.content) blank++;
        const by = m.member?.nick || m.author?.global_name || m.author?.username || 'someone';
        const thread = c.type >= 10 ? `${names.get(c.parent_id) ? `#${names.get(c.parent_id)} › ` : ''}${c.name}` : `#${c.name}`;
        const r = rank('mention', { by, team: !(m.mentions ?? []).some((u) => u.id === userId), ageDays: (now - at) / 86_400_000, where: 'Discord' });
        items.push(createItem({
          id: `discord:${c.id}:${m.id}`, source: id, kind: 'mention',
          title: `${g.name} ${thread} · ${cleanText(m.content).slice(0, 90) || '(message text hidden: switch on Message Content Intent)'}`,
          url: `https://discord.com/channels/${g.id}/${c.id}/${m.id}`, why: r.why, urgency: r.urgency, updatedAt: new Date(at).toISOString(),
          meta: { rule: r.rule, fingerprint: m.id, fields: { Server: g.name, Channel: thread, From: by } },
        }));
      }
    });
  }
  if (refused) warn(`Discord: the bot can't read ${plural(refused, 'channel')} (give it View Channels and Read Message History there if you want them)`);
  if (blank) warn('Discord: some messages came back without text. Switch on Message Content Intent on the bot\'s page in the developer portal.');
  ctx.summary?.(`${plural(guilds.length, 'server')} · ${plural(items.length, 'mention')} waiting`);
  return items;
}
