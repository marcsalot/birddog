// OpenID Connect sign-in (authorization code flow with PKCE), no dependencies.
// Works with any standard provider: Google, Okta, Microsoft Entra ID, Auth0,
// Keycloak, Authentik, …
//
// The ID token is checked fully: signature (against the provider's published
// keys), issuer, audience, expiry and the one-time nonce.

import crypto from 'node:crypto';

export class AuthError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const PENDING_TTL_MS = 10 * 60_000;
const SKEW_S = 120;
const ALGS = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: 32 }, PS384: { hash: 'sha384', pss: 48 }, PS512: { hash: 'sha512', pss: 64 },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
};

const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const trimSlash = (s) => String(s).replace(/\/+$/, '');

async function getJson(fetchImpl, url, init) {
  let res;
  try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) }); } catch (e) {
    throw new AuthError(`Could not reach the sign-in provider (${new URL(url).host}): ${e.message}`, 502);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = body.error_description || body.error || `HTTP ${res.status}`;
    throw new AuthError(`Sign-in provider said: ${why}`, 502);
  }
  return body;
}

/** Validate the auth section of config.json. Returns a list of problems (empty if fine). */
export function checkAuthConfig(auth = {}) {
  if (!auth.enabled) return [];
  const problems = [];
  if (!['apple', 'github'].includes(auth.provider) && (!auth.issuer || !/^https?:\/\//.test(auth.issuer))) problems.push('auth.issuer must be your provider URL, e.g. https://accounts.google.com');
  if (!auth.clientId) problems.push('auth.clientId is required');
  const github = auth.provider === 'github';
  if (!auth.allowedEmails?.length && !auth.allowedDomains?.length && !(github && (auth.allowedLogins?.length || auth.allowedOrgs?.length))) {
    problems.push(github
      ? 'auth.allowedLogins, auth.allowedOrgs, auth.allowedEmails or auth.allowedDomains must say who may sign in (otherwise any GitHub account could)'
      : 'auth.allowedEmails or auth.allowedDomains must say who may sign in (otherwise any account at your provider could)');
  }
  if (github && auth.githubUrl && !/^https:\/\/[^/]+\/?$/.test(auth.githubUrl)) problems.push('auth.githubUrl must look like https://github.example.com (GitHub Enterprise Server; leave it out for github.com)');
  if (auth.publicUrl && !/^https?:\/\/[^/]+\/?$/.test(auth.publicUrl)) problems.push('auth.publicUrl must look like https://birddog.example.com (no path)');
  if (auth.provider === 'apple') {
    if (!auth.appleTeamId) problems.push('auth.appleTeamId is required for Sign in with Apple (your 10-character Team ID)');
    if (!auth.appleKeyId) problems.push('auth.appleKeyId is required for Sign in with Apple (the Key ID of your Sign in with Apple key)');
    if (!/^https:\/\//.test(auth.publicUrl ?? '')) problems.push('Sign in with Apple needs auth.publicUrl on https (Apple does not allow localhost or http return URLs)');
  }
  return problems;
}

/** Is this signed-in identity on the allow list? */
export function isAllowed(auth, user) {
  // GitHub sign-ins can also be allowed by username or organization (checked at sign-in).
  if (auth.provider === 'github' && user?.login) {
    if ((auth.allowedLogins ?? []).some((l) => String(l).toLowerCase() === String(user.login).toLowerCase())) return true;
    if ((auth.allowedOrgs ?? []).some((o) => (user.orgs ?? []).includes(String(o).toLowerCase()))) return true;
  }
  const email = String(user?.email ?? '').toLowerCase();
  if (!email) return false;
  if ((auth.allowedEmails ?? []).some((e) => e.toLowerCase() === email)) return true;
  const domain = email.split('@')[1];
  return (auth.allowedDomains ?? []).some((d) => d.toLowerCase().replace(/^@/, '') === domain);
}

/**
 * clientSecret may be a function that returns a fresh secret per request (Sign in
 * with Apple signs a short-lived JWT). responseMode "form_post" makes the provider
 * POST the result back (Apple requires it when asking for the email).
 */
export function createOidc({ issuer, clientId, clientSecret, scopes = 'openid email profile', responseMode, fetchImpl = fetch, now = () => Date.now() }) {
  let discovery = null;
  let jwks = null;
  const pending = new Map(); // state → { verifier, nonce, returnTo, redirectUri, exp }

  async function discover() {
    if (discovery) return discovery;
    const d = await getJson(fetchImpl, `${trimSlash(issuer)}/.well-known/openid-configuration`);
    if (trimSlash(d.issuer) !== trimSlash(issuer)) {
      throw new AuthError(`Provider reports issuer ${d.issuer}, but config says ${issuer}`, 500);
    }
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (!d[k]) throw new AuthError(`Provider discovery document has no ${k}`, 500);
    }
    discovery = d;
    return d;
  }

  async function keyFor(kid, refresh = false) {
    if (!jwks || refresh) jwks = (await getJson(fetchImpl, (await discover()).jwks_uri)).keys ?? [];
    const jwk = jwks.find((k) => (kid ? k.kid === kid : true) && (!k.use || k.use === 'sig'));
    if (jwk) return crypto.createPublicKey({ key: jwk, format: 'jwk' });
    if (!refresh) return keyFor(kid, true); // provider rotated keys
    throw new AuthError('The provider signed the token with a key it does not publish', 401);
  }

  async function verifyIdToken(token, { nonce }) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new AuthError('Malformed ID token', 401);
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    } catch { throw new AuthError('Malformed ID token', 401); }
    const alg = ALGS[header.alg];
    if (!alg) throw new AuthError(`Unsupported token algorithm ${header.alg}`, 401);
    const key = await keyFor(header.kid);
    const opts = alg.ec ? { key, dsaEncoding: 'ieee-p1363' }
      : alg.pss ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: alg.pss } : key;
    const ok = crypto.verify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), opts, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new AuthError('ID token signature is invalid', 401);

    const d = await discover();
    const t = Math.floor(now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (trimSlash(claims.iss) !== trimSlash(d.issuer)) throw new AuthError('ID token is from the wrong issuer', 401);
    if (!aud.includes(clientId)) throw new AuthError('ID token was issued for a different app', 401);
    if (aud.length > 1 && claims.azp && claims.azp !== clientId) throw new AuthError('ID token was issued for a different app', 401);
    if (!(claims.exp + SKEW_S > t)) throw new AuthError('ID token has expired. Try signing in again.', 401);
    if (claims.iat && claims.iat - SKEW_S > t) throw new AuthError('ID token is from the future. Check your clock.', 401);
    if (claims.nonce !== nonce) throw new AuthError('ID token nonce does not match this sign-in', 401);
    return claims;
  }

  function sweep() {
    const t = now();
    for (const [k, v] of pending) if (v.exp < t) pending.delete(k);
  }

  return {
    /** Build the provider URL to send the browser to. */
    async loginUrl({ redirectUri, returnTo = '/' }) {
      sweep();
      if (pending.size > 1000) throw new AuthError('Too many sign-ins in progress. Wait a minute.', 429);
      const d = await discover();
      const state = rand();
      const nonce = rand();
      const verifier = rand(48);
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      pending.set(state, { verifier, nonce, returnTo, redirectUri, exp: now() + PENDING_TTL_MS });
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: scopes,
        state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
        ...(responseMode ? { response_mode: responseMode } : {}),
      }).toString();
      return url.toString();
    },

    /** Handle the provider's redirect back. Returns { user, returnTo }. */
    async callback(params) {
      if (params.error) throw new AuthError(`Sign-in was cancelled or refused: ${params.error_description || params.error}`, 401);
      const p = pending.get(params.state);
      pending.delete(params.state);
      if (!p || p.exp < now()) throw new AuthError('This sign-in link expired or was already used. Start again.', 400);
      if (!params.code) throw new AuthError('Provider did not return a code', 400);
      const d = await discover();
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code: params.code, redirect_uri: p.redirectUri,
        client_id: clientId, code_verifier: p.verifier,
      });
      const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
      const secret = typeof clientSecret === 'function' ? await clientSecret() : clientSecret;
      if (secret) {
        const methods = d.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
        if (methods.includes('client_secret_basic') || !methods.includes('client_secret_post')) {
          headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
        } else {
          body.set('client_secret', secret);
        }
      }
      const tokens = await getJson(fetchImpl, d.token_endpoint, { method: 'POST', headers, body });
      if (!tokens.id_token) throw new AuthError('Provider did not return an ID token (is "openid" in the scopes?)', 502);
      const claims = await verifyIdToken(tokens.id_token, { nonce: p.nonce });
      if (claims.email_verified === false || claims.email_verified === 'false') throw new AuthError(`${claims.email} is not verified at your provider`, 403);
      return {
        user: { sub: claims.sub, email: claims.email ?? null, name: claims.name ?? claims.preferred_username ?? null },
        returnTo: p.returnTo,
      };
    },
  };
}
