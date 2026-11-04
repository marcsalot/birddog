// The HTTP server: serves the UI from /public and a small JSON API.
//
// By default it binds to 127.0.0.1 and rejects requests whose Host or Origin is
// not local, so other websites in your browser cannot read or change your data.
// With `auth.enabled`, every page and API call also needs a signed-in session
// from your OpenID Connect provider, and Birddog may listen on other addresses.

import crypto from 'node:crypto';
import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubAuth } from './auth/github.mjs';
import { appleClientSecret, createOAuth, OAuthError, PROVIDERS as OAUTH_PROVIDERS } from './auth/oauth.mjs';
import { atlassianSite, googleAccount, graphAccount } from './sources/calendar-apis.mjs';
import { AuthError, checkAuthConfig, createOidc, isAllowed } from './auth/oidc.mjs';
import { createSessions } from './auth/session.mjs';
import { ChatError, createChat } from './chat.mjs';
import { Collector } from './collector.mjs';
import { createHistory } from './history.mjs';
import { createNotifier } from './notify.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { repoFolders } from './firstrun.mjs';
import { canReply, createReplies, ReplyError } from './replies.mjs';
import { RULES } from './rules.mjs';
import { createSecretStore } from './secrets.mjs';
import { COMING_SOON, isEnabled, SOURCES, validateSource } from './sources/index.mjs';
import { Triage } from './triage.mjs';

const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MAX_BODY = 64 * 1024;
const DAY = 86_400_000;
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
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const PUBLIC_PATHS = new Set(['/api/health', '/favicon.svg']); // reachable without signing in

export const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

class HttpError extends Error {
  /** extra: more fields for the JSON error body (e.g. { code: 'missing_scope' }); never secrets. */
  constructor(status, message, extra = null) { super(message); this.status = status; this.extra = extra; }
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

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}

