// Thunderbird source: unread and starred mail in your Inboxes, read straight from
// Thunderbird's own files on this computer. No account, no token, no network.
//
// Thunderbird keeps each folder as an mbox file (one file, messages appended) and
// writes each message's flags into an X-Mozilla-Status header: read, replied, starred,
// deleted. Birddog reads the end of each Inbox (the newest mail), skips deleted
// messages, and lists what's unread or starred. It opens the files read-only and never
// changes them, so marking a message read in Thunderbird is how it leaves the list.
//
// Where it looks: the default profile in profiles.ini under
//   macOS    ~/Library/Thunderbird
//   Linux    ~/.thunderbird (also the Snap and Flatpak folders)
//   Windows  %APPDATA%\Thunderbird
// IMAP accounts are covered when Thunderbird keeps a local copy (the default:
// "Keep messages for this account on this computer").

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandHome, tildify } from '../config.mjs';
import { createItem } from '../items.mjs';
import { addressOf, classifyMail, MAIL_FIELDS, noiseNote, normalizeMailSettings } from '../mailsense.mjs';
import { plural, rank } from '../rules.mjs';

export const id = 'thunderbird';
export const name = 'Thunderbird';
export const description = 'Unread and starred mail in your Inboxes, read from Thunderbird on this computer.';
export const enabledByDefault = false;
export const setup = {
  fields: [
    { key: 'profile', label: 'Profile folder', placeholder: 'blank = Thunderbird\'s default profile', optional: true },
    { key: 'days', label: 'Unread mail from the last … days', placeholder: '7', optional: true },
    ...MAIL_FIELDS,
  ],
  token: null, // nothing secret: it's your own files
  notes: 'Birddog reads Thunderbird\'s mail files on this computer, read-only. Mark a message read (or unstar it) in Thunderbird and it leaves the list. IMAP accounts need "Keep messages on this computer", which is on by default.',
};

const TAIL_BYTES = 8 * 1024 * 1024; // the newest ~8 MB of each Inbox
const MAX_PER_ACCOUNT = 50;
const STARRED_DAYS = 30;
export const FLAGS = Object.freeze({ read: 0x1, replied: 0x2, starred: 0x4, deleted: 0x8 });

export function normalizeSettings(input = {}) {
  const profile = String(input.profile ?? '').trim();
  if (profile && !(path.isAbsolute(profile) || profile.startsWith('~'))) throw new TypeError('The profile folder must be a full path, like ~/Library/Thunderbird/Profiles/abcd1234.default-release');
  const rawDays = String(input.days ?? '').trim();
  const days = rawDays ? Number(rawDays) : 7;
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new TypeError('Days must be a whole number from 1 to 60');
  return { profile, days, ...normalizeMailSettings(input) };
}

