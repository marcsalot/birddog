// Your decisions about items (done, snoozed) and UI preferences, stored in state.json.
//
// Done and "snooze until it changes" remember the item's fingerprint. When the item
// changes (new commits, new files), it comes back, because it needs you again.
//
// Several processes may share state.json (the dashboard and `birddog mcp`), so
// every change first re-reads the file if someone else wrote it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprint } from './items.mjs';
import { DEFAULT_NOTIFY, normalizeNotify } from './notify.mjs';
import { isChoice } from './profiles.mjs';
import { readJson, writeJson } from './store.mjs';

const PRUNE_AFTER_MS = 30 * 86_400_000;

export const DEFAULT_PREFS = Object.freeze({
  palette: 'gold',
  mode: 'system',
  seenSetup: false,
  hiddenSources: [],
  notifications: DEFAULT_NOTIFY,
  railOpen: true,
  chatConsent: false,
  guideOpen: false,
  guideWidth: null,
  hideNextStep: false,
  profile: 'auto', // which profile is showing: auto, all, or a profile id (src/profiles.mjs)
});

const PREF_CHECKS = {
  palette: (v) => ['gold', 'violet', 'sunset'].includes(v),
  mode: (v) => ['light', 'dark', 'system'].includes(v),
  seenSetup: (v) => typeof v === 'boolean',
  hiddenSources: (v) => Array.isArray(v) && v.length < 50 && v.every((s) => typeof s === 'string' && s.length < 50),
  railOpen: (v) => typeof v === 'boolean',
  chatConsent: (v) => typeof v === 'boolean',
  guideOpen: (v) => typeof v === 'boolean',
  guideWidth: (v) => v === null || (Number.isInteger(v) && v >= 280 && v <= 2400),
  hideNextStep: (v) => typeof v === 'boolean',
  profile: isChoice,
};

export class Triage {
  constructor({ dir, now = () => Date.now() }) {
    this.file = path.join(dir, 'state.json');
    this.now = now;
    this.data = { version: 1, items: {}, prefs: { ...DEFAULT_PREFS } };
  }

  async load() {
    const d = await readJson(this.file, null);
    if (d) {
      const prefs = { ...DEFAULT_PREFS, ...d.prefs };
      try { prefs.notifications = normalizeNotify(d.prefs?.notifications ?? {}); } catch { prefs.notifications = { ...DEFAULT_NOTIFY }; }
      this.data = { version: 1, items: d.items ?? {}, prefs };
    }
    this.mtime = await this.#mtime();
  }

  async #mtime() {
    try { return (await fs.stat(this.file)).mtimeMs; } catch { return null; }
  }

  /** Pick up changes another process (say, `birddog mcp`) wrote to state.json. */
  async sync() {
    const m = await this.#mtime();
    if (m !== this.mtime) await this.load();
  }

  async save() {
    await writeJson(this.file, this.data);
    this.mtime = await this.#mtime();
  }

  /** Annotate items with status: 'open' | 'done' | 'snoozed'. Pure: does not change stored state. */
  apply(items) {
    const now = this.now();
    return items.map((it) => {
      const e = this.data.items[it.id];
      if (!e || e.fp !== fingerprint(it)) return { ...it, status: 'open' };
      if (e.status === 'done') return { ...it, status: 'done', doneAt: e.at };
      if (e.status === 'snoozed') {
        if (e.until === 'change') return { ...it, status: 'snoozed', snoozedUntil: 'change', snoozedAt: e.at };
        if (Date.parse(e.until) > now) return { ...it, status: 'snoozed', snoozedUntil: e.until, snoozedAt: e.at };
        return { ...it, status: 'open', wokeAt: e.until };
      }
      return { ...it, status: 'open' };
    });
  }

  async done(item) {
    await this.sync();
    this.data.items[item.id] = { status: 'done', at: new Date(this.now()).toISOString(), fp: fingerprint(item), seen: this.now() };
    await this.save();
  }

  /** until: ISO date string in the future, or 'change'. */
  async snooze(item, until) {
    await this.sync();
    if (until !== 'change') {
      const t = Date.parse(until);
      if (Number.isNaN(t)) throw new RangeError('until must be an ISO date or "change"');
      until = new Date(t).toISOString();
    }
    this.data.items[item.id] = { status: 'snoozed', until, at: new Date(this.now()).toISOString(), fp: fingerprint(item), seen: this.now() };
    await this.save();
  }

  async restore(id) {
    await this.sync();
    delete this.data.items[id];
    await this.save();
  }

  /** Forget decisions about items that have not been seen for a month. */
  async prune(currentItems) {
    await this.sync();
    const live = new Set(currentItems.map((i) => i.id));
    const now = this.now();
    let changed = false;
    for (const [id, e] of Object.entries(this.data.items)) {
      if (live.has(id)) { if (now - (e.seen ?? 0) > 3_600_000) { e.seen = now; changed = true; } continue; }
      if (now - (e.seen ?? 0) > PRUNE_AFTER_MS) { delete this.data.items[id]; changed = true; }
    }
    if (changed) await this.save();
  }

  get prefs() { return { ...this.data.prefs }; }

  /** Merge valid prefs; returns the list of rejected keys. */
  async setPrefs(patch) {
    await this.sync();
    const rejected = [];
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (k === 'notifications') {
        // Partial updates merge into the current settings; bad values are rejected with a reason.
        try { this.data.prefs.notifications = normalizeNotify(v, this.data.prefs.notifications); } catch (e) { rejected.push(`notifications (${e.message})`); }
        continue;
      }
      if (PREF_CHECKS[k]?.(v)) this.data.prefs[k] = v;
      else rejected.push(k);
    }
    await this.save();
    return rejected;
  }
}
