#!/usr/bin/env node
// Build the GitHub Pages site: a landing page, and a live demo of the real Birddog UI
// that runs without a server.
//
//   node scripts/build-pages.mjs [outDir]      (default: _site)
//
// It starts Birddog in --demo mode (made-up data, no network, nothing from your machine),
// records what every read-only API call answers, plus a few Ask Fetch conversations, and
// writes them to app/demo-data.json. In the browser, site/static-demo.js answers the
// app's /api calls from that file, shifting every timestamp so "starts in 8 minutes"
// stays true whenever the page is opened. Changes (done, snooze, replies, slot claims)
// live in the tab only.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemo } from '../src/demo.mjs';
import { createBirddog, VERSION } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, '_site'));
const quiet = { warn() {}, error() {}, log() {} };

/** The GET endpoints the UI reads, recorded as-is. */
const READS = [
  '/api/health', '/api/me', '/api/items', '/api/prefs', '/api/setup', '/api/firstrun', '/api/history?days=14',
  '/api/oauth', '/api/connections/github', '/api/notifications/kinds',
  '/api/chat/status', '/api/chat/boundaries', '/api/chat/memory', '/api/board', '/api/workspace',
];

/** Ask Fetch questions to record: the chat's suggestion chips and its "Try it" probes. */
async function chatQuestions() {
  const src = await fs.readFile(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
  const list = (name) => {
    const m = new RegExp(`const ${name} = \\[(.*?)\\];`, 's').exec(src);
    return m ? [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]) : [];
  };
  return [...new Set([...list('SUGGESTIONS'), ...list('PROBES')])];
}

async function ndjson(res) {
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function capture() {
  const { options, cleanup } = await createDemo();
  const app = await createBirddog({ ...options, autoRefresh: false, log: quiet, replyUndoMs: 0 });
  const port = await app.start(0);
  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await post('/api/refresh', {});
    const capturedAt = Date.now();
    const responses = {};
    for (const p of READS) responses[p] = await get(p);
    // Fetch starts off (it asks for consent first); switch it on to record answers, and keep
    // the "on" status so the demo can switch over when someone agrees.
    const on = await post('/api/chat/setup', { consent: true });
    if (!on.ok) throw new Error(`chat setup: HTTP ${on.status}`);
    responses['/api/chat/status#on'] = await get('/api/chat/status');
    // Who and where each reply would go, for the reply box.
    for (const i of responses['/api/items'].items) if (i.reply) responses[`/api/items/${encodeURIComponent(i.id)}/reply`] = await get(`/api/items/${encodeURIComponent(i.id)}/reply`);
    // Recorded conversations, each in a fresh session; a proposed change is recorded with its confirmation.
    const chats = {};
    for (const q of await chatQuestions()) {
      const events = await ndjson(await post('/api/chat', { message: q }));
      const session = events.find((e) => e.type === 'session')?.id;
      const confirms = events.filter((e) => e.type === 'confirm');
      let confirm = null;
      if (session && confirms.length) {
        confirm = await ndjson(await post('/api/chat/confirm', { sessionId: session, decisions: Object.fromEntries(confirms.map((c) => [c.id, true])) }));
      }
      chats[q] = { events: events.filter((e) => e.type !== 'session'), confirm: confirm?.filter((e) => e.type !== 'session') ?? null };
    }
    return { version: VERSION, capturedAt, responses, chats };
  } finally {
    await app.close();
    await cleanup();
  }
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) await copyDir(a, b);
    else await fs.copyFile(a, b);
  }
}

/** Absolute paths only work at a site root; Pages serves the app under /birddog/app/. */
export function relativize(file, text) {
  if (file.endsWith('index.html')) {
    return text
      .replace(/(href|src)="\/(?!\/)/g, '$1="')
      .replace('<script src="js/boot.js"></script>', '<script src="static-demo.js"></script>\n<script src="js/boot.js"></script>');
  }
  return text.replaceAll('`/guide/', '`guide/').replaceAll("'/favicon.svg'", "'favicon.svg'");
}

export async function build(out = OUT) {
  await fs.rm(out, { recursive: true, force: true });
  const app = path.join(out, 'app');
  await copyDir(path.join(ROOT, 'public'), app);
  for (const f of ['index.html', ...(await fs.readdir(path.join(app, 'js'))).map((x) => path.join('js', x))]) {
    const p = path.join(app, f);
    await fs.writeFile(p, relativize(f, await fs.readFile(p, 'utf8')));
  }
  await fs.copyFile(path.join(ROOT, 'site', 'static-demo.js'), path.join(app, 'static-demo.js'));
  const data = await capture();
  await fs.writeFile(path.join(app, 'demo-data.json'), JSON.stringify(data));
  const landing = (await fs.readFile(path.join(ROOT, 'site', 'index.html'), 'utf8')).replaceAll('{{VERSION}}', data.version);
  await fs.writeFile(path.join(out, 'index.html'), landing);
  await fs.mkdir(path.join(out, 'assets'), { recursive: true });
  for (const f of ['screenshot.png', 'demo.gif']) await fs.copyFile(path.join(ROOT, 'docs', f), path.join(out, 'assets', f)).catch(() => {});
  await fs.copyFile(path.join(ROOT, 'public', 'favicon.svg'), path.join(out, 'favicon.svg'));
  await fs.writeFile(path.join(out, '.nojekyll'), '');
  return { out, chats: Object.keys(data.chats).length, responses: Object.keys(data.responses).length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await build();
  console.log(`Built ${path.relative(process.cwd(), r.out) || r.out}: ${r.responses} recorded responses, ${r.chats} conversations`);
}
