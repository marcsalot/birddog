// Which emails deserve your attention, and which are noise. Used by every mail source
// (Thunderbird, Gmail, Outlook). Deliberately boring, like the ranking rules: a few plain
// checks, in order, and each verdict says why.
//
//   needs-you  a person wrote to you (or a VIP, or it says "action required", or your
//              mail provider flagged it important / Focused)
//   fyi        a person, but you're only on CC, or Birddog can't tell
//   noise      newsletters, marketing, automated notifications (Birddog already shows
//              GitHub, Jira and the rest directly), muted senders
//
// Noise isn't listed unless you ask for it ("showNoise"); each source counts what it skipped.

import { createItem } from './items.mjs';
import { rank } from './rules.mjs';

const ROBOT = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|news(letter)?s?|marketing|promo(tions)?|hello|info|updates?|digest|support|billing|receipts?|team|community)([+._-].*)?@/i;
const ACTION = /\b(urgent|asap|action (required|needed)|please (review|approve|sign|confirm|respond|reply)|needs? your (approval|signature|review|input)|deadline|overdue|final notice|expires? (today|tomorrow)|by (eod|end of day|today|tomorrow))\b/i;
const NOTIFIERS = /(^|\.)(github\.com|gitlab\.com|atlassian\.net|atlassian\.com|slack\.com|linear\.app|sentry\.io|pagerduty\.com|dynatrace\.com|grafana\.net|discord\.com|notion\.so|figma\.com|jenkins|teams\.microsoft\.com)$/i;

/** "Dana <dana@x.com>" → "dana@x.com" (lowercase), or ''. */
export function addressOf(v) {
  const m = /<([^>]+)>/.exec(String(v ?? '')) ?? /([^\s<>",;]+@[^\s<>",;]+)/.exec(String(v ?? ''));
  return m ? m[1].trim().toLowerCase() : '';
}
/** Every address in a To / Cc header. */
export function addressesOf(v) {
  return [...String(v ?? '').matchAll(/[^\s<>",;:]+@[^\s<>",;]+/g)].map((m) => m[0].toLowerCase().replace(/[>.]+$/, ''));
}

