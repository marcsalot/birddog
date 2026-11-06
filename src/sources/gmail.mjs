// Gmail: unread mail in your Inbox (last 7 days) and starred mail, sorted into "needs
// you", FYI and noise (src/mailsense.mjs), using Gmail's own signals too: the Important
// marker and the Promotions / Social / Forums / Updates tabs.
//
// "Sign in with Gmail" (the "gmail" sign-in on Birddog's Google app) asks for
// gmail.metadata: message headers and labels only. Birddog can't read the body of any
// email, can't search, and can't change anything.

import { classifyMail, MAIL_FIELDS, mailItem, noiseNote, normalizeMailSettings } from '../mailsense.mjs';
import { plural } from '../rules.mjs';
import { mapLimit } from './http.mjs';
import { jsonClient } from './web.mjs';

export const id = 'gmail';
export const name = 'Gmail';
export const description = 'Unread and starred mail, sorted into what needs you, FYI and noise. Headers only, never message bodies.';
export const enabledByDefault = false;
export const setup = Object.freeze({
  oauthOnly: true,
  oauth: 'gmail',
  fields: MAIL_FIELDS,
  token: null,
  notes: 'Birddog asks Gmail for headers and labels only (gmail.metadata): it can\'t read what an email says, and it never changes anything.',
});
export const normalizeSettings = normalizeMailSettings;

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted'];
const WINDOW_DAYS = 7;
const STARRED_DAYS = 30;
const CATEGORY = { CATEGORY_PROMOTIONS: 'promotions', CATEGORY_SOCIAL: 'social', CATEGORY_FORUMS: 'forums', CATEGORY_UPDATES: 'updates', CATEGORY_PERSONAL: 'personal' };

async function client(ctx) {
  if (!ctx.oauth) throw new Error('Sign in with Gmail in setup.');
  const token = await ctx.oauth.accessToken('gmail');
  return jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'Gmail', headers: { authorization: `Bearer ${token}` }, fix: 'Sign in with Gmail again in setup.' });
}

/** Gmail's labels → the provider hints mailsense understands. */
export function gmailHints(labelIds = []) {
  const cat = labelIds.map((l) => CATEGORY[l]).find(Boolean) ?? null;
  return { important: labelIds.includes('IMPORTANT'), importantBy: 'Gmail marked it important', category: cat };
}

export async function test(config = {}, ctx = {}) {
  try {
    const http = await client(ctx);
    const me = await http.get(`${API}/profile`);
    return { ok: true, message: `Connected to Gmail as ${me?.emailAddress ?? 'you'}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const http = await client(ctx);
  const me = await http.get(`${API}/profile`);
  const list = async (labels, max) => (await http.get(`${API}/messages?${new URLSearchParams([...labels.map((l) => ['labelIds', l]), ['maxResults', String(max)]])}`))?.messages ?? [];
  const refs = new Map();
  for (const m of [...(await list(['INBOX', 'UNREAD'], 60)), ...(await list(['STARRED'], 25))]) refs.set(m.id, m);
  const q = new URLSearchParams([['format', 'metadata'], ...HEADERS.map((h) => ['metadataHeaders', h])]);
  const msgs = (await mapLimit([...refs.keys()], 5, (mid) => http.get(`${API}/messages/${encodeURIComponent(mid)}?${q}`).catch(() => null))).filter(Boolean);
  const items = [];
  let noise = 0;
  for (const m of msgs) {
    const labels = m.labelIds ?? [];
    const at = Number(m.internalDate) || now;
    const age = (now - at) / 86_400_000;
    const unread = labels.includes('UNREAD');
    const starred = labels.includes('STARRED');
    if (!((unread && labels.includes('INBOX') && age <= WINDOW_DAYS) || (starred && age <= STARRED_DAYS))) continue;
    const headers = Object.fromEntries((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
    const sense = starred ? { verdict: 'needs-you', reason: null } : classifyMail({ headers, me: [me.emailAddress ?? ''], settings: config, provider: gmailHints(labels) });
    if (sense.verdict === 'noise' && !config.showNoise) { noise++; continue; }
    items.push(mailItem({
      source: id, key: m.id, subject: headers.subject, from: headers.from, at, unread, starred, replied: false, sense, now,
      url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(me.emailAddress ?? '')}#all/${encodeURIComponent(m.threadId ?? m.id)}`, account: me.emailAddress,
    }));
  }
  ctx.summary?.(`${me.emailAddress ?? 'Gmail'} · ${plural(items.length, 'message')} worth a look${noiseNote(noise)}`);
  return items;
}
