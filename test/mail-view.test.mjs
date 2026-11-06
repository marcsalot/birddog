// Reading an email in Birddog (plain text only), and the "open emails in" preference.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createDemo, demoThunderbird } from '../src/demo.mjs';
import { bodyText, htmlToText } from '../src/mailsense.mjs';
import { createBirddog } from '../src/server.mjs';
import * as gmail from '../src/sources/gmail.mjs';
import * as outlook from '../src/sources/outlook.mjs';
import * as tb from '../src/sources/thunderbird.mjs';
import { fakeFetch, tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const NOW = Date.parse('2026-11-06T15:00:00Z');

describe('message text', () => {
  it('prefers text/plain, decodes quoted-printable, base64 and charsets, and lists attachments', () => {
    const raw = ['Content-Type: multipart/mixed; boundary="M"', '', '--M', 'Content-Type: multipart/alternative; boundary="A"', '', '--A',
      'Content-Type: text/html; charset=utf-8', '', '<p>HTML version</p>', '--A', 'Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: quoted-printable', '',
      'Caf=E9 at 9, ok?=', ' See you', '--A--', '--M', 'Content-Type: application/pdf; name="invoice.pdf"', 'Content-Disposition: attachment; filename="invoice.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERi0=', '--M--', ''].join('\n');
    assert.deepEqual(bodyText(raw), { text: 'Café at 9, ok? See you', html: false, attachments: ['invoice.pdf'] });
    const b64 = `Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${Buffer.from('Grüße\n>From the team').toString('base64')}`;
    assert.equal(bodyText(b64).text, 'Grüße\nFrom the team');
  });

  it('turns HTML into text: no scripts, styles, images or markup survive', () => {
    const t = htmlToText('<style>p{}</style><script>alert(1)</script><p>Hi&nbsp;<b>Sam</b><img src="https://track.example/p.gif"></p><a href="https://x.example/a">the doc</a><br>&#8364;5 &lt;ok&gt;');
    assert.equal(t, 'Hi Sam\nthe doc (https://x.example/a)\n€5 <ok>');
    assert.equal(bodyText('Content-Type: text/html\n\n<p>a</p>').html, true);
    assert.match(bodyText(`Content-Type: text/plain\n\n${'x'.repeat(25_000)}`).text, /the rest is cut off/);
  });

  it('Thunderbird reads the message from its own file', async () => {
    const prof = await demoThunderbird(await tmpDir(), NOW);
    const items = await tb.collect({ profile: prof }, { now: NOW });
    const dana = items.find((i) => /Boiler/.test(i.title));
    assert.equal(dana.meta.mail.messageId, 'd1@home.example');
    const m = await tb.message(dana, {}, { profile: prof });
    assert.equal(m.subject, 'Boiler service visit: Thursday 9–11?');
    assert.match(m.from, /Dana/);
    assert.match(m.text, /engineer can come on Thursday/);
  });

  it('Gmail needs "Read message text" (gmail.readonly) and then reads the full message', async () => {
    const item = { meta: { mail: { id: 'g1' } } };
    await assert.rejects(gmail.message(item, {}, {}), (e) => e.code === 'needs_scope' && /Read message text/.test(e.message));
    const oauth = (scopes) => ({ accessToken: async () => 'tok', grantedScopes: async () => scopes });
    await assert.rejects(gmail.message(item, { oauth: oauth(['https://www.googleapis.com/auth/gmail.metadata']) }, { readBodies: true }), (e) => e.code === 'needs_scope');
    const enc = (t) => Buffer.from(t).toString('base64url');
    const fetch = fakeFetch((u) => {
      assert.equal(u.searchParams.get('format'), 'full');
      return { body: { payload: { headers: [{ name: 'Subject', value: 'Plan' }, { name: 'From', value: 'Boss <b@x>' }], parts: [{ mimeType: 'text/html', body: { data: enc('<p>Hello</p>') } }, { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: enc('Hello, plain ✓') } }, { mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'x' } }] } } };
    });
    const m = await gmail.message(item, { fetch, oauth: oauth([gmail.READ_SCOPE]) }, { readBodies: true });
    assert.deepEqual([m.subject, m.text, m.attachments], ['Plan', 'Hello, plain ✓', ['a.pdf']]);
  });

  it('Outlook asks for text bodies and needs Mail.Read', async () => {
    const item = { meta: { mail: { id: 'o1' } } };
    await assert.rejects(outlook.message(item, {}, {}), (e) => e.code === 'needs_scope');
    const fetch = fakeFetch((u, init) => {
      assert.equal(init.headers.prefer, 'outlook.body-content-type="text"');
      return { body: { subject: 'Invoice', from: { emailAddress: { name: 'Lena', address: 'l@x' } }, toRecipients: [], body: { contentType: 'text', content: 'Please approve' } } };
    });
    const m = await outlook.message(item, { fetch, oauth: { accessToken: async () => 'tok', grantedScopes: async () => ['Mail.Read'] } }, { readBodies: true });
    assert.deepEqual([m.subject, m.from, m.text], ['Invoice', 'Lena <l@x>', 'Please approve']);
  });
});