/** "dana@x.com, @acme.com" → ['dana@x.com', '@acme.com'] (addresses and @domains). */
export function parsePeople(text) {
  return [...new Set(String(text ?? '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(x)))];
}
const matchesPerson = (addr, list) => !!addr && list.some((p) => (p.startsWith('@') ? addr.endsWith(p) : addr === p));

/** Settings every mail source takes. */
export function normalizeMailSettings(input = {}) {
  const yes = (v) => v === true || /^(yes|y|true|on|1)$/i.test(String(v ?? '').trim());
  return { vip: parsePeople(input.vip).join(', '), mute: parsePeople(input.mute).join(', '), showNoise: yes(input.showNoise) };
}
export const MAIL_FIELDS = Object.freeze([
  { key: 'vip', label: 'Always important (addresses or @domains)', placeholder: 'boss@acme.com, @bigclient.com', optional: true },
  { key: 'mute', label: 'Always noise (addresses or @domains)', placeholder: 'news@shop.com, @marketing.example', optional: true },
  { key: 'showNoise', label: 'Also list the noise (yes / no)', placeholder: 'no', optional: true },
]);

/**
 * @param {object} m
 * @param {object} m.headers      lowercase header map (from, to, cc, subject, list-unsubscribe, …)
 * @param {string[]} [m.me]       your addresses
 * @param {object} [m.settings]   { vip, mute } as saved
 * @param {Set<string>} [m.known] people you've replied to before
 * @param {object} [m.provider]   { important, category ('promotions'|'social'|'forums'|'updates'|'personal'), focused (true/false/null) }
 * @returns {{ verdict: 'needs-you'|'fyi'|'noise', reason: string }}
 */
export function classifyMail({ headers = {}, me = [], settings = {}, known = new Set(), provider = {} }) {
  const from = addressOf(headers.from);
  const vip = parsePeople(settings.vip);
  const mute = parsePeople(settings.mute);
  const mine = me.map((x) => x.toLowerCase());
  const to = addressesOf(headers.to);
  const cc = addressesOf(headers.cc);
  const subject = String(headers.subject ?? '');
  const domain = from.split('@')[1] ?? '';

  if (matchesPerson(from, vip)) return { verdict: 'needs-you', reason: 'from someone on your important list' };
  if (matchesPerson(from, mute)) return { verdict: 'noise', reason: 'from a sender you muted' };
  if (mine.includes(from)) return { verdict: 'noise', reason: 'sent by you' };
  if (['promotions', 'social', 'forums'].includes(provider.category)) return { verdict: 'noise', reason: `in ${provider.category[0].toUpperCase()}${provider.category.slice(1)}` };
  const precedence = String(headers.precedence ?? '').toLowerCase();
  const auto = String(headers['auto-submitted'] ?? '').toLowerCase();
  const bulk = !!headers['list-unsubscribe'] || !!headers['list-id'] || ['bulk', 'list', 'junk'].includes(precedence) || (auto && auto !== 'no') || !!headers['feedback-id'] || !!headers['x-campaign'] || !!headers['x-mailchimp-campaign'];
  if (NOTIFIERS.test(domain) && (bulk || ROBOT.test(from))) return { verdict: 'noise', reason: `a notification from ${domain} (Birddog can show that source directly)` };
  if (bulk && !provider.important) return { verdict: 'noise', reason: headers['list-unsubscribe'] ? 'a newsletter or mailing (it has an unsubscribe link)' : 'an automated or mailing-list message' };
  if (ROBOT.test(from) && !provider.important && !ACTION.test(subject)) return { verdict: 'noise', reason: 'from an automated address' };

  if (provider.important) return { verdict: 'needs-you', reason: provider.importantBy ?? 'marked important by your mail provider' };
  if (ACTION.test(subject)) return { verdict: 'needs-you', reason: `it says "${ACTION.exec(subject)[0].toLowerCase()}"` };
  if (known.has(from)) return { verdict: 'needs-you', reason: 'from someone you\'ve replied to before' };
  const direct = mine.length ? to.some((a) => mine.includes(a)) : null;
  const onlyCc = mine.length ? !direct && cc.some((a) => mine.includes(a)) : false;
  if (provider.focused === false && !direct) return { verdict: 'fyi', reason: 'in Other, not Focused' };
  if (onlyCc) return { verdict: 'fyi', reason: 'you\'re on CC' };
  if (direct === true) return { verdict: 'needs-you', reason: to.length > 6 ? 'sent to you and a crowd' : 'sent to you directly' };
  if (direct === false) return { verdict: 'fyi', reason: 'not addressed to you (a list or BCC)' };
  if (provider.focused === true) return { verdict: 'needs-you', reason: 'in your Focused inbox' };
  if (provider.category === 'updates') return { verdict: 'fyi', reason: 'in Updates' };
  return { verdict: 'needs-you', reason: 'from a person' };
}

/** "3 newsletters and notifications skipped" for a summary line. */
export const noiseNote = (n) => (n ? ` · ${n} noise skipped` : '');

// ---------------------------------------------------------------------------
// One email → an inbox item (Gmail and Outlook; Thunderbird builds its own the same way).


/** "Dana Smith <dana@x>" → "Dana Smith"; a bare address stays an address. */
export function displayName(from) {
  const v = String(from ?? '').trim();
  const m = /^"?([^"<]*?)"?\s*<([^>]+)>/.exec(v);
  return m ? (m[1].trim() || m[2].trim()) : v || null;
}

/**
 * @param {object} m { source, key, subject, from, at (ms), unread, starred, replied, sense, url, account, now }
 */
export function mailItem(m) {
  const by = displayName(m.from);
  const ageDays = Math.max(0, (m.now - m.at) / 86_400_000);
  const r = rank('email', { by, ageDays, unread: m.unread, starred: m.starred, replied: m.replied, verdict: m.sense.verdict, reason: m.sense.reason });
  return createItem({
    id: `${m.source}:${m.key}`, source: m.source, kind: 'email', title: String(m.subject || '(no subject)').replace(/\s+/g, ' ').slice(0, 140),
    url: /^https:\/\//.test(m.url ?? '') ? m.url : null, why: r.why, urgency: r.urgency, updatedAt: new Date(m.at).toISOString(),
    meta: { rule: r.rule, fingerprint: [m.unread, m.starred, m.replied].join('|'), fields: { From: String(m.from ?? 'unknown').slice(0, 120), Account: m.account ?? 'unknown', Received: new Date(m.at).toLocaleString(), ...(m.sense.reason ? { Why: `${m.sense.verdict}: ${m.sense.reason}` } : {}) } },
  });
}
