// Runs every enabled source and keeps the last good result of each.
//
// If a source fails (network down, folder missing, git timed out) its previous
// items stay in the list, flagged `stale` with the time of the last success,
// so one broken source never empties your inbox.

import path from 'node:path';
import { createItem, sortItems } from './items.mjs';
import { readJson, writeJson } from './store.mjs';

const SOURCE_TIMEOUT_MS = 60_000;

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
   */
  constructor({ sources, dir, getConfig, now = () => Date.now(), timeoutMs = SOURCE_TIMEOUT_MS, log = console }) {
    this.sources = sources;
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
    const cfg = this.getConfig().sources ?? {};
    return this.sources.filter((s) => cfg[s.id]?.enabled !== false);
  }

  /** Refresh all enabled sources. Concurrent callers share one run. */
  refresh() {
    this.inflight ??= this.#run().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  get refreshing() { return !!this.inflight; }

  async #run() {
    const config = this.getConfig();
    await Promise.all(this.enabledSources().map(async (src) => {
      const prev = this.state[src.id] ?? { items: [] };
      const warnings = [];
      let summary = null;
      const started = this.now();
      try {
        const raw = await withTimeout(
          Promise.resolve().then(() => src.collect(config.sources?.[src.id] ?? {}, {
            now: started, warn: (w) => warnings.push(String(w)), summary: (s) => { summary = String(s); },
          })),
          this.timeoutMs, src.name);
        if (!Array.isArray(raw)) throw new Error(`${src.name} collect() must return an array`);
        const items = raw.map(createItem);
        for (const it of items) {
          if (it.source !== src.id) throw new Error(`${src.name} returned an item for source "${it.source}"`);
        }
        this.state[src.id] = { items, lastSuccess: started, lastAttempt: started, error: null, staleSince: null, warnings, summary };
      } catch (err) {
        this.log.warn?.(`birddog: ${src.name} failed: ${err.message}`);
        this.state[src.id] = {
          ...prev,
          items: prev.items ?? [],
          lastAttempt: started,
          error: err.message,
          staleSince: prev.staleSince ?? started,
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
