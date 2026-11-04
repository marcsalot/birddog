// The local HTTP server: serves the UI from /public and a small JSON API.
// It binds to 127.0.0.1 only and rejects requests whose Host or Origin is not
// local, so other websites in your browser cannot read or change your data.

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Collector } from './collector.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { COMING_SOON, SOURCES, validateSource } from './sources/index.mjs';
import { Triage } from './triage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MAX_BODY = 64 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Send JSON with Content-Type: application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Body is not valid JSON'); }
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found');
  let data;
  try { data = await fs.readFile(file); } catch { throw new HttpError(404, 'Not found'); }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/**
 * Build a Birddog app. Nothing listens until you call start().
 * @param {object} opts
 * @param {string} opts.dir         config dir
 * @param {Array}  [opts.sources]   source modules (defaults to the built-in ones)
 * @param {string} [opts.cwd]       used to guess scan folders on first run
 * @param {boolean} [opts.autoRefresh=true]
 */
export async function createBirddog({ dir, sources = SOURCES, cwd, now, autoRefresh = true, log = console }) {
  sources.forEach(validateSource);
  const loaded = await loadConfig(dir, { cwd });
  let config = loaded.config;
  const collector = new Collector({ sources, dir, getConfig: () => config, now, log });
  const triage = new Triage({ dir, now });
  await Promise.all([collector.load(), triage.load()]);

  const findSource = (id) => {
    const s = sources.find((x) => x.id === id);
    if (!s) throw new HttpError(404, `No source called "${id}"`);
    return s;
  };

  function itemsPayload(snap = collector.snapshot()) {
    return { ...snap, items: triage.apply(snap.items), refreshing: collector.refreshing };
  }

  async function refresh() {
    const snap = await collector.refresh();
    await triage.prune(snap.items);
    return snap;
  }

  function setupPayload() {
    const snap = collector.snapshot();
    return {
      configFile: loaded.file,
      sources: sources.map((s) => {
        const status = snap.sources.find((x) => x.id === s.id);
        return {
          id: s.id,
          name: s.name,
          description: s.description ?? '',
          available: true,
          enabled: config.sources?.[s.id]?.enabled !== false,
          settings: config.sources?.[s.id] ?? {},
          status: status ?? null,
        };
      }),
      comingSoon: COMING_SOON.filter((c) => !sources.some((s) => s.id === c.id)),
    };
  }

  function findItem(id) {
    const it = collector.snapshot().items.find((i) => i.id === id);
    if (!it) throw new HttpError(404, 'That item is gone. Try refreshing.');
    return it;
  }

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ app: 'birddog', version: VERSION })],
    ['GET', /^\/api\/items$/, () => itemsPayload()],
    ['POST', /^\/api\/refresh$/, async () => itemsPayload(await refresh())],
    ['POST', /^\/api\/items\/([^/]+)\/done$/, async (m) => {
      await triage.done(findItem(m[1])); return { ok: true };
    }],
    ['POST', /^\/api\/items\/([^/]+)\/snooze$/, async (m, body) => {
      const until = body.until;
      if (until !== 'change' && !(typeof until === 'string' && Date.parse(until) > Date.now())) {
        throw new HttpError(400, 'until must be a future ISO date or "change"');
      }
      await triage.snooze(findItem(m[1]), until); return { ok: true };
    }],
    ['POST', /^\/api\/items\/([^/]+)\/restore$/, async (m) => { await triage.restore(m[1]); return { ok: true }; }],
    ['GET', /^\/api\/prefs$/, () => triage.prefs],
    ['PUT', /^\/api\/prefs$/, async (_m, body) => {
      const rejected = await triage.setPrefs(body);
      if (rejected.length) throw new HttpError(400, `Invalid preference: ${rejected.join(', ')}`);
      return triage.prefs;
    }],
    ['GET', /^\/api\/setup$/, () => setupPayload()],
    ['POST', /^\/api\/sources\/([^/]+)\/test$/, async (m, body) => {
      const src = findSource(m[1]);
      let patch = {};
      try { patch = Object.keys(body).length && src.normalizeSettings ? src.normalizeSettings(body) : {}; } catch (e) { return { ok: false, message: e.message }; }
      return src.test({ ...(config.sources?.[src.id] ?? {}), ...patch });
    }],
    ['PUT', /^\/api\/sources\/([^/]+)$/, async (m, body) => {
      const src = findSource(m[1]);
      if (!src.normalizeSettings) throw new HttpError(400, `${src.name} has no settings to change yet`);
      let patch;
      try { patch = src.normalizeSettings(body); } catch (e) { throw new HttpError(400, e.message); }
      config = { ...config, sources: { ...config.sources, [src.id]: { ...(config.sources?.[src.id] ?? {}), ...patch } } };
      await saveConfig(dir, config);
      await refresh();
      return setupPayload();
    }],
  ];

  async function handle(req, res) {
    const host = req.headers.host ?? '';
    if (!LOCAL_HOST.test(host)) throw new HttpError(403, 'Birddog only answers on localhost');
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let ok = false;
      try { ok = LOCAL_HOST.test(new URL(origin).host) && new URL(origin).host === host; } catch { /* bad origin */ }
      if (!ok) throw new HttpError(403, 'Cross-origin requests are not allowed');
    }
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }
    for (const [method, re, fn] of routes) {
      const m = re.exec(url.pathname);
      if (!m) continue;
      if (req.method !== method) continue;
      const params = m.map((x, i) => (i ? decodeURIComponent(x) : x));
      const body = method === 'GET' ? {} : await readBody(req);
      return send(res, 200, await fn(params, body));
    }
    throw new HttpError(404, 'Unknown API route');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status ?? 500;
      if (status === 500) log.error?.('birddog:', err);
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.end();
    });
  });

  let timer = null;

  return {
    server,
    collector,
    triage,
    get config() { return config; },
    configFile: loaded.file,
    firstRun: loaded.created,
    refresh,
    /** Listen on 127.0.0.1. Resolves with the bound port. */
    start(port = 0) {
      return new Promise((resolve, reject) => {
        const onError = (err) => { server.off('listening', onListen); reject(err); };
        const onListen = () => {
          server.off('error', onError);
          if (autoRefresh) {
            refresh().catch(() => {});
            const every = Math.max(1, Number(config.refreshMinutes) || 5) * 60_000;
            timer = setInterval(() => refresh().catch(() => {}), every);
            timer.unref();
          }
          resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(port, '127.0.0.1');
      });
    },
    async close() {
      clearInterval(timer);
      const closed = new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await closed;
      await collector.inflight?.catch(() => {});
    },
  };
}
