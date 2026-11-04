// "Sign in with …" for sources: OAuth 2.0 authorization code flow with PKCE and a
// loopback redirect to this Birddog (http://127.0.0.1:<port>/auth/oauth/<provider>/callback).
//
//   google     Google Calendar (read-only)          desktop-app client, PKCE
//   microsoft  Microsoft 365 / Outlook calendar     public client, PKCE, no secret
//   gitlab     GitLab (read_api)                    non-confidential app, PKCE, no secret
//   linear     Linear (read)                        PKCE, no secret
//   pagerduty  PagerDuty (read)                     Classic User OAuth, PKCE, no secret
//   atlassian  Jira Cloud (OAuth 2.0 "3LO")         needs your own app and its secret
//
// Client IDs: BIRDDOG_<PROVIDER>_CLIENT_ID, then config.json (oauth.<provider>.clientId),
// then Birddog's own built-in public client (src/auth/clients.mjs). Client secrets, for
// your own apps: BIRDDOG_<PROVIDER>_CLIENT_SECRET or the keychain (<provider>-client-secret).
// The built-in clients have no secret, except Google's non-confidential desktop one.
//
// Tokens (access + refresh) are kept in the keychain as "oauth-<provider>",
// refreshed when they are about to expire, and removed (and revoked where the
// provider supports it) on Disconnect.

import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from '../store.mjs';
import { BUILT_IN, builtInSecret, googleVerified, NO_BUILT_IN, resolveClientId } from './clients.mjs';

const PENDING_TTL_MS = 10 * 60_000;
const EARLY_REFRESH_MS = 60_000;

export const PROVIDERS = {
  google: {
    name: 'Google Calendar',
    authorize: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    token: () => 'https://oauth2.googleapis.com/token',
    revoke: 'https://oauth2.googleapis.com/revoke',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    extra: { access_type: 'offline', prompt: 'consent' },
    secret: 'optional', // desktop-app clients may have one; it isn't confidential
    tokenBody: 'form',
    register: 'https://console.cloud.google.com/apis/credentials',
  },
  microsoft: {
    name: 'Microsoft 365 / Outlook',
    authorize: (c) => `https://login.microsoftonline.com/${encodeURIComponent(c.tenant || 'common')}/oauth2/v2.0/authorize`,
    token: (c) => `https://login.microsoftonline.com/${encodeURIComponent(c.tenant || 'common')}/oauth2/v2.0/token`,
    revoke: null, // no per-token revoke; manage at account.microsoft.com / myapps.microsoft.com
    scopes: ['offline_access', 'User.Read', 'Calendars.Read'],
    extra: {},
    secret: 'none', // public client
    tokenBody: 'form',
    register: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },
  gitlab: {
    name: 'GitLab',
    authorize: (c) => `${(c.url || 'https://gitlab.com').replace(/\/+$/, '')}/oauth/authorize`,
    token: (c) => `${(c.url || 'https://gitlab.com').replace(/\/+$/, '')}/oauth/token`,
    revokeFor: (c) => `${(c.url || 'https://gitlab.com').replace(/\/+$/, '')}/oauth/revoke`,
    revoke: true,
    scopes: ['read_api'],
    extra: {},
    secret: 'optional', // a non-confidential application needs none
    tokenBody: 'form',
    register: 'https://gitlab.com/-/user_settings/applications',
  },
  linear: {
    name: 'Linear',
    authorize: () => 'https://linear.app/oauth/authorize',
    token: () => 'https://api.linear.app/oauth/token',
    revoke: 'https://api.linear.app/oauth/revoke',
    revokeAuth: 'bearer', // Linear revokes the token sent as a Bearer credential
    scopes: ['read'],
    scopeSep: ',', // Linear takes a comma-separated scope list
    extra: { prompt: 'consent' },
    secret: 'optional', // optional with PKCE, per Linear's docs
    tokenBody: 'form',
    register: 'https://linear.app/settings/api/applications/new',
  },
  pagerduty: {
    name: 'PagerDuty',
    authorize: () => 'https://identity.pagerduty.com/oauth/authorize',
    token: () => 'https://identity.pagerduty.com/oauth/token',
    revoke: null, // no revoke endpoint; "Revoke All Tokens" in the app registration, or remove the app in PagerDuty
    scopes: ['read'],
    extra: {},
    secret: 'optional', // Classic User OAuth: a non-confidential client omits it (PKCE required)
    tokenBody: 'form',
    register: 'https://support.pagerduty.com/main/docs/app-registration',
  },
  atlassian: {
    name: 'Atlassian (Jira Cloud)',
    authorize: () => 'https://auth.atlassian.com/authorize',
    token: () => 'https://auth.atlassian.com/oauth/token',
    revoke: null, // no documented revoke endpoint; remove the app at id.atlassian.com/manage-profile/apps
    scopes: ['read:jira-work', 'read:jira-user', 'offline_access'],
    extra: { audience: 'api.atlassian.com', prompt: 'consent' },
    secret: 'required',
    tokenBody: 'json',
    register: 'https://developer.atlassian.com/console/myapps/',
  },
};

