// Your decisions about items (done, snoozed) and UI preferences, stored in state.json.
//
// Done and "snooze until it changes" remember the item's fingerprint. When the item
// changes (new commits, new files), it comes back, because it needs you again.

import path from 'node:path';
import { fingerprint } from './items.mjs';
import { readJson, writeJson } from './store.mjs';

const PRUNE_AFTER_MS = 30 * 86_400_000;

export const DEFAULT_PREFS = Object.freeze({
  palette: 'gold',
  mode: 'system',
  seenSetup: false,
  hiddenSources: [],
});

const PREF_CHECKS = {
  palette: (v) => ['gold', 'violet', 'sunset'].includes(v),
  mode: (v) => ['light', 'dark', 'system'].includes(v),
  seenSetup: (v) => typeof v === 'boolean',
  hiddenSources: (v) => Array.isArray(v) && v.length < 50 && v.every((s) => typeof s === 'string' && s.length < 50),
};

export class Triage {
  constructor({ dir, now = () => Date.now() }) {
    this.file = path.join(dir, 'state.json');
    this.now = now;
    this.data = { version: 1, items: {}, prefs: { ...DEFAULT_PREFS } };
  }

  async load() {
    const d = await readJson(this.file, null);
    if (d) this.data = { version: 1, items: d.items ?? {}, prefs: { ...DEFAULT_PREFS, ...d.prefs } };
  }

  save() { return writeJson(this.file, this.data); }

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
    this.data.items[item.id] = { status: 'done', at: new Date(this.now()).toISOString(), fp: fingerprint(item), seen: this.now() };
    await this.save();
  }

  /** until: ISO date string in the future, or 'change'. */
  async snooze(item, until) {
    if (until !== 'change') {
      const t = Date.parse(until);
      if (Number.isNaN(t)) throw new RangeError('until must be an ISO date or "change"');
      until = new Date(t).toISOString();
    }
    this.data.items[item.id] = { status: 'snoozed', until, at: new Date(this.now()).toISOString(), fp: fingerprint(item), seen: this.now() };
    await this.save();
  }

  async restore(id) {
    delete this.data.items[id];
    await this.save();
  }

  /** Forget decisions about items that have not been seen for a month. */
  async prune(currentItems) {
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
    const rejected = [];
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (PREF_CHECKS[k]?.(v)) this.data.prefs[k] = v;
      else rejected.push(k);
    }
    await this.save();
    return rejected;
  }
}