describe('the API and the preference', () => {
  let demo; let app; let api;
  before(async () => {
    demo = await createDemo();
    app = await createBirddog({ ...demo.options, autoRefresh: false, log: quiet });
    const port = await app.start(0);
    api = async (p, { method = 'GET', body } = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    await app.refresh();
  });
  after(async () => { await app.close(); await demo.cleanup(); });

  it('GET /api/items/:id/message reads Thunderbird and Outlook mail, and refuses non-emails', async () => {
    const items = app.collector.snapshot().items;
    const tbItem = items.find((i) => i.source === 'thunderbird' && /Boiler/.test(i.title));
    let r = await api(`/api/items/${encodeURIComponent(tbItem.id)}/message`);
    assert.equal(r.json.ok, true);
    assert.match(r.json.message.text, /airing cupboard/);
    const ol = items.find((i) => i.source === 'outlook' && /invoice/i.test(i.title));
    r = await api(`/api/items/${encodeURIComponent(ol.id)}/message`);
    assert.equal(r.json.ok, true);
    assert.match(r.json.message.text, /approval by Friday/);
    assert.equal(r.json.link, 'https://outlook.office.com/mail/inbox/id/om1');
    const notMail = items.find((i) => i.kind !== 'email');
    assert.equal((await api(`/api/items/${encodeURIComponent(notMail.id)}/message`)).status, 400);
  });

  it('without read access it says how to turn it on, and gives the link', async () => {
    await api('/api/sources/outlook', { method: 'PUT', body: { readBodies: 'no' } });
    await app.refresh({ only: 'outlook' });
    const ol = app.collector.snapshot().items.find((i) => i.source === 'outlook');
    const r = await api(`/api/items/${encodeURIComponent(ol.id)}/message`);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.needsScope, true);
    assert.match(r.json.error, /Read message text/);
    assert.match(r.json.link, /^https:\/\/outlook\.office\.com\//);
  });

  it('remembers where emails open, and refuses anything else', async () => {
    assert.equal((await api('/api/prefs')).json.emailOpen, 'birddog');
    assert.equal((await api('/api/prefs', { method: 'PUT', body: { emailOpen: 'apple-mail' } })).json.emailOpen, 'apple-mail');
    assert.equal((await api('/api/prefs', { method: 'PUT', body: { emailOpen: 'javascript:alert(1)' } })).status, 400);
  });

  it('asking to read Gmail text swaps gmail.metadata for gmail.readonly at sign-in', async () => {
    await api('/api/sources/gmail', { method: 'PUT', body: { readBodies: 'yes' } });
    let r = await api('/api/oauth/gmail/start', { method: 'POST', body: {} });
    assert.match(r.json.error, /birddog secret set google-client-secret/, 'the secret belongs to the Google app');
    assert.doesNotMatch(r.json.error, /iCal/);
    process.env.BIRDDOG_GOOGLE_CLIENT_SECRET = 'test-not-a-secret';
    try { r = await api('/api/oauth/gmail/start', { method: 'POST', body: {} }); } finally { delete process.env.BIRDDOG_GOOGLE_CLIENT_SECRET; }
    const scope = new URL(r.json.url).searchParams.get('scope');
    assert.match(scope, /gmail\.readonly/);
    assert.doesNotMatch(scope, /gmail\.metadata/, 'Gmail refuses bodies while metadata is granted');
  });
});
