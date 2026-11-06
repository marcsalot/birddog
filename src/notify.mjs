// Desktop notifications.
//
// When an item becomes "now" (a review someone is waiting on, a meeting in ten
// minutes, an overdue ticket) or a source starts failing, Birddog can tell you:
//   • in the browser, with the Notification API, while a Birddog tab is open
//   • from the system (macOS osascript, Linux notify-send, Windows PowerShell)
//     when no tab is open, or always, if you prefer
//
// Rules:
//   • Never twice: each item (and each outage of a source) notifies at most once.
//     notified.json remembers what was announced, shared by every Birddog process.
//   • Nothing on the first run: whatever is already "now" when you switch
//     notifications on is taken as known, so you don't get a burst.
//   • Filters: per source, per kind, stale sources, quiet hours and "snooze all".
//     Anything filtered out still counts as announced, so it can't pop up later.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { readJson, writeJson } from './store.mjs';

const DAY = 86_400_000;
const FORGET_AFTER = 30 * DAY;
const CLAIM_GRACE_MS = 15_000; // give an open tab this long to show it first
const TAB_SEEN_MS = 120_000; // a tab that asked within this long counts as open
const OUTBOX_TTL_MS = 30 * 60_000;

export const CHANNELS = ['auto', 'browser', 'system'];

export const DEFAULT_NOTIFY = Object.freeze({
  enabled: false,
  channel: 'auto', // auto: the browser if a Birddog tab is open, otherwise the system
  sources: {}, // { github: false } switches a source off; missing = on
  kinds: {}, // { 'merged-branches': false }; missing = on
  staleSources: true,
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
  snoozeUntil: null, // ISO date: nothing until then
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,40}$/i;

/** Validate a notification settings patch; returns the merged settings or throws. */
export function normalizeNotify(patch, current = DEFAULT_NOTIFY) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('notifications must be an object');
  const out = structuredClone({ ...DEFAULT_NOTIFY, ...current });
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'enabled' || k === 'staleSources') {
      if (typeof v !== 'boolean') throw new TypeError(`${k} must be true or false`);
      out[k] = v;
    } else if (k === 'channel') {
      if (!CHANNELS.includes(v)) throw new TypeError(`channel must be one of ${CHANNELS.join(', ')}`);
      out.channel = v;
    } else if (k === 'sources' || k === 'kinds') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError(`${k} must be an object of true/false`);
      for (const [id, on] of Object.entries(v)) {
        if (!ID.test(id) || typeof on !== 'boolean') throw new TypeError(`${k}.${id} must be true or false`);
        out[k][id] = on;
      }
      if (Object.keys(out[k]).length > 100) throw new TypeError(`too many ${k}`);
    } else if (k === 'quietHours') {
      const q = { ...out.quietHours, ...v };
      if (typeof q.enabled !== 'boolean' || !HHMM.test(q.start) || !HHMM.test(q.end)) throw new TypeError('quietHours needs enabled, and start/end as HH:MM');
      out.quietHours = { enabled: q.enabled, start: q.start, end: q.end };
    } else if (k === 'snoozeUntil') {
      if (v !== null && Number.isNaN(Date.parse(v))) throw new TypeError('snoozeUntil must be a date or null');
      out.snoozeUntil = v === null ? null : new Date(v).toISOString();
    } else {
      throw new TypeError(`unknown notification setting "${k}"`);
    }
  }
  return out;
}

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Is `t` inside the quiet hours? Handles ranges over midnight (22:00–08:00). */
export function inQuietHours(q, t) {
  if (!q?.enabled) return false;
  const d = new Date(t);
  const now = d.getHours() * 60 + d.getMinutes();
  const a = minutes(q.start);
  const b = minutes(q.end);
  if (a === b) return true; // a full day of quiet
  return a < b ? now >= a && now < b : now >= a || now < b;
}

/** Why an event should not be shown right now (or null if it may be). */
export function suppressedBecause(settings, event, t) {
  if (!settings.enabled) return 'notifications are off';
  if (settings.snoozeUntil && Date.parse(settings.snoozeUntil) > t) return 'snoozed';
  if (inQuietHours(settings.quietHours, t)) return 'quiet hours';
  if (event.type === 'source' && !settings.staleSources) return 'stale-source notifications are off';
  if (settings.sources?.[event.source] === false) return `${event.source} notifications are off`;
  if (event.type === 'item' && settings.kinds?.[event.kind] === false) return `${event.kind} notifications are off`;
  return null;
}

const plain = (s) => String(s ?? '').replace(/\*\*/g, '');

// ---------------------------------------------------------------------------
// System notifications (no dependencies: the OS's own tools)

/** The command that shows a notification on this OS. Text goes in as arguments or env, never into a script. */
export function systemCommand(title, body, platform = process.platform) {
  const t = String(title).slice(0, 120);
  const b = String(body).slice(0, 240);
  if (platform === 'darwin') {
    return { cmd: 'osascript', args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', t, b] };
  }
  if (platform === 'linux') return { cmd: 'notify-send', args: ['--app-name=Birddog', t, b] };
  if (platform === 'win32') {
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$n = $x.GetElementsByTagName("text"); $n.Item(0).AppendChild($x.CreateTextNode($env:BIRDDOG_TITLE)) > $null; $n.Item(1).AppendChild($x.CreateTextNode($env:BIRDDOG_BODY)) > $null',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Birddog").Show([Windows.UI.Notifications.ToastNotification]::new($x))',
    ].join('; ');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], env: { BIRDDOG_TITLE: t, BIRDDOG_BODY: b } };
  }
  return null;
}

