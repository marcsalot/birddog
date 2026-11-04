// Birddog's own OAuth apps: the built-in "Sign in with …" clients.
//
// With a client ID here, "Sign in with X" works out of the box: nobody has to
// register an app of their own. Every app listed is a PUBLIC client (a native
// app that can't keep a secret), so it only uses flows that are safe without one:
// PKCE for authorization-code sign-ins, the device flow for GitHub. Client IDs of
// public clients are not secrets, so they live in the code. The owner's checklist
// for registering them is docs/register-apps.md.
//
// Which client ID wins, for each provider:
//   1. BIRDDOG_<PROVIDER>_CLIENT_ID          (environment)
//   2. config.json                           (oauth.<provider>.clientId; sources.github.clientId)
//   3. the built-in one below                (only for the provider's main cloud, e.g. gitlab.com)
// A client ID you bring yourself never mixes with the built-in secret below.
//
// Per provider:
//   github     device flow, client ID only (no secret, no redirect)
//   gitlab     authorization code + PKCE, non-confidential application, no secret (gitlab.com only)
//   microsoft  public client ("Mobile and desktop"), tenant "common" (work, school and
//              personal accounts), PKCE, no secret
//   google     "Desktop app" client + PKCE. Google issues desktop clients a client secret but
//              says it is not confidential for this client type (it ships inside every copy of
//              a desktop app), so the built-in one may live here. It is still never sent to the
//              browser, an API response or a log.
//   linear     authorization code + PKCE; Linear's docs make client_secret optional with PKCE
//              and let a PKCE token refresh with client_id only
//   pagerduty  Classic User OAuth + PKCE; PagerDuty's docs say a non-confidential client omits
//              client_secret (PKCE required). Refresh without a secret isn't documented, so when
//              it fails (after the 30-day access token), the source asks you to sign in again.
//   atlassian  NOT built in: Atlassian's OAuth 2.0 (3LO) needs a confidential client secret.
//   slack      NOT built in: Slack's OAuth needs a confidential client secret.
//              Both keep the API token as the main way in, and bring-your-own-app for experts.
//
// Values start empty until the owner registers the apps (see docs/register-apps.md).

export const BUILT_IN = Object.freeze({
  github: Object.freeze({ clientId: 'Ov23liwWb176mY399VPJ', host: 'https://github.com' }), // OAuth App "Birddog" (marcsalot), device flow on, no secret; token expiry off (no refresh handling yet)
  gitlab: Object.freeze({ clientId: '', host: 'https://gitlab.com' }),
  microsoft: Object.freeze({ clientId: '' }),
  google: Object.freeze({
    clientId: '',
    clientSecret: '', // desktop-app client secret: not confidential (see above)
    // Google shows an "unverified app" screen, and only the first 100 accounts can sign in,
    // until Google finishes verifying Birddog for the calendar.readonly scope. Set to true then.
    verified: false,
  }),
  linear: Object.freeze({ clientId: '' }),
  pagerduty: Object.freeze({ clientId: '' }),
});

/** Providers that need a confidential secret, so Birddog never ships a built-in app for them. */
export const NO_BUILT_IN = Object.freeze({
  atlassian: 'Atlassian OAuth 2.0 (3LO) needs a confidential client secret, which a downloadable app cannot keep.',
  slack: 'Slack OAuth needs a confidential client secret, which a downloadable app cannot keep.',
});

const envName = (p, what) => `BIRDDOG_${p.toUpperCase()}_${what}`;
const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

/**
 * The client ID to use for a provider, and where it came from.
 * @param {string} p                 provider id
 * @param {object} o
 * @param {object} [o.env]           process.env
 * @param {string} [o.configured]    the client ID from config.json, if any
 * @param {string} [o.host]          the provider host in use (GitLab/GitHub Enterprise): the
 *                                   built-in app only exists on the main cloud
 * @param {object} [o.builtIn]       the registry (tests swap it)
 * @returns {{ clientId: string|null, from: 'env'|'config'|'built-in'|null, variable: string }}
 */
export function resolveClientId(p, { env = process.env, configured = null, host = null, builtIn = BUILT_IN } = {}) {
  const variable = envName(p, 'CLIENT_ID');
  if (env[variable]) return { clientId: env[variable], from: 'env', variable };
  if (configured) return { clientId: configured, from: 'config', variable };
  const b = builtIn[p];
  if (b?.clientId && (!host || !b.host || trimSlash(host) === trimSlash(b.host))) return { clientId: b.clientId, from: 'built-in', variable };
  return { clientId: null, from: null, variable };
}

/** The built-in desktop secret, only when the built-in client ID is the one in use. */
export function builtInSecret(p, from, builtIn = BUILT_IN) {
  return from === 'built-in' ? (builtIn[p]?.clientSecret || null) : null;
}

/** Has Google finished verifying the built-in app? (Drives the "unverified app" notice.) */
export const googleVerified = (builtIn = BUILT_IN) => builtIn.google?.verified === true;
