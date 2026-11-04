// Signed session cookies. Stateless: the cookie carries who you are and when it
// expires, plus an HMAC so it can't be forged. The server re-checks the allow list
// on every request, so removing someone from config.json locks them out at once.

import crypto from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function createSessions({ key, ttlMs = 7 * 86_400_000, secure = false, now = () => Date.now() }) {
  if (!key || key.length < 32) throw new Error('session key must be at least 32 characters');
  const name = secure ? '__Host-birddog' : 'birddog_session';
  const sign = (payload) => b64(crypto.createHmac('sha256', key).update(payload).digest());

  function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  return {
    name,
    /** Returns a Set-Cookie header value for this user. */
    issue(user) {
      const payload = b64(JSON.stringify({ sub: user.sub, email: user.email, name: user.name ?? null, exp: now() + ttlMs }));
      return `${name}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? '; Secure' : ''}`;
    },
    /** Returns the user from a Cookie header, or null if missing, forged or expired. */
    read(cookieHeader) {
      const raw = parseCookies(cookieHeader)[name];
      if (!raw) return null;
      const [payload, mac] = raw.split('.');
      if (!payload || !mac) return null;
      const want = Buffer.from(sign(payload));
      const got = Buffer.from(mac);
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
      let data;
      try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
      if (!(data.exp > now())) return null;
      return { sub: data.sub, email: data.email, name: data.name };
    },
    clear() {
      return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
    },
  };
}