export function showSystemNotification(title, body, { platform = process.platform, run = execFile } = {}) {
  const c = systemCommand(title, body, platform);
  if (!c) return Promise.reject(new Error(`System notifications are not supported on ${platform}`));
  return new Promise((resolve, reject) => {
    run(c.cmd, c.args, { timeout: 10_000, windowsHide: true, env: { ...process.env, ...c.env } }, (err) => {
      if (err?.code === 'ENOENT') reject(new Error(`${c.cmd} is not installed${platform === 'linux' ? ' (install libnotify-bin)' : ''}`));
      else if (err) reject(err);
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// The notifier

/**
 * @param {object} o
 * @param {string} o.dir                 config dir (notified.json lives here)
 * @param {() => object} o.getSettings   current notification settings (from prefs)
 * @param {(title, body) => Promise} [o.system]  shows a system notification
 * @param {() => number} [o.now]
 */
export function createNotifier({ dir, getSettings, system = showSystemNotification, now = () => Date.now(), log = console }) {
  const file = path.join(dir, 'notified.json');
  let seen = null; // key → time first announced (or suppressed)
  let outbox = []; // { id, key, title, body, url, itemId, at, urgency }
  let seq = 0;
  let lastTabAt = 0;

  let loaded = false;
  async function load() {
    const d = await readJson(file, null);
    seen = d?.seen ?? null; // null = first run: take everything as known
    loaded = true;
  }
  const save = () => writeJson(file, { seen });

  function eventsFrom(items, sources) {
    const out = [];
    for (const it of items) {
      if (it.urgency !== 'now' || it.status !== 'open' || it.stale) continue;
      out.push({ type: 'item', key: `item:${it.id}`, itemId: it.id, source: it.source, kind: it.kind, title: it.title, body: plain(it.why), url: it.url ?? null });
    }
    for (const s of sources) {
      if (s.status !== 'stale' || !s.staleSince) continue;
      out.push({ type: 'source', key: `source:${s.id}:${s.staleSince}`, source: s.id, title: `${s.name} stopped refreshing`, body: `${s.error ?? 'It failed'}. Showing its last good data.`, url: null });
    }
    return out;
  }

  /**
   * Look at a fresh snapshot (items already annotated with done/snoozed status).
   * muted(event) → true marks an event as known without announcing it (profiles).
   * Returns the events that were queued for delivery.
   */
  async function observe({ items, sources, muted = () => false }) {
    if (!loaded) await load();
    const settings = getSettings();
    const t = now();
    const events = eventsFrom(items, sources);
    // First run: what's there now is known, not news. (While notifications are off,
    // everything is still marked as known, so switching them on never causes a burst.)
    const baseline = seen === null;
    if (seen === null) seen = {};
    const queued = [];
    for (const e of events) {
      if (seen[e.key]) continue;
      seen[e.key] = t;
      if (baseline) continue;
      if (muted(e)) continue; // outside the profile that's showing: known now, so switching later is no burst
      const why = suppressedBecause(settings, e, t);
      if (why) continue;
      const ev = { id: ++seq, at: t, ...e };
      outbox.push(ev);
      queued.push(ev);
    }
    for (const [k, at] of Object.entries(seen)) if (t - at > FORGET_AFTER) delete seen[k];
    await save();
    return queued;
  }

  /** A browser tab asks for what to show. canShow: it has notification permission. */
  function claim({ canShow = true } = {}) {
    const settings = getSettings();
    if (!canShow || settings.channel === 'system') return [];
    lastTabAt = now();
    const mine = outbox;
    outbox = [];
    return mine.map(({ id, title, body, url, itemId, type }) => ({ id, title, body, url, itemId, type }));
  }

  /** Hand unclaimed events to the system when no tab took them. Call every few seconds. */
  async function flush() {
    const settings = getSettings();
    const t = now();
    outbox = outbox.filter((e) => t - e.at < OUTBOX_TTL_MS);
    if (settings.channel === 'browser') return 0;
    const tabOpen = t - lastTabAt < TAB_SEEN_MS;
    const due = outbox.filter((e) => settings.channel === 'system' || (!tabOpen && t - e.at >= CLAIM_GRACE_MS));
    if (!due.length) return 0;
    outbox = outbox.filter((e) => !due.includes(e));
    // One at a time, a burst is merged into one summary notification.
    const batch = due.length > 3
      ? [{ title: `${due.length} things need you now`, body: due.slice(0, 3).map((e) => e.title).join(' · ') }]
      : due;
    for (const e of batch) await system(e.title, e.body).catch((err) => log.warn?.(`birddog: could not show a notification: ${err.message}`));
    return due.length;
  }

  return {
    load,
    observe,
    claim,
    flush,
    /** For the "Send a test notification" button. */
    async test(channel = getSettings().channel) {
      const ev = { id: ++seq, at: now(), type: 'test', key: `test:${seq}`, title: 'Birddog test notification', body: 'This is how Birddog tells you when something needs you now.', url: null };
      if (channel === 'system') { await system(ev.title, ev.body); return { delivered: 'system' }; }
      outbox.push(ev);
      return { delivered: 'queued' };
    },
    get pending() { return outbox.length; },
  };
}
