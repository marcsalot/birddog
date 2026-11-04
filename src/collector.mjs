// Runs every enabled source and keeps the last good result of each.
//
// If a source fails (network down, folder missing, git timed out) its previous
// items stay in the list, flagged `stale` with the time of the last success,
// so one broken source never empties your inbox.
//
// A source that keeps failing is retried less often by the scheduled refresh:
// 2, 4, 8, 16, 32 minutes, then hourly. Refreshing by hand, or "Retry" on the
// source, always tries right away.

import path from 'node:path';
import { createItem, sortItems } from './items.mjs';
import { isEnabled } from './sources/index.mjs';
import { readJson, writeJson } from './store.mjs';

const SOURCE_TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;

/** How long the scheduled refresh waits after the n-th failure in a row. */
export function backoffMs(failures) {
  return failures > 0 ? Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** failures) : 0;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export class Collector {
  /**
   * @param {object} opts
   * @param {Array} opts.sources        source modules
   * @param {string} opts.dir           config dir (cache.json lives here)
   * @param {() => object} opts.getConfig  returns the current config
   * @param {() => number} [opts.now]
   * @param {object} [opts.context]  services every source gets in ctx (fetch, secret(), github)
   */
  constructor({ sources, dir, getConfig, now = () => Date.now(), timeoutMs = SOURCE_TIMEOUT_MS, log = console, context = {} }) {
    this.sources = sources;
    this.context = context;
    this.file = path.join(dir, 'cache.json');
    this.getConfig = getConfig;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.state = {}; // sourceId → { items, lastSuccess, lastAttempt, error, staleSince, warnings, summary }
    this.refreshedAt = null;
    this.inflight = null;
  }

  async load() {
    const cache = await readJson(this.file, {});
    this.state = cache.sources ?? {};
    this.refreshedAt = cache.refreshedAt ?? null;
  }

  enabledSources() {
    const config = this.getConfig();
    return this.sources.filter((s) => isEnabled(s, config));
  }

  /**
   * Refresh enabled sources. Runs never overlap; callers asking for the same kind
   * of run while one is waiting or running share it.
   * @param {object} [opts]
   * @param {boolean} [opts.scheduled]  the timer's refresh: skip sources that are backing off
   * @param {string} [opts.only]        refresh just this source
   */
  refresh(opts = {}) {
    const key = `${!!opts.scheduled}|${opts.only ?? '*'}`;
    if (this.queued?.key === key) return this.queued.promise;
    if (!this.queued && this.running?.key === key) return this.running.promise;
    const entry = { key };
    entry.promise = (this.inflight ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.queued === entry) this.queued = null;
      this.running = entry;
      return this.#run(opts);
    }).finally(() => { if (this.running === entry) this.running = null; });
    this.queued = entry;
    const tracked = entry.promise.catch(() => {}).finally(() => { if (this.inflight === tracked) this.inflight = null; });
    this.inflight = tracked;
    return entry.promise;
  }

  get refreshing() { return !!this.inflight; }

  async #run({ scheduled = false, only = null } = {}) {
    const config = this.getConfig();
    const due = this.enabledSources().filter((src) => {
      if (only && src.id !== only) return false;
      const next = this.state[src.id]?.nextRetryAt;
      return !(scheduled && next && this.now() < next);
    });
    await Promise.all(due.map(async (src) => {
      const prev = this.state[src.id] ?? { items: [] };
      const warnings = [];
      let summary = null;
      const started = this.now();
      try {
        const raw = await withTimeout(
          Promise.resolve().then(() => src.collect(config.sources?.[src.id] ?? {}, {
            ...this.context,
            now: started, warn: (w) => warnings.push(String(w)), summary: (s) => { summary = String(s); },
          })),
          this.timeoutMs, src.name);
        if (!Array.isArray(raw)) throw new Error(`${src.name} collect() must return an array`);
        const items = raw.map(createItem);
        for (const it of items) {
          if (it.source !== src.id) throw new Error(`${src.name} returned an item for source "${it.source}"`);
        }
        this.state[src.id] = { items, lastSuccess: started, lastAttempt: started, error: null, staleSince: null, failures: 0, nextRetryAt: null, warnings, summary };
      } catch (err) {
        const failures = (prev.failures ?? 0) + 1;
        const nextRetryAt = started + backoffMs(failures);
        this.log.warn?.(`birddog: ${src.name} failed (${failures} in a row, next try ${new Date(nextRetryAt).toLocaleTimeString()}): ${err.message}`);
        this.state[src.id] = {
          ...prev,
          items: prev.items ?? [],
          lastAttempt: started,
          error: err.message,
          staleSince: prev.staleSince ?? started,
          failures,
          nextRetryAt,
          warnings,
        };
      }
    }));
    this.refreshedAt = this.now();
    await writeJson(this.file, { refreshedAt: this.refreshedAt, sources: this.state });
    return this.snapshot();
  }

  /** Items from every enabled source (stale ones flagged), plus per-source status. */
  snapshot() {
    const items = [];
    const sources = [];
    for (const src of this.enabledSources()) {
      const s = this.state[src.id];
      const status = !s ? 'pending' : s.error ? 'stale' : 'ok';
      sources.push({
        id: src.id,
        name: src.name,
        status,
        count: s?.items?.length ?? 0,
        lastSuccess: s?.lastSuccess ?? null,
        lastAttempt: s?.lastAttempt ?? null,
        staleSince: s?.staleSince ?? null,
        failures: s?.failures ?? 0,
        nextRetryAt: s?.error ? (s?.nextRetryAt ?? null) : null,
        error: s?.error ?? null,
        warnings: s?.warnings ?? [],
        summary: s?.summary ?? null,
      });
      for (const it of s?.items ?? []) {
        items.push(status === 'stale'
          ? { ...it, stale: { since: s.lastSuccess, error: s.error } }
          : it);
      }
    }
    return { items: sortItems(items), sources, refreshedAt: this.refreshedAt };
  }
}
