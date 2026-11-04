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
// A secret always belongs to the app in use: the built-in Google client reads only
// google-client-secret, the copy of its own secret you stored locally.
//
// Per provider:
//   github     device flow, client ID only (no secret, no redirect)
//   gitlab     authorization code + PKCE, non-confidential application, no secret (gitlab.com only)
//   microsoft  public client ("Mobile and desktop"), tenant "common" (work, school and
//              personal accounts), PKCE, no secret
//   google     "Desktop app" client + PKCE. Google's token exchange also needs the desktop
//              client's secret. By the maintainer's decision it is NOT shipped (not in code,
//              config defaults or docs): each install gets it from whoever runs the Birddog
//              Google project and stores it locally (keychain, or an environment variable /
//              *_FILE). Without it the Calendar card shows that step instead of a button.
//              It is never sent to the browser, an API response or a log.
//   linear     authorization code + PKCE; Linear's docs make client_secret optional with PKCE
//              and let a PKCE token refresh with client_id only
//   pagerduty  Classic User OAuth + PKCE; PagerDuty's docs say a non-confidential client omits
//              client_secret (PKCE required). Refresh without a secret isn't documented, so when
//              it fails (after the 30-day access token), the source asks you to sign in again.
//   atlassian  NOT built in: Atlassian's OAuth 2.0 (3LO) needs a confidential client secret.
//   slack      NOT built in: Slack's OAuth needs a confidential client secret.
//              Both keep the API token as the main way in, and bring-your-own-app for experts.
//
// An empty value means the owner hasn't registered that app yet (see docs/register-apps.md).

export const BUILT_IN = Object.freeze({
  github: Object.freeze({ clientId: 'Ov23liwWb176mY399VPJ', host: 'https://github.com' }), // OAuth App "Birddog" (marcsalot), device flow on, no secret; token expiry off (no refresh handling yet)
  gitlab: Object.freeze({ clientId: '', host: 'https://gitlab.com' }),
  microsoft: Object.freeze({ clientId: '' }),
  google: Object.freeze({
    // Google Cloud project birddog-513721 ("Birddog"), OAuth client "Birddog desktop" (Desktop app).
    clientId: '787425286434-if73gibnotktjm2rrthk4fk3ujre313j.apps.googleusercontent.com',
    // The token exchange needs this client's secret, which is kept out of the repo (see above):
    // it comes from "birddog secret set google-client-secret", BIRDDOG_GOOGLE_CLIENT_SECRET or
    // BIRDDOG_GOOGLE_CLIENT_SECRET_FILE. Until one is set, the Calendar card shows that step.
    localSecret: true,
    // Where Google's review of the app stands; drives the notice next to the button:
    //   'testing'     publishing status "Testing": only test users added in the Google Cloud
    //                 console can sign in (invite-only), and Google ends each sign-in after 7 days
    //   'unverified'  "In production" but not verified: the "unverified app" screen, 100-account cap
    //   'verified'    Google approved the app: no notice
    status: 'testing',
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

/** Does the built-in client need its secret supplied locally (Google's desktop client)? */
export const needsLocalSecret = (p, builtIn = BUILT_IN) => builtIn[p]?.localSecret === true;

const GOOGLE_STATUSES = new Set(['testing', 'unverified', 'verified']);

/** Where Google's review of the built-in app stands: 'testing' | 'unverified' | 'verified'. */
export function googleStatus(builtIn = BUILT_IN) {
  const g = builtIn.google ?? {};
  if (GOOGLE_STATUSES.has(g.status)) return g.status;
  return g.verified === true ? 'verified' : 'unverified'; // older registries used verified: true|false
}

/** Has Google finished verifying the built-in app? (No notice once it has.) */
export const googleVerified = (builtIn = BUILT_IN) => googleStatus(builtIn) === 'verified';