/** Item kinds that can become "now" (and so can notify), for the settings screen. */
const KIND_LABELS = {
  incident: 'Incidents paged to you', meeting: 'Meetings about to start', 'review-request': 'Review requests waiting a day',
  issue: 'Assigned issues past their milestone', ticket: 'Tickets overdue or at sprint end', unpushed: 'Old unpushed commits',
};
/** Item kinds that can become "now" (and so can notify), for the settings screen. Kinds are shared across sources. */
function notifyKinds() {
  const kinds = [...new Set(RULES.filter((r) => r.urgency === 'now').map((r) => r.kind))];
  return kinds.map((kind) => ({ kind, label: KIND_LABELS[kind] ?? kind }));
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A tiny standalone page for sign-in problems (the app's JS is not loaded here). */
function authPage(res, status, title, message, { action = 'Try again', href = '/auth/login' } = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
  });
  res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Birddog · ${escHtml(title)}</title><link rel="icon" href="/favicon.svg"></head>
<body style="font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px">
<main style="max-width:440px;text-align:center"><img src="/favicon.svg" alt="" width="48" height="48"><h1 style="font-size:22px;margin:12px 0 6px">${escHtml(title)}</h1><p style="opacity:.75">${escHtml(message)}</p>
<p><a href="${escHtml(href)}" style="display:inline-block;margin-top:8px;padding:8px 16px;border-radius:9px;background:#f5b700;color:#17171a;font-weight:600;text-decoration:none">${escHtml(action)}</a></p></main></body></html>`);
}

function safeReturnTo(v) {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && !v.startsWith('/auth/') ? v : '/';
}

/** An application/x-www-form-urlencoded body (only Sign in with Apple's form_post uses this). */
async function readForm(req) {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Expected a form post');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
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
 * @param {object} [opts.secrets]   secret store (defaults to the OS keychain)
 * @param {Function} [opts.fetchImpl]  fetch used for OIDC and GitHub (tests swap it)
 * @param {Function} [opts.cliToken]   how to ask the gh CLI for a token (tests swap it)
 * @param {boolean} [opts.liveReload]  development: tell open pages to reload when public/ changes
 * @param {Function} [opts.notifySystem] shows a system notification (tests swap it)
 * @param {string} [opts.notifyChannel] force a channel ("system" for `birddog notify`)
 * @param {object} [opts.builtInClients] Birddog's own OAuth client IDs (tests swap them; default src/auth/clients.mjs)
 * @param {Function} [opts.firstRunFolders] what the first-run screen offers (the demo swaps it)
 * @param {number} [opts.replyUndoMs] how long a reply waits for "Undo send" (default 5 s; tests shorten it)
 * @param {boolean} [opts.allowRemote] container mode: may listen on 0.0.0.0 without login, because
 *                                     Docker publishes the port to the host's loopback only
 */
export async function createBirddog({
  dir, sources = SOURCES, cwd, now, autoRefresh = true, log = console, secrets, fetchImpl = fetch, cliToken,
  liveReload = false, allowRemote = false, notifySystem, notifyChannel, firstRunFolders, builtInClients, replyUndoMs,
}) {
  sources.forEach(validateSource);
  const loaded = await loadConfig(dir, { cwd });
  let config = loaded.config;
  secrets ??= await createSecretStore({ dir });

  // Secrets never live in config.json. If one was typed in by hand (say sources.jira.token),
  // move it into the secret store and take it out of the file.
  {
    let moved = false;
    const next = { ...config, sources: { ...config.sources } };
    for (const src of sources) {
      const cfg = next.sources[src.id];
      if (!cfg) continue;
      for (const [field, secretName] of Object.entries(src.secretFields ?? {})) {
        if (typeof cfg[field] !== 'string' || !cfg[field].trim()) continue;
        if (secrets.readOnly) {
          log.warn?.(`birddog: sources.${src.id}.${field} is in config.json in plain text. Remove it and set ${secrets.describe?.(secretName)?.variable ?? 'the matching environment variable'} instead.`);
          continue;
        }
        await secrets.set(secretName, cfg[field].trim());
        const { [field]: _gone, ...rest } = next.sources[src.id];
        next.sources[src.id] = rest;
        moved = true;
        log.warn?.(`birddog: moved sources.${src.id}.${field} from config.json into ${secrets.kind}`);
      }
    }
    if (moved) { config = next; await saveConfig(dir, config); }
    if (config.auth?.clientSecret && !loaded.authFile) {
      log.warn?.('birddog: auth.clientSecret is in config.json. Move it to your keychain with "birddog secret set oidc-client-secret".');
    }
  }
  let refresh; // defined below; GitHub sign-in changes trigger a rescan
  const github = createGithubAuth({
    ...(builtInClients ? { builtIn: builtInClients } : {}),
    dir, secrets, getConfig: () => config, fetchImpl, cliToken, now,
    onChange: async () => {
      // Signing in to GitHub switches the source back on if setup had turned it off.
      if (config.sources?.github?.enabled === false && (await github.status().catch(() => ({}))).connected) {
        config = { ...config, sources: { ...config.sources, github: { ...config.sources.github, enabled: true } } };
        await saveConfig(dir, config).catch(() => {});
      }
      refresh?.({ only: 'github' }).catch(() => {});
    },
  });
  // A brand-new config starts with local git only. GitHub stays off until you connect it
  // (the first-run screen suggests that next), so a fresh inbox shows no "not signed in" error.
  if (loaded.created && !config.sources?.github && !(await github.status().catch(() => ({}))).connected) {
    config = { ...config, sources: { ...config.sources, github: { enabled: false } } };
    await saveConfig(dir, config).catch(() => {});
  }
  // What every source gets in ctx, besides now/warn/summary.
  const oauth = createOAuth({ dir, secrets, getConfig: () => config, fetchImpl, now, ...(builtInClients ? { builtIn: builtInClients } : {}) });
  const context = { fetch: fetchImpl, github, oauth, secret: (name) => secrets.get(name) };
  const collector = new Collector({ sources, dir, getConfig: () => config, now, log, context });
  const triage = new Triage({ dir, now });
  await Promise.all([collector.load(), triage.load()]);
  const notifier = createNotifier({
    dir, now, log,
    getSettings: () => ({ ...triage.prefs.notifications, ...(notifyChannel ? { channel: notifyChannel } : {}) }),
    ...(notifySystem ? { system: notifySystem } : {}),
  });
  await notifier.load();
  const history = createHistory({ dir, now });

  // ---- Single sign-on (optional) ----
  const auth = config.auth ?? {};
  const problems = checkAuthConfig(auth);
  if (problems.length) throw new Error(`Login is enabled in config.json but not set up yet:\n  - ${problems.join('\n  - ')}`);
  let oidc = null;
  let sessions = null;
  const publicHost = auth.enabled && auth.publicUrl ? new URL(auth.publicUrl).host.toLowerCase() : null;
  if (auth.enabled) {
    let key = await secrets.get('session-key');
    if (!key) {
      key = crypto.randomBytes(48).toString('base64url');
      if (secrets.readOnly) log.warn?.('birddog: no BIRDDOG_SESSION_KEY set, so sign-ins last only until Birddog restarts.');
      else await secrets.set('session-key', key);
    }
    sessions = createSessions({ key, ttlMs: (Number(auth.sessionDays) || 7) * DAY, secure: auth.publicUrl?.startsWith('https:'), now });
    if (auth.provider === 'apple') {
      // Sign in with Apple: the client secret is a JWT we sign with your key, for each sign-in.
      const privateKey = process.env.BIRDDOG_APPLE_PRIVATE_KEY || (await secrets.get('apple-private-key'));
      if (!privateKey) throw new Error('Sign in with Apple needs your key: pipe the .p8 file into "birddog secret set apple-private-key" (or set BIRDDOG_APPLE_PRIVATE_KEY).');
      oidc = createOidc({
        issuer: auth.issuer || 'https://appleid.apple.com', clientId: auth.clientId, fetchImpl, now,
        scopes: 'openid email name', responseMode: 'form_post',
        clientSecret: () => appleClientSecret({ teamId: auth.appleTeamId, keyId: auth.appleKeyId, clientId: auth.clientId, privateKey, now: now?.() ?? Date.now() }),
      });
    } else {
      const clientSecret = process.env.BIRDDOG_OIDC_CLIENT_SECRET || auth.clientSecret || (await secrets.get('oidc-client-secret')) || undefined;
      oidc = createOidc({ issuer: auth.issuer, clientId: auth.clientId, clientSecret, scopes: auth.scopes, fetchImpl, now });
    }
  }
  const hostAllowed = (host) => LOCAL_HOST.test(host) || (!!publicHost && host.toLowerCase() === publicHost);
  const baseUrl = (req) => (auth.publicUrl ? auth.publicUrl.replace(/\/+$/, '') : `http://${req.headers.host}`);

  const findSource = (id) => {
    const s = sources.find((x) => x.id === id);
    if (!s) throw new HttpError(404, `No source called "${id}"`);
    return s;
  };

  function itemsPayload(snap = collector.snapshot()) {
    // Tag sources that run on a sign-in, so a failed renewal can offer "Sign in again".
    const sourcesOut = snap.sources.map((s) => {
      const p = Object.keys(USES).find((k) => USES[k].source === s.id && USES[k].uses(config.sources?.[s.id] ?? {}));
      return p ? { ...s, signIn: p } : s;
    });
    // Items whose source can reply say who and where a reply goes, and whether replies are on.
    const items = triage.apply(snap.items).map((i) => { const r = replies.target(i); return r ? { ...i, reply: r } : i; });
    return { ...snap, sources: sourcesOut, items, refreshing: collector.refreshing };
  }

  refresh = async (opts) => {
    const snap = await collector.refresh(opts);
    await triage.prune(snap.items);
    await triage.sync();
    const triaged = triage.apply(snap.items);
    await notifier.observe({ items: triaged, sources: snap.sources }).catch((e) => log.warn?.(`birddog: notifications: ${e.message}`));
    await history.record(triaged).catch((e) => log.warn?.(`birddog: history: ${e.message}`));
    return snap;
  };

  /** Split a setup form into plain settings and secrets (sources list their secret fields in `secretFields`). */
  function splitSecrets(src, body) {
    const fields = src.secretFields ?? {};
    const plain = {};
    const secretValues = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (!(k in fields)) { plain[k] = v; continue; }
      const value = typeof v === 'string' ? v.trim() : '';
      if (value) secretValues[fields[k]] = value; // blank means "keep the saved one"
    }
    return { plain, secretValues };
  }

  /** Settings safe to send to the browser: no secret fields, nothing that looks like a credential. */
  const SECRETISH = /token|secret|password|passwd|api[-_]?key|credential/i;
  function publicSettings(src) {
    const out = {};
    for (const [k, v] of Object.entries(config.sources?.[src.id] ?? {})) {
      if (k in (src.secretFields ?? {}) || SECRETISH.test(k)) continue;
      out[k] = v;
    }
    return out;
  }

  async function savedSecrets(src) {
    const out = {};
    for (const [field, secretName] of Object.entries(src.secretFields ?? {})) {
      out[field] = !!(await secrets.get(secretName).catch(() => null));
    }
    return out;
  }

  async function setupPayload() {
    const snap = collector.snapshot();
    return {
      configFile: loaded.file,
      secretStore: secrets.kind,
      secretWarning: secrets.warning ?? null,
      container: !!allowRemote,
      // Read-only stores (environment variables, in Docker): where each secret comes from, never its value.
      secretsFrom: secrets.readOnly && secrets.describe
        ? Object.fromEntries(['github-token', ...sources.flatMap((s) => Object.values(s.secretFields ?? {}))].map((n) => [n, secrets.describe(n)]))
        : null,
      sources: await Promise.all(sources.map(async (s) => {
        const status = snap.sources.find((x) => x.id === s.id);
        return {
          id: s.id,
          name: s.name,
          description: s.description ?? '',
          available: true,
          enabled: isEnabled(s, config),
          settings: publicSettings(s),
          secrets: await savedSecrets(s), // which secrets are saved (true/false), never their values
          setup: s.setup ?? null, // fields for the generic token card
          secretNames: s.secretFields ?? {}, // names only, e.g. { token: 'gitlab-token' }
          capabilities: [...(s.capabilities ?? [])],
          replies: canReply(s) ? { allowed: config.sources?.[s.id]?.allowReplies === true } : null,
          status: status ?? null,
        };
      })).then((list) => list.sort(byName)), // A–Z by display name, wherever they're listed
      comingSoon: COMING_SOON.filter((c) => !sources.some((s) => s.id === c.id)).sort(byName),
      connections: { github: await github.status() },
    };
  }

  function findItem(id) {
    const it = collector.snapshot().items.find((i) => i.id === id);
    if (!it) throw new HttpError(404, 'That item is gone. Try refreshing.');
    return it;
  }

  // ---- Replies (the one way Birddog writes; opt-in per source) ----
  const replies = createReplies({
    sources, getConfig: () => config, findItem, context, log, now,
    ...(replyUndoMs !== undefined ? { undoMs: replyUndoMs } : {}),
    // A reply answers the item: a DM is no longer waiting, a mention is handled.
    onSent: async (item) => {
      await triage.done(item);
      await history.record(triage.apply(collector.snapshot().items)).catch(() => {});
    },
  });
  const replyRoute = (fn) => async (...a) => {
    try { return await fn(...a); } catch (e) {
      if (e instanceof ReplyError) throw new HttpError(e.status, e.message, { code: e.code, ...(e.scope ? { scope: e.scope } : {}), ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) });
      throw e;
    }
  };

  const asBadRequest = (fn) => async (...args) => {
    try { return await fn(...args); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e.message); }
  };

  // ---- Ask Fetch (chat) ----
  const chat = createChat({
    app: { collector, triage, refresh: (o) => refresh(o), get config() { return config; }, replies },
    secrets, fetchImpl, version: VERSION, now,
    getPrefs: () => triage.prefs,
    setPrefs: (p) => triage.setPrefs(p),
    getConfig: () => config,
  });

  /** Stream chat events to the browser as one JSON object per line. */
  async function chatStream(req, res, fn) {
    const body = await readBody(req);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    let started = false;
    const emit = (ev) => {
      if (!started) {
        started = true;
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      }
      if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
    };
    try {
      await fn(body, emit, abort.signal);
    } catch (err) {
      if (!started) throw err instanceof ChatError ? new HttpError(err.status, err.message) : err;
      if (err.name !== 'AbortError') emit({ type: 'error', message: err instanceof ChatError ? err.message : 'Something went wrong. Check the terminal for details.' });
      if (!(err instanceof ChatError) && err.name !== 'AbortError') log.error?.('birddog: chat:', err.message);
    }
    res.end();
  }
  const chatRoute = (fn) => async (...a) => {
    try { return await fn(...a); } catch (e) { throw e instanceof ChatError ? new HttpError(e.status, e.message) : e; }
  };

  // ---- "Sign in with …" for sources (OAuth 2.0 + PKCE, loopback redirect) ----
  const redirectFor = (req, p) => `${baseUrl(req)}/auth/oauth/${p}/callback`;
  const gitlabBase = () => String(config.oauth?.gitlab?.url || config.sources?.gitlab?.url || 'https://gitlab.com').replace(/\/+$/, '');
  const IDENTIFY = {
    google: (p, token) => googleAccount({ fetchImpl, token }),
    microsoft: (p, token) => graphAccount({ fetchImpl, token }),
    atlassian: (p, token) => atlassianSite({ fetchImpl, token }),
    gitlab: async (p, token) => {
      const r = await fetchImpl(`${gitlabBase()}/api/v4/user`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      const u = await r.json().catch(() => ({}));
      return { account: u.username ? `@${u.username}` : null };
    },
    linear: async (p, token) => {
      const r = await fetchImpl('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { viewer { name email } }' }) });
      const v = (await r.json().catch(() => ({})))?.data?.viewer ?? {};
      return { account: v.email ?? v.name ?? null };
    },
    pagerduty: async (p, token) => {
      const base = config.sources?.pagerduty?.url || 'https://api.pagerduty.com';
      const r = await fetchImpl(`${base.replace(/\/+$/, '')}/users/me`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.pagerduty+json;version=2' } });
      const u = (await r.json().catch(() => ({})))?.user ?? {};
      return { account: u.email ?? u.name ?? null };
    },
  };
  /** Which source each sign-in feeds, how to switch it to that sign-in, and back. */
  const USES = {
    atlassian: { source: 'jira', on: (info) => ({ auth: 'oauth', ...(info.site ? { site: info.site } : {}) }), uses: (c) => c.auth === 'oauth', off: { auth: 'token' } },
    google: { source: 'cal', on: () => ({ provider: 'google' }), uses: (c) => c.provider === 'google', off: { provider: 'ics' } },
    microsoft: { source: 'cal', on: () => ({ provider: 'microsoft' }), uses: (c) => c.provider === 'microsoft', off: { provider: 'ics' } },
    gitlab: { source: 'gitlab', on: () => ({ auth: 'oauth', url: gitlabBase() }), uses: (c) => c.auth === 'oauth', off: { auth: 'token' } },
    linear: { source: 'linear', on: () => ({ auth: 'oauth' }), uses: (c) => c.auth === 'oauth', off: { auth: 'token' } },
    pagerduty: { source: 'pagerduty', on: () => ({ auth: 'oauth' }), uses: (c) => c.auth === 'oauth', off: { auth: 'token' } },
  };
  /** After a sign-in, point the matching source at it and switch it on. */
  function useProvider(p, info) {
    const u = USES[p];
    config = { ...config, sources: { ...config.sources, [u.source]: { ...(config.sources?.[u.source] ?? {}), enabled: true, ...u.on(info) } } };
    return saveConfig(dir, config);
  }
  async function oauthCallback(req, res, p, params) {
    if (!OAUTH_PROVIDERS[p]) throw new HttpError(404, 'Not found');
    try {
      const info = await oauth.callback(p, params, IDENTIFY[p]);
      await useProvider(p, info);
      refresh?.({ only: USES[p].source }).catch(() => {});
      return redirect(res, `/?connected=${encodeURIComponent(p)}`);
    } catch (err) {
      if (err instanceof OAuthError) return authPage(res, err.status, 'Sign-in did not work', err.message, { action: 'Back to Birddog', href: '/?setup=1' });
      throw err;
    }
  }

  // ---- Live reload (development only) ----
  // Open pages listen on /api/dev/events. A change in public/ sends "reload";
  // a server restart (node --watch) drops the stream, and the page reloads when it reconnects.
  const listeners = new Set();
  let watcher = null;
  if (liveReload) {
    let pending = null;
    watcher = watch(PUBLIC, { recursive: true }, () => {
      clearTimeout(pending);
      pending = setTimeout(() => { for (const res of listeners) res.write('event: reload\ndata: {}\n\n'); }, 80);
    });
    watcher.unref?.();
  }
  function devEvents(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    res.write('retry: 500\n\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
  }

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ app: 'birddog', version: VERSION, ...(liveReload ? { liveReload: true } : {}) })],
    ['GET', /^\/api\/me$/, (_m, _b, ctx) => ({ authEnabled: !!oidc, user: ctx.user })],
    ['GET', /^\/api\/items$/, async () => { await triage.sync(); return itemsPayload(); }],
    ['POST', /^\/api\/refresh$/, async () => itemsPayload(await refresh())],
    ['POST', /^\/api\/sources\/([^/]+)\/retry$/, async (m) => {
      const src = findSource(m[1]);
      if (!isEnabled(src, config)) throw new HttpError(400, `${src.name} is switched off`);
      return itemsPayload(await refresh({ only: src.id }));
    }],
    ['PUT', /^\/api\/sources\/([^/]+)\/enabled$/, async (m, body) => {
      // Switch a source on or off without touching its settings or secrets.
      const src = findSource(m[1]);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'Send { "enabled": true | false }');
      config = { ...config, sources: { ...config.sources, [src.id]: { ...(config.sources?.[src.id] ?? {}), enabled: body.enabled } } };
      await saveConfig(dir, config);
      if (body.enabled) await refresh({ only: src.id });
      return setupPayload();
    }],
    ['POST', /^\/api\/items\/([^/]+)\/done$/, async (m) => {
      await triage.done(findItem(m[1]));
      await history.record(triage.apply(collector.snapshot().items)).catch(() => {});
      return { ok: true };
    }],
    ['POST', /^\/api\/items\/([^/]+)\/snooze$/, async (m, body) => {
      const until = body.until;
      if (until !== 'change' && !(typeof until === 'string' && Date.parse(until) > Date.now())) {
        throw new HttpError(400, 'until must be a future ISO date or "change"');
      }
      await triage.snooze(findItem(m[1]), until); return { ok: true };
    }],
    ['GET', /^\/api\/items\/([^/]+)\/reply$/, replyRoute((m) => replies.details(findItem(m[1])))],
    ['POST', /^\/api\/items\/([^/]+)\/reply$/, replyRoute((m, body) => replies.queue(m[1], body.text, { broadcast: body.broadcast === true }))],
    ['GET', /^\/api\/replies\/([^/]+)$/, replyRoute((m) => replies.get(m[1]))],
    ['POST', /^\/api\/replies\/([^/]+)\/undo$/, replyRoute((m) => replies.undo(m[1]))],
    ['PUT', /^\/api\/sources\/([^/]+)\/replies$/, async (m, body) => {
      // "Allow replies": the only switch that lets Birddog post anything, as you.
      const src = findSource(m[1]);
      if (!canReply(src)) throw new HttpError(400, `${src.name} can't send replies.`);
      if (typeof body.allow !== 'boolean') throw new HttpError(400, 'Send { "allow": true | false }');
      config = { ...config, sources: { ...config.sources, [src.id]: { ...(config.sources?.[src.id] ?? {}), allowReplies: body.allow } } };
      await saveConfig(dir, config);
      log.log?.(`birddog: replies ${body.allow ? 'on' : 'off'} for ${src.name}`);
      return setupPayload();
    }],
    ['POST', /^\/api\/items\/([^/]+)\/restore$/, async (m) => { await triage.restore(m[1]); return { ok: true }; }],
    ['GET', /^\/api\/prefs$/, async () => { await triage.sync(); return triage.prefs; }],
    ['PUT', /^\/api\/prefs$/, async (_m, body) => {
      const rejected = await triage.setPrefs(body);
      if (rejected.length) throw new HttpError(400, `Invalid preference: ${rejected.join(', ')}`);
      return triage.prefs;
    }],
    ['GET', /^\/api\/setup$/, () => setupPayload()],
    ['GET', /^\/api\/firstrun$/, async () => {
      const git = config.sources?.git ?? {};
      const gh = await github.status().catch(() => ({}));
      const folders = firstRunFolders ?? repoFolders;
      return { ...(await folders({ roots: git.roots ?? [], container: !!allowRemote, maxDepth: git.maxDepth ?? 3, cwd })), github: { connected: !!gh.connected, login: gh.login ?? null } };
    }],
    ['GET', /^\/api\/chat\/status$/, () => chat.status()],
    ['GET', /^\/api\/oauth$/, async (_m, _b, ctx) => ({
      providers: await Promise.all(oauth.providers.map(async (p) => ({ ...(await oauth.status(p)), redirectUri: `${ctx.base}/auth/oauth/${p}/callback` }))),
    })],
    ['POST', /^\/api\/oauth\/([a-z]+)\/start$/, async (m, _b, ctx) => {
      try { return await oauth.start(m[1], `${ctx.base}/auth/oauth/${m[1]}/callback`); } catch (e) { throw e instanceof OAuthError ? new HttpError(e.status, e.message) : e; }
    }],
    ['DELETE', /^\/api\/oauth\/([a-z]+)$/, async (m) => {
      const p = m[1];
      if (!OAUTH_PROVIDERS[p]) throw new HttpError(404, 'Not found');
      const r = await oauth.disconnect(p);
      // A source that was using this sign-in is switched off (its other settings stay).
      const { source: src, uses, off } = USES[p];
      const cfg = config.sources?.[src] ?? {};
      if (uses(cfg)) {
        config = { ...config, sources: { ...config.sources, [src]: { ...cfg, enabled: false, ...off } } };
        await saveConfig(dir, config);
        await refresh({ only: src }).catch(() => {});
      }
      return { ...r, status: await oauth.status(p) };
    }],
    ['GET', /^\/api\/history$/, async (_m, _b, ctx) => {
      const n = Math.min(60, Math.max(1, Number(ctx.query.get('days')) || 14));
      return { days: await history.last(n) };
    }],
    ['POST', /^\/api\/chat\/setup$/, chatRoute((_m, body) => chat.setup(body))],
    ['DELETE', /^\/api\/chat\/setup$/, chatRoute(() => chat.turnOff())],
    ['POST', /^\/api\/chat\/reset$/, (_m, body) => { chat.reset(body.sessionId); return { ok: true }; }],
    ['POST', /^\/api\/notifications\/claim$/, (_m, body) => ({ events: notifier.claim({ canShow: body.canShow !== false }) })],
    ['POST', /^\/api\/notifications\/test$/, asBadRequest(async (_m, body) => notifier.test(body.channel === 'system' ? 'system' : undefined))],
    ['GET', /^\/api\/notifications\/kinds$/, () => ({ kinds: notifyKinds() })],
    ['POST', /^\/api\/sources\/([^/]+)\/test$/, async (m, body) => {
      const src = findSource(m[1]);
      let { plain, secretValues } = splitSecrets(src, body);
      let patch = {};
      try {
        patch = Object.keys(plain).length && src.normalizeSettings ? src.normalizeSettings(plain) : {};
        if (src.validateSecrets) secretValues = src.validateSecrets(secretValues);
      } catch (e) { return { ok: false, message: e.message }; }
      // Try the draft secrets without saving them.
      const ctx = { ...context, now: Date.now(), secret: async (n) => secretValues[n] ?? secrets.get(n) };
      return src.test({ ...(config.sources?.[src.id] ?? {}), ...patch }, ctx);
    }],
    ['PUT', /^\/api\/sources\/([^/]+)$/, async (m, body) => {
      const src = findSource(m[1]);
      if (!src.normalizeSettings) throw new HttpError(400, `${src.name} has no settings to change yet`);
      let { plain, secretValues } = splitSecrets(src, body);
      let patch;
      try {
        patch = src.normalizeSettings(plain);
        if (src.validateSecrets) secretValues = src.validateSecrets(secretValues);
      } catch (e) { throw new HttpError(400, e.message); }
      for (const [n, v] of Object.entries(secretValues)) {
        try { await secrets.set(n, v); } catch (e) { throw new HttpError(400, `Could not save the secret to ${secrets.kind}: ${e.message}`); }
      }
      config = { ...config, sources: { ...config.sources, [src.id]: { ...(config.sources?.[src.id] ?? {}), ...patch, enabled: true } } };
      await saveConfig(dir, config);
      await refresh();
      return setupPayload();
    }],
    ['DELETE', /^\/api\/sources\/([^/]+)$/, async (m) => {
      // Disconnect: forget the source's secrets and switch it off. Its other settings stay for next time.
      const src = findSource(m[1]);
      for (const n of Object.values(src.secretFields ?? {})) await secrets.delete(n).catch(() => {});
      config = { ...config, sources: { ...config.sources, [src.id]: { ...(config.sources?.[src.id] ?? {}), enabled: false } } };
      await saveConfig(dir, config);
      await refresh();
      return setupPayload();
    }],
    ['GET', /^\/api\/connections\/github$/, () => github.status()],
    ['POST', /^\/api\/connections\/github\/device$/, asBadRequest(() => github.startDevice())],
    ['POST', /^\/api\/connections\/github\/gh-cli$/, asBadRequest(() => github.useGhCli())],
    ['DELETE', /^\/api\/connections\/github$/, () => github.disconnect()],
  ];

  async function handleAuth(req, res, url) {
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      await readBody(req);
      return send(res, 200, { ok: true }, sessions ? { 'set-cookie': sessions.clear() } : {});
    }
    const oauthCb = /^\/auth\/oauth\/([a-z]+)\/callback$/.exec(url.pathname);
    if (oauthCb && req.method === 'GET') return oauthCallback(req, res, oauthCb[1], Object.fromEntries(url.searchParams));
    // Sign in with Apple posts its answer back as a form (response_mode=form_post).
    if (url.pathname === '/auth/callback' && req.method === 'POST' && oidc && auth.provider === 'apple') {
      const params = Object.fromEntries(new URLSearchParams(await readForm(req)));
      try {
        const { user, returnTo } = await oidc.callback(params);
        if (!isAllowed(auth, user)) return authPage(res, 403, 'Not on the list', `You signed in as ${user.email ?? 'an account with no email'}, but that account is not allowed to use this Birddog.`);
        return redirect(res, safeReturnTo(returnTo), { 'set-cookie': sessions.issue(user) });
      } catch (err) {
        if (err instanceof AuthError) return authPage(res, err.status, 'Sign-in did not work', err.message);
        throw err;
      }
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (url.pathname === '/auth/signed-out') {
      return authPage(res, 200, 'Signed out', 'You are signed out of Birddog on this browser.', { action: 'Sign in again' });
    }
    if (!oidc) return redirect(res, '/');
    try {
      if (url.pathname === '/auth/login') {
        const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
        return redirect(res, await oidc.loginUrl({ redirectUri: `${baseUrl(req)}/auth/callback`, returnTo }));
      }
      if (url.pathname === '/auth/callback') {
        const { user, returnTo } = await oidc.callback(Object.fromEntries(url.searchParams));
        if (!isAllowed(auth, user)) {
          log.warn?.(`birddog: refused sign-in for ${user.email ?? user.sub} (not in allowedEmails/allowedDomains)`);
          return authPage(res, 403, 'Not on the list', `You signed in as ${user.email ?? 'an account with no email'}, but that account is not allowed to use this Birddog. Ask its owner to add you to auth.allowedEmails.`);
        }
        return redirect(res, safeReturnTo(returnTo), { 'set-cookie': sessions.issue(user) });
      }
    } catch (err) {
      if (err instanceof AuthError) return authPage(res, err.status, 'Sign-in did not work', err.message);
      throw err;
    }
    throw new HttpError(404, 'Not found');
  }

  async function handle(req, res) {
    const host = req.headers.host ?? '';
    if (!hostAllowed(host)) throw new HttpError(403, 'Birddog only answers on localhost (or auth.publicUrl)');
    const origin = req.headers.origin;
    // The one cross-site request Birddog accepts: Apple posting a sign-in result back
    // (checked further by state, PKCE and the signed ID token).
    const appleCallback = auth.provider === 'apple' && req.method === 'POST' && origin === 'https://appleid.apple.com' && req.url.split('?')[0] === '/auth/callback';
    if (origin && origin !== 'null' && !appleCallback) {
      let ok = false;
      try { const o = new URL(origin).host; ok = o.toLowerCase() === host.toLowerCase() && hostAllowed(o); } catch { /* bad origin */ }
      if (!ok) throw new HttpError(403, 'Cross-origin requests are not allowed');
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/auth/')) return handleAuth(req, res, url);

    let user = null;
    if (oidc) {
      user = sessions.read(req.headers.cookie);
      if (user && !isAllowed(auth, user)) user = null; // removed from the allow list since signing in
      if (!user && !PUBLIC_PATHS.has(url.pathname)) {
        if (!url.pathname.startsWith('/api/') && (req.method === 'GET' || req.method === 'HEAD')) {
          return redirect(res, `/auth/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
        }
        throw new HttpError(401, 'Sign in required');
      }
    }

    if (liveReload && url.pathname === '/api/dev/events' && req.method === 'GET') return devEvents(req, res);
    if (req.method === 'POST' && url.pathname === '/api/chat') return chatStream(req, res, (b, emit, signal) => chat.send(b, emit, signal));
    if (req.method === 'POST' && url.pathname === '/api/chat/confirm') return chatStream(req, res, (b, emit, signal) => chat.confirm(b, emit, signal));
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }
    for (const [method, re, fn] of routes) {
      const m = re.exec(url.pathname);
      if (!m || req.method !== method) continue;
      const params = m.map((x, i) => (i ? decodeURIComponent(x) : x));
      const body = method === 'GET' ? {} : await readBody(req);
      return send(res, 200, await fn(params, body, { user, query: url.searchParams, base: baseUrl(req) }));
    }
    throw new HttpError(404, 'Unknown API route');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status ?? 500;
      if (status === 500) log.error?.('birddog:', err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong. Check the terminal for details.' : err.message, ...(status !== 500 && err.extra ? err.extra : {}) });
      else res.end();
    });
  });

  let timer = null;
  let flushTimer = null;

  return {
    server,
    collector,
    triage,
    notifier,
    github,
    secrets,
    get config() { return config; },
    replies,
    configFile: loaded.file,
    authFile: loaded.authFile,
    firstRun: loaded.created,
    authEnabled: !!oidc,
    refresh,
    /** Listen (127.0.0.1 by default). Resolves with the bound port. */
    start(port = 0, host = '127.0.0.1') {
      if (!LOOPBACK.has(host) && !oidc && !allowRemote) {
        return Promise.reject(new Error(`Refusing to listen on ${host} without login. Turn on "auth" in config.json first (see README), or drop --host.`));
      }
      return new Promise((resolve, reject) => {
        const onError = (err) => { server.off('listening', onListen); reject(err); };
        const onListen = () => {
          server.off('error', onError);
          if (autoRefresh) {
            refresh().catch(() => {});
            const every = Math.max(1, Number(config.refreshMinutes) || 5) * 60_000;
            timer = setInterval(() => refresh({ scheduled: true }).catch(() => {}), every);
            timer.unref();
          }
          flushTimer = setInterval(() => notifier.flush().catch(() => {}), 5_000);
          flushTimer.unref();
          resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(port, host);
      });
    },
    async close() {
      clearInterval(timer);
      clearInterval(flushTimer);
      replies.close();
      watcher?.close();
      for (const res of listeners) res.end();
      const closed = new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await closed;
      await collector.inflight?.catch(() => {});
    },
  };
}
