// "Sign in with GitHub" for the dashboard (auth.provider: "github").
//
// GitHub isn't an OpenID Connect provider, so this is GitHub's OAuth web flow with PKCE,
// shaped like createOidc() (loginUrl / callback) so the server treats both the same.
//
//   scopes   read:user user:email, plus read:org when auth.allowedOrgs is set
//   user     { sub: "github:<id>", login, email (primary and verified, or null), name, orgs }
//
// Who may sign in: auth.allowedLogins (GitHub usernames), auth.allowedOrgs (active
// members of these organizations), and the usual allowedEmails / allowedDomains.
// Organization membership is checked at sign-in; the session lasts auth.sessionDays.
// GitHub Enterprise Server works with auth.githubUrl (https://github.example.com).
// The OAuth token is used only during sign-in and then dropped.

import crypto from 'node:crypto';
import { AuthError } from './oidc.mjs';

const PENDING_TTL_MS = 10 * 60_000;
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');

/** GitHub's API address for a web address (github.com or GitHub Enterprise Server). */
export const githubApi = (webUrl) => (new URL(webUrl).host === 'github.com' ? 'https://api.github.com' : `${String(webUrl).replace(/\/+$/, '')}/api/v3`);

export function createGithubLogin({ clientId, clientSecret, webUrl = 'https://github.com', allowedOrgs = [], fetchImpl = fetch, now = () => Date.now() }) {
  const web = String(webUrl).replace(/\/+$/, '');
  const api = githubApi(web);
  const pending = new Map();
  const orgs = allowedOrgs.map((o) => String(o).trim()).filter(Boolean);
  const scopes = ['read:user', 'user:email', ...(orgs.length ? ['read:org'] : [])].join(' ');

  async function call(url, init = {}, what = 'GitHub') {
    let res;
    try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) }); } catch (e) {
      throw new AuthError(`Could not reach ${new URL(url).host}: ${e.message}`, 502);
    }
    const body = await res.json().catch(() => ({}));
    return { res, body, what };
  }

  return {
    async loginUrl({ redirectUri, returnTo = '/' }) {
      for (const [k, v] of pending) if (v.exp < now()) pending.delete(k);
      if (pending.size > 1000) throw new AuthError('Too many sign-ins in progress. Wait a minute.', 429);
      const state = rand();
      const verifier = rand(48);
      pending.set(state, { verifier, returnTo, redirectUri, exp: now() + PENDING_TTL_MS });
      const url = new URL(`${web}/login/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, scope: scopes, state, allow_signup: 'false',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },

    async callback(params) {
      if (params.error) throw new AuthError(`Sign-in was cancelled or refused: ${params.error_description || params.error}`, 401);
      const p = pending.get(params.state);
      pending.delete(params.state);
      if (!p || p.exp < now()) throw new AuthError('This sign-in link expired or was already used. Start again.', 400);
      if (!params.code) throw new AuthError('GitHub did not return a code', 400);
      const secret = typeof clientSecret === 'function' ? await clientSecret() : clientSecret;
      if (!secret) throw new AuthError('Sign in with GitHub needs the OAuth app\'s client secret: "birddog secret set oidc-client-secret" (or BIRDDOG_OIDC_CLIENT_SECRET).', 500);
      const t = await call(`${web}/login/oauth/access_token`, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: secret, code: params.code, redirect_uri: p.redirectUri, code_verifier: p.verifier }),
      });
      if (!t.body.access_token) throw new AuthError(`GitHub said: ${t.body.error_description || t.body.error || `HTTP ${t.res.status}`}`, 502);
      const auth = { authorization: `Bearer ${t.body.access_token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'birddog' };
      const me = await call(`${api}/user`, { headers: auth });
      if (!me.res.ok || !me.body.id) throw new AuthError(`GitHub would not say who you are (HTTP ${me.res.status})`, 502);
      const emails = await call(`${api}/user/emails`, { headers: auth });
      const primary = Array.isArray(emails.body) ? emails.body.find((e) => e.primary && e.verified) : null;
      const memberOf = [];
      for (const org of orgs) {
        const m = await call(`${api}/user/memberships/orgs/${encodeURIComponent(org)}`, { headers: auth });
        if (m.res.ok && m.body.state === 'active') memberOf.push(org.toLowerCase());
      }
      return {
        user: { sub: `github:${me.body.id}`, login: me.body.login, email: primary?.email ?? null, name: me.body.name ?? me.body.login, orgs: memberOf },
        returnTo: p.returnTo,
      };
    },
  };
}