/** prefs.js → your own addresses (mail.identity.*.useremail). */
export function identities(prefs) {
  return [...new Set([...String(prefs).matchAll(/user_pref\("mail\.identity\.[\w-]+\.useremail",\s*"([^"]+)"\);/g)].map((m) => m[1].toLowerCase()))];
}

/** Where Thunderbird keeps profiles.ini on this system. */
export function baseDirs({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return [path.join(home, 'Library', 'Thunderbird')];
  if (platform === 'win32') return [path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Thunderbird')];
  return [
    path.join(home, '.thunderbird'),
    path.join(home, 'snap', 'thunderbird', 'common', '.thunderbird'),
    path.join(home, '.var', 'app', 'org.mozilla.Thunderbird', '.thunderbird'),
  ];
}

/** profiles.ini → the default profile's folder (relative to base unless absolute). */
export function defaultProfile(ini, base) {
  const sections = [];
  let cur = null;
  for (const raw of String(ini).split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^\[(.+)\]$/.exec(line);
    if (h) { cur = { name: h[1] }; sections.push(cur); continue; }
    const kv = /^([^=;#]+)=(.*)$/.exec(line);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
  const at = (p, relative) => (relative ? path.join(base, ...p.split(/[\\/]/)) : p);
  // Thunderbird 68+ records the profile each install uses in an [Install…] section.
  const install = sections.find((s) => s.name.startsWith('Install') && s.Default);
  if (install) {
    const match = sections.find((s) => s.Path === install.Default);
    return at(install.Default, match ? match.IsRelative !== '0' : !path.isAbsolute(install.Default));
  }
  const profiles = sections.filter((s) => s.name.startsWith('Profile') && s.Path);
  const p = profiles.find((s) => s.Default === '1') ?? profiles[0];
  return p ? at(p.Path, p.IsRelative !== '0') : null;
}

/** prefs.js → the mail accounts and their folders. */
export function accountsFromPrefs(prefs, profileDir) {
  const servers = new Map();
  for (const m of String(prefs).matchAll(/user_pref\("mail\.server\.(server\d+)\.([\w.-]+)",\s*("(?:[^"\\]|\\.)*"|[^)]*)\);/g)) {
    const [, key, field, rawValue] = m;
    let value = rawValue.trim();
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { value = value.slice(1, -1); } }
    if (!servers.has(key)) servers.set(key, { key });
    servers.get(key)[field] = value;
  }
  const out = [];
  for (const s of servers.values()) {
    if (!['imap', 'pop3', 'none'].includes(s.type)) continue; // skip news and feeds
    const rel = typeof s['directory-rel'] === 'string' && s['directory-rel'].startsWith('[ProfD]') ? path.join(profileDir, ...s['directory-rel'].slice(7).split(/[\\/]/)) : null;
    const dir = rel ?? (typeof s.directory === 'string' ? s.directory : null);
    if (!dir) continue;
    const label = s.type === 'none' ? 'Local Folders' : s.userName && s.hostname ? `${s.userName} (${s.hostname})` : s.name || s.hostname || s.key;
    out.push({ key: s.key, type: s.type, dir, label });
  }
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** The file is read as latin1; raw 8-bit header text (allowed since RFC 6532) is usually UTF-8. */
function raw8bit(s) {
  if (!/[\x80-\xff]/.test(s)) return s;
  try { return utf8.decode(Buffer.from(s, 'latin1')); } catch { return s; }
}

/** Unfold and decode a message's headers. Keys are lowercase; the first value wins. */
export function parseHeaders(block) {
  const out = {};
  for (const line of String(block).replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
    const m = /^([!-9;-~]+):\s?(.*)$/.exec(line);
    if (m && !(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = raw8bit(m[2].trim());
  }
  return out;
}

function decodeBytes(bytes, charset) {
  try { return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

/** RFC 2047 encoded words: "=?UTF-8?B?SGk=?=" → "Hi". */
export function decodeWords(s) {
  return String(s ?? '')
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1')
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bq])\?([^?]*)\?=/gi, (whole, charset, enc, text) => {
      try {
        if (enc.toLowerCase() === 'b') return decodeBytes(Buffer.from(text, 'base64'), charset);
        const bin = text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
        return decodeBytes(Buffer.from(bin, 'latin1'), charset);
      } catch { return whole; }
    });
}

/** "Priya Shah <priya@x.com>" → "Priya Shah". */
export function senderName(from) {
  const v = decodeWords(from).trim();
  const m = /^"?([^"<]*?)"?\s*<([^>]+)>/.exec(v);
  if (m) return m[1].trim() || m[2].trim();
  return v.replace(/[<>]/g, '').trim() || null;
}

/**
 * The messages in a stretch of mbox text: [{ headers, flags }].
 * When the text is the end of a bigger file, the first (cut-off) message is dropped.
 */
export function mboxMessages(text, { partial = false } = {}) {
  const starts = [];
  // A separator is a "From " line followed by a header line; a body line that happens
  // to start with "From " (when it wasn't escaped as ">From ") is not.
  const re = /(^|\n)From [^\n]*\n(?=[!-9;-~]+:)/g;
  let m;
  while ((m = re.exec(text))) starts.push(m.index + m[1].length);
  const out = [];
  for (let n = partial ? 1 : 0; n < starts.length; n++) {
    const chunk = text.slice(starts[n], starts[n + 1] ?? text.length);
    const body = chunk.indexOf('\n') + 1;
    const end = chunk.search(/\r?\n\r?\n/);
    const headers = parseHeaders(chunk.slice(body, end < 0 ? chunk.length : end));
    const status = /^[0-9a-f]{4}$/i.test(headers['x-mozilla-status'] ?? '') ? parseInt(headers['x-mozilla-status'], 16) : null;
    out.push({ headers, flags: status });
  }
  return out;
}

async function readTail(file, bytes = TAIL_BYTES) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return { text: buf.toString('latin1'), partial: start > 0 }; // headers are ASCII; encoded words decode later
  } finally { await fh.close(); }
}

async function isFile(p) { try { return (await fs.stat(p)).isFile(); } catch { return false; } }

/** Find the profile folder: the setting, or Thunderbird's default. */
export async function findProfile(config = {}, opts = {}) {
  if (config.profile) {
    const p = expandHome(config.profile);
    if (!(await isFile(path.join(p, 'prefs.js')))) throw new Error(`No Thunderbird profile at ${tildify(p)} (there's no prefs.js in it)`);
    return p;
  }
  for (const base of baseDirs(opts)) {
    const ini = await fs.readFile(path.join(base, 'profiles.ini'), 'utf8').catch(() => null);
    if (!ini) continue;
    const p = defaultProfile(ini, base);
    if (p && (await isFile(path.join(p, 'prefs.js')))) return p;
  }
  throw new Error('Thunderbird isn\'t set up on this computer (no profiles.ini found). If it keeps its profile somewhere else, enter the profile folder in setup.');
}

async function inboxOf(account) {
  for (const n of ['INBOX', 'Inbox']) {
    const p = path.join(account.dir, n);
    if (await isFile(p)) return p;
  }
  return null;
}

/** Everything the source found, without ranking: for test() and collect(). */
export async function scan(config = {}, opts = {}) {
  const profile = await findProfile(config, opts);
  const prefs = await fs.readFile(path.join(profile, 'prefs.js'), 'utf8');
  const accounts = accountsFromPrefs(prefs, profile);
  const found = [];
  for (const a of accounts) {
    const file = await inboxOf(a);
    if (!file) continue; // no local copy (maildir stores and IMAP without offline mail are skipped)
    const { text, partial } = await readTail(file, opts.tailBytes);
    found.push({ account: a, file, messages: mboxMessages(text, { partial }) });
  }
  return { profile, accounts, inboxes: found, me: identities(prefs) };
}

export async function test(config = {}, ctx = {}) {
  try {
    const r = await scan(config, ctx.thunderbird);
    if (!r.inboxes.length) return { ok: false, message: `Found the profile at ${tildify(r.profile)}, but no Inbox with mail kept on this computer. Turn on "Keep messages for this account on this computer" in the account's Synchronization settings.` };
    const unread = r.inboxes.reduce((n, b) => n + b.messages.filter((m) => m.flags !== null && !(m.flags & FLAGS.deleted) && !(m.flags & FLAGS.read)).length, 0);
    return { ok: true, message: `Reading ${plural(r.inboxes.length, 'Inbox', 'Inboxes')} from ${tildify(r.profile)} · ${unread} unread recently` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const days = Number(config.days) || 7;
  const r = await scan(config, ctx.thunderbird);
  const items = [];
  // People you've replied to (from the Replied flag) count as people you correspond with.
  const known = new Set(r.inboxes.flatMap((b) => b.messages.filter((m) => m.flags !== null && m.flags & FLAGS.replied).map((m) => addressOf(m.headers.from))).filter(Boolean));
  let noise = 0;
  for (const { account, messages } of r.inboxes) {
    const seen = new Set();
    const mine = [];
    for (let n = messages.length - 1; n >= 0 && mine.length < MAX_PER_ACCOUNT; n--) { // newest first
      const { headers: h, flags } = messages[n];
      if (flags === null || flags & FLAGS.deleted) continue;
      const unread = !(flags & FLAGS.read);
      const starred = !!(flags & FLAGS.starred);
      const replied = !!(flags & FLAGS.replied);
      const at = Date.parse(h.date ?? '') || null;
      if (!at) continue;
      const ageDays = Math.max(0, (now - at) / 86_400_000);
      if (!((unread && ageDays <= days) || (starred && !replied && ageDays <= STARRED_DAYS))) continue;
      const msgId = h['message-id'] || `${h.date}|${h.subject}`;
      if (seen.has(msgId)) continue;
      seen.add(msgId);
      const by = senderName(h.from ?? '');
      const subject = decodeWords(h.subject ?? '').replace(/\s+/g, ' ').trim() || '(no subject)';
      const sense = starred ? { verdict: 'needs-you', reason: null } : classifyMail({ headers: { ...h, subject }, me: r.me, settings: config, known });
      if (sense.verdict === 'noise' && !config.showNoise) { noise++; continue; }
      const ranked = rank('email', { by, ageDays, unread, starred, replied, verdict: sense.verdict, reason: sense.reason });
      mine.push(createItem({
        id: `thunderbird:${crypto.createHash('sha256').update(`${account.dir}\n${msgId}`).digest('hex').slice(0, 20)}`,
        source: id, kind: 'email', title: subject.slice(0, 140), url: null,
        why: ranked.why, urgency: ranked.urgency, updatedAt: new Date(at).toISOString(),
        meta: { rule: ranked.rule, fingerprint: String(flags & (FLAGS.read | FLAGS.starred | FLAGS.replied)), fields: { From: decodeWords(h.from ?? '').slice(0, 120) || 'unknown', Account: account.label, Folder: 'Inbox', Received: new Date(at).toLocaleString(), ...(sense.reason ? { Why: `${sense.verdict}: ${sense.reason}` } : {}) } },
      }));
    }
    items.push(...mine);
  }
  const unread = items.filter((i) => i.meta.rule?.id !== 'email-starred').length;
  ctx.summary?.(`${plural(r.inboxes.length, 'Inbox', 'Inboxes')} · ${plural(unread, 'message')} waiting · ${plural(items.length - unread, 'starred')}${noiseNote(noise)}`);
  return items;
}
