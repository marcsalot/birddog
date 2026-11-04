// A pretend sign-in provider for trying Birddog's login locally. DEVELOPMENT ONLY.
// It speaks real OpenID Connect (discovery, JWKS, PKCE, signed ID tokens) but lets
// you pick who to "be" from a list instead of checking a password.

import http from 'node:http';
import { fakeIdp } from '../test/fake-idp.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function startMockIdp({ port = 4900, clientId = 'birddog-dev', accounts = ['you@example.com'] } = {}) {
  const issuer = `http://127.0.0.1:${port}`;
  const idp = fakeIdp({ issuer, clientId });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(redirect)) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        return res.end('This mock provider only redirects back to localhost.');
      }
      if (url.searchParams.get('cancel')) {
        const back = new URL(redirect);
        back.search = new URLSearchParams({ error: 'access_denied', state: url.searchParams.get('state') ?? '' }).toString();
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      const as = url.searchParams.get('as');
      if (as) {
        const { code, state } = idp.authorize(url.toString(), { sub: as, email: as, email_verified: true, name: as.split('@')[0] });
        const back = new URL(redirect);
        back.search = new URLSearchParams({ code, state }).toString();
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      const link = (params) => { const u = new URL(url); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); return esc(u.toString()); };
      const people = [...accounts, 'stranger@example.org'];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock sign-in</title></head>
<body style="font:15px/1.5 system-ui,sans-serif;background:#f3f3f1;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px">
<main style="background:#fff;border:1px solid #e4e4e0;border-radius:16px;padding:24px 28px;max-width:420px;width:100%">
<div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#b45309">Mock provider · development only</div>
<h1 style="font-size:22px;margin:6px 0 4px">Choose an account</h1>
<p style="color:#6b6b68;margin:0 0 16px">Birddog (<code>${esc(clientId)}</code>) wants you to sign in.</p>
${people.map((p) => `<a href="${link({ as: p })}" style="display:block;padding:10px 14px;margin:8px 0;border:1px solid #e4e4e0;border-radius:10px;color:#18191c;text-decoration:none"><b>${esc(p)}</b>${accounts.includes(p) ? '' : '<br><small style="color:#6b6b68">not on Birddog\'s allow list (to see a refusal)</small>'}</a>`).join('')}
<a href="${link({ cancel: 1 })}" style="display:inline-block;margin-top:8px;color:#6b6b68">Cancel</a>
</main></body></html>`);
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const r = await idp.fetch(url.toString(), { method: req.method, body });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(await r.json()));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ issuer, server, close: () => new Promise((r) => server.close(r)) }));
  });
}
