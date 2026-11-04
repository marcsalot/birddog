// A small JSON client for the token-based sources (GitLab, Linear, Azure DevOps,
// Sentry, PagerDuty, Slack). Reads only: GET, plus POST for query languages that
// require it (GraphQL queries, Azure WIQL). Nothing here ever changes data.

import { HttpError } from './http.mjs';

const TIMEOUT_MS = 15_000;

/**
 * @param {object} o
 * @param {string} o.label       shown in errors ("gitlab.com")
 * @param {string} [o.fix]       what to do when the token is rejected
 * @param {object} [o.headers]   auth headers etc.
 */
export function jsonClient({ fetchImpl = fetch, label, fix = 'Check the token in setup.', headers = {} }) {
  async function request(method, url, body) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { accept: 'application/json', 'user-agent': 'birddog', ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(`${label} is not reachable (are you offline?)`, { status: 0 });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) {
      const why = data?.message || data?.error?.message || data?.error || data?.detail || '';
      throw new HttpError(`${label} rejected the token${why ? ` (${String(why).slice(0, 120)})` : ''}. ${fix}`, { status: res.status, body: data });
    }
    if (res.status === 429) throw new HttpError(`${label} is rate limiting Birddog. It will try again on the next refresh.`, { status: 429 });
    if (!res.ok) throw new HttpError(`${label} returned HTTP ${res.status}${data?.message ? `: ${String(data.message).slice(0, 160)}` : ''}`, { status: res.status, body: data });
    return { data, headers: res.headers };
  }
  return {
    get: async (url) => (await request('GET', url)).data,
    getWithHeaders: (url) => request('GET', url),
    /** For read-only query languages (GraphQL queries, WIQL) that only accept POST. */
    query: async (url, body) => (await request('POST', url, body)).data,
  };
}

export const daysSince = (now, iso) => Math.max(0, (now - Date.parse(iso)) / 86_400_000);

/** Days left until the end of a "YYYY-MM-DD" date (local), or null. */
export function daysUntilDate(ymd, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '');
  if (!m) return null;
  return (new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime() - now) / 86_400_000;
}

/** Normalize a base URL setting: https only, no trailing slash. */
export function baseUrl(input, fallback) {
  const raw = String(input ?? '').trim() || fallback;
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw new TypeError(`"${input}" is not a valid address`); }
  if (u.protocol !== 'https:') throw new TypeError('The address must use https, so your token is never sent in the clear');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Turn a token form into { clean settings } with validation; shared by the token sources. */
export function tokenSetup({ fields = [], token, notes = '', oauth = null }) {
  return { fields, token, notes, oauth };
}
