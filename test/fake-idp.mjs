// A fake OpenID Connect provider for tests. It is a fetch() replacement, so no
// network or ports are involved. It enforces PKCE like a real provider would.

import crypto from 'node:crypto';

export function fakeIdp({ issuer = 'https://idp.test', alg = 'RS256', clientId = 'birddog-test', tamper } = {}) {
  const { privateKey, publicKey } = alg.startsWith('ES')
    ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg };
  const codes = new Map();
  const calls = [];

  function sign(claims, header = {}) {
    const h = Buffer.from(JSON.stringify({ alg, kid: 'k1', typ: 'JWT', ...header })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const key = alg.startsWith('ES') ? { key: privateKey, dsaEncoding: 'ieee-p1363' } : privateKey;
    const s = crypto.sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${s}`;
  }

  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

  return {
    issuer,
    clientId,
    calls,
    sign,
    /** Pretend the user signed in at the provider. Returns the callback query. */
    authorize(loginUrl, user = { sub: 'u1', email: 'me@example.com', email_verified: true, name: 'Me' }) {
      const u = new URL(loginUrl);
      const q = Object.fromEntries(u.searchParams);
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { ...q, user });
      return { code, state: q.state, redirectUri: q.redirect_uri, query: q };
    },
    async fetch(url, init = {}) {
      calls.push(String(url));
      const u = new URL(url);
      if (u.pathname === '/.well-known/openid-configuration') {
        return json({
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`, token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        });
      }
      if (u.pathname === '/jwks') return json({ keys: [jwk] });
      if (u.pathname === '/token') {
        const body = new URLSearchParams(init.body);
        const c = codes.get(body.get('code'));
        codes.delete(body.get('code'));
        if (!c) return json({ error: 'invalid_grant' }, 400);
        const challenge = crypto.createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
        if (challenge !== c.code_challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
        if (body.get('redirect_uri') !== c.redirect_uri) return json({ error: 'invalid_grant' }, 400);
        const t = Math.floor(Date.now() / 1000);
        let claims = { iss: issuer, aud: clientId, iat: t, exp: t + 300, nonce: c.nonce, ...c.user };
        if (tamper) claims = tamper(claims);
        return json({ access_token: 'at', token_type: 'Bearer', id_token: sign(claims) });
      }
      return json({ error: 'not_found' }, 404);
    },
  };
}