export class OAuthError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const envName = (p, what) => `BIRDDOG_${p.toUpperCase()}_${what}`;

/**
 * @param {object} o
 * @param {string} o.dir           config dir (connections.json holds who you are, never tokens)
 * @param {object} o.secrets       secret store
 * @param {() => object} o.getConfig
 */
export function createOAuth({ dir, secrets, getConfig, fetchImpl = fetch, now = () => Date.now(), env = process.env, builtIn = BUILT_IN }) {
  const file = path.join(dir, 'connections.json');
  const pending = new Map(); // state → { provider, verifier, redirectUri, exp }
  const refreshing = new Map(); // provider → promise

  const def = (p) => {
    const d = PROVIDERS[p];
    if (!d) throw new OAuthError(`No sign-in flow for "${p}"`, 404);
    return d;
  };
  const settings = (p) => ({ ...(getConfig().oauth?.[p] ?? {}) });
  const hostFor = (p) => (p === 'gitlab' ? settings(p).url || 'https://gitlab.com' : null);
  const client = (p) => resolveClientId(p, { env, configured: settings(p).clientId || null, host: hostFor(p), builtIn: NO_BUILT_IN[p] ? {} : builtIn });
  const clientId = (p) => client(p).clientId;
  // A secret belongs to one app: the built-in client only ever uses its own (Google's
  // non-confidential desktop secret); an app you registered uses yours.
  const clientSecret = async (p) => {
    const { from } = client(p);
    if (from === 'built-in') return builtInSecret(p, from, builtIn);
    return env[envName(p, 'CLIENT_SECRET')] || (await secrets.get(`${p}-client-secret`).catch(() => null)) || null;
  };
  const tokenKey = (p) => `oauth-${p}`;

  async function readTokens(p) {
    const raw = await secrets.get(tokenKey(p)).catch(() => null);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  async function saveTokens(p, t) {
    await secrets.set(tokenKey(p), JSON.stringify(t));
  }
  async function connection(p) { return (await readJson(file, {})).oauth?.[p] ?? null; }
  async function saveConnection(p, info) {
    const all = await readJson(file, {});
    all.oauth ??= {};
    if (info) all.oauth[p] = info; else delete all.oauth[p];
    await writeJson(file, all);
  }

  async function tokenRequest(p, params) {
    const d = def(p);
    const c = settings(p);
    const body = { client_id: clientId(p), ...params };
    const secret = d.secret === 'none' ? null : await clientSecret(p);
    if (d.secret === 'required' && !secret) throw new OAuthError(`${d.name} needs its client secret too: run "birddog secret set ${p}-client-secret" (or set ${envName(p, 'CLIENT_SECRET')}).`);
    if (secret) body.client_secret = secret;
    let res;
    try {
      res = await fetchImpl(d.token(c), {
        method: 'POST',
        headers: d.tokenBody === 'json' ? { 'content-type': 'application/json', accept: 'application/json' } : { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: d.tokenBody === 'json' ? JSON.stringify(body) : new URLSearchParams(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new OAuthError(`Could not reach ${new URL(d.token(c)).host}`, 502); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const why = data.error_description || data.error || `HTTP ${res.status}`;
      throw new OAuthError(`${d.name} refused the sign-in: ${why}`, res.status === 400 || res.status === 401 ? 401 : 502);
    }
    return data;
  }

  const stamp = (data, prev = {}) => ({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? prev.refresh_token ?? null, // some providers rotate it, some keep it
    expires_at: now() + (Number(data.expires_in) || 3600) * 1000,
    scope: data.scope ?? prev.scope ?? null,
  });

  async function refresh(p, t) {
    if (!t.refresh_token) throw new OAuthError(`${def(p).name}: the sign-in expired. Sign in again in setup.`, 401);
    const data = await tokenRequest(p, { grant_type: 'refresh_token', refresh_token: t.refresh_token }).catch((e) => {
      throw new OAuthError(`${def(p).name}: could not renew the sign-in (${e.message}). Sign in again in setup.`, 401);
    });
    const next = stamp(data, t);
    await saveTokens(p, next);
    return next;
  }

  return {
    providers: Object.keys(PROVIDERS),

    /** What setup shows: is it set up, who is signed in. Never tokens. */
    async status(p) {
      const d = def(p);
      const conn = await connection(p);
      const t = await readTokens(p);
      const c = client(p);
      return {
        id: p,
        name: d.name,
        configured: !!c.clientId,
        builtIn: c.from === 'built-in',
        clientIdFrom: c.from === 'env' ? c.variable : c.from === 'config' ? `config.json (oauth.${p}.clientId)` : c.from === 'built-in' ? "Birddog's own app" : null,
        noBuiltIn: NO_BUILT_IN[p] ?? null, // why there's no one-click app for this provider
        unverified: p === 'google' && c.from === 'built-in' && !googleVerified(builtIn), // Google's "unverified app" screen
        needsSecret: d.secret === 'required',
        hasSecret: d.secret === 'none' ? null : !!(await clientSecret(p)),
        connected: !!(conn && t),
        account: conn?.account ?? null,
        connectedAt: conn?.connectedAt ?? null,
        site: conn?.site ?? null,
        register: d.register,
        canStore: !secrets.readOnly,
      };
    },

    /** Start a sign-in. Returns the provider URL to send the browser to. */
    async start(p, redirectUri) {
      const d = def(p);
      if (secrets.readOnly) throw new OAuthError(`Sign-in needs somewhere safe to keep the tokens, and ${secrets.kind} is read-only here (Docker). Use an API token or an iCal link instead.`);
      const id = clientId(p);
      if (!id) throw new OAuthError(`One-click ${d.name} sign-in isn't available in this copy of Birddog. Use a token instead, or bring your own app: set oauth.${p}.clientId in config.json or ${envName(p, 'CLIENT_ID')} (see the guide).`);
      if (d.secret === 'required' && !(await clientSecret(p))) throw new OAuthError(`${d.name} also needs its client secret: run "birddog secret set ${p}-client-secret".`);
      for (const [k, v] of pending) if (v.exp < now()) pending.delete(k);
      if (pending.size > 50) throw new OAuthError('Too many sign-ins in progress. Wait a minute.', 429);
      const state = rand();
      const verifier = rand(48);
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      pending.set(state, { provider: p, verifier, redirectUri, exp: now() + PENDING_TTL_MS });
      const url = new URL(d.authorize(settings(p)));
      url.search = new URLSearchParams({
        response_type: 'code', client_id: id, redirect_uri: redirectUri, scope: [...d.scopes, ...(settings(p).extraScopes ?? [])].join(d.scopeSep ?? ' '),
        state, code_challenge: challenge, code_challenge_method: 'S256', ...d.extra,
      }).toString();
      return { url: url.toString() };
    },

    /** The provider sent the browser back. Exchanges the code; `identify` finds out who signed in. */
    async callback(p, params, identify) {
      def(p);
      if (params.error) throw new OAuthError(`Sign-in was cancelled or refused: ${params.error_description || params.error}`, 401);
      const pend = pending.get(params.state);
      pending.delete(params.state);
      if (!pend || pend.provider !== p || pend.exp < now()) throw new OAuthError('This sign-in link expired or was already used. Start again from setup.');
      if (!params.code) throw new OAuthError('The provider did not send a code back.');
      const data = await tokenRequest(p, { grant_type: 'authorization_code', code: params.code, redirect_uri: pend.redirectUri, code_verifier: pend.verifier });
      const t = stamp(data);
      await saveTokens(p, t);
      const who = (await identify?.(p, t.access_token).catch(() => null)) ?? {};
      const info = { account: who.account ?? null, site: who.site ?? null, cloudId: who.cloudId ?? null, connectedAt: new Date(now()).toISOString() };
      await saveConnection(p, info);
      return info;
    },

    /** A valid access token, renewed first if it is about to expire. */
    async accessToken(p) {
      const t = await readTokens(p);
      if (!t) throw new OAuthError(`Sign in to ${def(p).name} in setup.`, 401);
      if (t.expires_at - EARLY_REFRESH_MS > now()) return t.access_token;
      if (!refreshing.has(p)) refreshing.set(p, refresh(p, t).finally(() => refreshing.delete(p)));
      return (await refreshing.get(p)).access_token;
    },

    connection,

    /** Forget the tokens; revoke them at the provider where that is possible. */
    async disconnect(p) {
      const d = def(p);
      const t = await readTokens(p);
      let revoked = false;
      if (t && d.revoke) {
        try {
          const form = { token: p === 'gitlab' || p === 'linear' ? t.access_token : (t.refresh_token || t.access_token), ...(p === 'gitlab' ? { client_id: clientId(p) } : {}) };
          const headers = { 'content-type': 'application/x-www-form-urlencoded', ...(d.revokeAuth === 'bearer' ? { authorization: `Bearer ${t.access_token}` } : {}) };
          const res = await fetchImpl(d.revokeFor ? d.revokeFor(settings(p)) : d.revoke, { method: 'POST', headers, body: new URLSearchParams(form), signal: AbortSignal.timeout(10_000) });
          revoked = res.ok;
        } catch { /* offline: still forget locally */ }
      }
      await secrets.delete(tokenKey(p)).catch(() => {});
      await saveConnection(p, null);
      const manage = { microsoft: 'https://account.microsoft.com/privacy/app-access', atlassian: 'https://id.atlassian.com/manage-profile/apps', pagerduty: 'https://support.pagerduty.com/main/docs/app-registration' };
      return { revoked, manage: d.revoke ? null : manage[p] ?? null };
    },
  };
}

/**
 * Sign in with Apple's client secret: an ES256 JWT signed with your key (.p8),
 * valid for up to six months. Birddog makes a fresh short-lived one for each sign-in.
 */
export function appleClientSecret({ teamId, keyId, clientId, privateKey, now = Date.now() }) {
  if (!teamId || !keyId || !clientId || !privateKey) throw new OAuthError('Sign in with Apple needs auth.appleTeamId, auth.appleKeyId, auth.clientId and the apple-private-key secret.');
  const iat = Math.floor(now / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${b64({ iss: teamId, iat, exp: iat + 600, aud: 'https://appleid.apple.com', sub: clientId })}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}
