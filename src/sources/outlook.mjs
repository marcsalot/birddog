// Outlook / Microsoft 365 mail: unread mail in your Inbox (last 7 days) and flagged mail,
// sorted into "needs you", FYI and noise (src/mailsense.mjs), using Outlook's own signals
// too: Focused vs Other, and whether the message has an unsubscribe link.
//
// "Sign in with Outlook mail" (the "msmail" sign-in on Birddog's Microsoft app) asks for
// Mail.ReadBasic: everything but message bodies and attachments. Read-only.

import { classifyMail, MAIL_FIELDS, mailItem, noiseNote, normalizeMailSettings } from '../mailsense.mjs';
import { plural } from '../rules.mjs';
import { jsonClient } from './web.mjs';

export const id = 'outlook';
export const name = 'Outlook mail';
export const description = 'Unread and flagged mail, sorted into what needs you, FYI and noise, with Focused Inbox. Never reads message bodies.';
export const enabledByDefault = false;
export const setup = Object.freeze({
  oauthOnly: true,
  oauth: 'msmail',
  fields: MAIL_FIELDS,
  token: null,
  notes: 'Work, school or personal Microsoft accounts. Birddog asks for Mail.ReadBasic: senders, subjects and flags, never what an email says. It never changes anything.',
});
export const normalizeSettings = normalizeMailSettings;

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,flag,importance,inferenceClassification,webLink,unsubscribeEnabled';
const WINDOW_DAYS = 7;

async function client(ctx) {
  if (!ctx.oauth) throw new Error('Sign in with Outlook mail in setup.');
  const token = await ctx.oauth.accessToken('msmail');
  return jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'Outlook', headers: { authorization: `Bearer ${token}` }, fix: 'Sign in with Outlook mail again in setup.' });
}

const fmt = (r) => (r?.emailAddress ? `${r.emailAddress.name ? `${r.emailAddress.name} ` : ''}<${r.emailAddress.address}>` : '');

/** A Graph message → the headers and hints mailsense understands. A mailing marked "high" is still a mailing. */
export function outlookSignals(m) {
  return {
    headers: { from: fmt(m.from), to: (m.toRecipients ?? []).map(fmt).join(', '), cc: (m.ccRecipients ?? []).map(fmt).join(', '), subject: m.subject ?? '', ...(m.unsubscribeEnabled ? { 'list-unsubscribe': 'yes' } : {}) },
    provider: { focused: m.inferenceClassification ? m.inferenceClassification === 'focused' : null, important: m.importance === 'high' && !m.unsubscribeEnabled, importantBy: 'the sender marked it high importance' },
  };
}

export async function test(config = {}, ctx = {}) {
  try {
    const http = await client(ctx);
    const me = await http.get(`${GRAPH}/me?$select=mail,userPrincipalName`);
    return { ok: true, message: `Connected to Outlook as ${me?.mail ?? me?.userPrincipalName ?? 'you'}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const http = await client(ctx);
  const me = await http.get(`${GRAPH}/me?$select=mail,userPrincipalName`);
  const mine = [me?.mail, me?.userPrincipalName].filter(Boolean).map((x) => x.toLowerCase());
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
  const get = async (filter, top) => (await http.get(`${GRAPH}/me/mailFolders/inbox/messages?${new URLSearchParams({ $filter: filter, $select: SELECT, $top: String(top) })}`))?.value ?? [];
  const byId = new Map();
  for (const m of [...(await get(`receivedDateTime ge ${since} and isRead eq false`, 60)), ...(await get("flag/flagStatus eq 'flagged'", 25))]) byId.set(m.id, m);
  const items = [];
  let noise = 0;
  for (const m of byId.values()) {
    const starred = m.flag?.flagStatus === 'flagged';
    const unread = m.isRead === false;
    const at = Date.parse(m.receivedDateTime) || now;
    const { headers, provider } = outlookSignals(m);
    const sense = starred ? { verdict: 'needs-you', reason: null } : classifyMail({ headers, me: mine, settings: config, provider });
    if (sense.verdict === 'noise' && !config.showNoise) { noise++; continue; }
    items.push(mailItem({ source: id, key: m.id, subject: m.subject, from: headers.from, at, unread, starred, replied: false, sense, now, url: m.webLink, account: mine[0] }));
  }
  ctx.summary?.(`${mine[0] ?? 'Outlook'} · ${plural(items.length, 'message')} worth a look${noiseNote(noise)}`);
  return items;
}
