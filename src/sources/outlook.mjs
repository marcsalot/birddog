// Outlook / Microsoft 365 mail: unread mail in your Inbox (last 7 days) and flagged mail,
// sorted into "needs you", FYI and noise (src/mailsense.mjs), using Outlook's own signals
// too: Focused vs Other, and whether the message has an unsubscribe link.
//
// "Sign in with Outlook mail" (the "msmail" sign-in on Birddog's Microsoft app) asks for
// Mail.ReadBasic: everything but message bodies and attachments. Read-only. Reading a
// message in Birddog is opt-in ("Read message text"): it adds Mail.Read at your next sign-in.

import { classifyMail, htmlToText, MAIL_FIELDS, mailItem, MAX_BODY, needsScope, noiseNote, normalizeMailSettings, READ_BODIES_FIELD } from '../mailsense.mjs';
import { plural } from '../rules.mjs';
import { jsonClient } from './web.mjs';

export const id = 'outlook';
export const name = 'Outlook mail';
export const description = 'Unread and flagged mail, sorted into what needs you, FYI and noise, with Focused Inbox. Never reads message bodies.';
export const enabledByDefault = false;
export const setup = Object.freeze({
  oauthOnly: true,
  oauth: 'msmail',
  fields: [...MAIL_FIELDS, READ_BODIES_FIELD],
  token: null,
  notes: 'Work, school or personal Microsoft accounts. Birddog asks for Mail.ReadBasic: senders, subjects and flags, never what an email says. It never changes anything.',
});
export const READ_SCOPE = 'Mail.Read';
export function normalizeSettings(input = {}) {
  return { ...normalizeMailSettings(input), readBodies: input.readBodies === true || /^(yes|y|true|on|1)$/i.test(String(input.readBodies ?? '').trim()) };
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SELECT = 'id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,flag,importance,inferenceClassification,webLink,unsubscribeEnabled';
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
    items.push(mailItem({ source: id, key: m.id, subject: m.subject, from: headers.from, at, unread, starred, replied: false, sense, now, url: m.webLink, account: mine[0], messageId: m.internetMessageId, app: 'Outlook' }));
  }
  ctx.summary?.(`${mine[0] ?? 'Outlook'} · ${plural(items.length, 'message')} worth a look${noiseNote(noise)}`);
  return items;
}

/** The message's text, for viewing in Birddog. Needs "Read message text" (Mail.Read). */
export async function message(item, ctx = {}, config = {}) {
  const ref = item?.meta?.mail;
  if (!ref?.id) throw new Error('This email has no message to show.');
  if (!config.readBodies) throw needsScope('Birddog only reads Outlook senders and subjects. To read emails here, set "Read message text" to yes on the Outlook mail card and sign in again.');
  const granted = await ctx.oauth?.grantedScopes?.('msmail').catch(() => null);
  if (granted && !granted.some((x) => x.toLowerCase() === READ_SCOPE.toLowerCase())) throw needsScope(`Sign in with Outlook mail again (on its card) and allow ${READ_SCOPE}, to read messages here.`);
  if (!ctx.oauth) throw new Error('Sign in with Outlook mail in setup.');
  const token = await ctx.oauth.accessToken('msmail');
  const q = new URLSearchParams({ $select: 'subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments' });
  const res = await (ctx.fetch ?? fetch)(`${GRAPH}/me/messages/${encodeURIComponent(ref.id)}?${q}`, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.body-content-type="text"', accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 403) throw needsScope(`Sign in with Outlook mail again (on its card) and allow ${READ_SCOPE}, to read messages here.`);
  if (!res.ok) throw new Error(`Outlook returned HTTP ${res.status}`);
  const m = await res.json();
  const raw = m.body?.content ?? '';
  const text0 = m.body?.contentType === 'html' ? htmlToText(raw) : raw;
  const text = text0.length > MAX_BODY ? `${text0.slice(0, MAX_BODY)}\n\n… (the rest is cut off; open it in Outlook to read it all)` : text0;
  return { subject: m.subject ?? '(no subject)', from: fmt(m.from), to: (m.toRecipients ?? []).map(fmt).join(', '), cc: (m.ccRecipients ?? []).map(fmt).join(', '), date: m.receivedDateTime ?? null, text, html: m.body?.contentType === 'html', attachments: m.hasAttachments ? ['(has attachments)'] : [] };
}
