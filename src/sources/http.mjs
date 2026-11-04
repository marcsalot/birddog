// Small helpers shared by the sources that talk to web APIs.

const TIMEOUT_MS = 15_000;

export class HttpError extends Error {
  constructor(message, { status, headers, body } = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/**
 * GET a JSON document. Returns { body, headers }. Throws HttpError on non-2xx.
 * Only GET: every source is read-only.
 */
export async function getJson(fetchImpl, url, { headers = {}, label = new URL(url).host } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? `did not answer within ${TIMEOUT_MS / 1000}s` : 'is not reachable (are you offline?)';
    throw new HttpError(`${label} ${why}`, { status: 0 });
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new HttpError(`${label} returned HTTP ${res.status}`, { status: res.status, headers: res.headers, body });
  return { body, headers: res.headers };
}

/** The URL of rel="last" (or another rel) in a Link header, if any. */
export function linkRel(link, rel = 'last') {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (m && m[2].split(/\s+/).includes(rel)) return m[1];
  }
  return null;
}

/** Map with at most `limit` calls in flight. */
export async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }));
  return out;
}
