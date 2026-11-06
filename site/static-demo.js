// Birddog's static demo (GitHub Pages): answers the app's /api calls in the browser from
// demo-data.json, which scripts/build-pages.mjs recorded from `birddog --demo`.
//
// Every timestamp in the recording is shifted by (now - capturedAt), so a meeting that
// was "in 8 minutes" when it was recorded is still in 8 minutes. Changes (done, snooze,
// replies, slot claims) last for this tab only. Nothing leaves the page: there's no
// server, no account and no real data.
(function () {
  'use strict';
  const realFetch = window.fetch.bind(window);
  const DAY = 86400000;
  const READ_ONLY = 'This is a static demo with made-up data, so settings can\'t change here. Install Birddog (npx @marcusferrell/birddog) to connect your own sources.';
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
  const YMD = /^\d{4}-\d{2}-\d{2}$/;

  function shiftDay(s, days) {
    const d = new Date(`${s}T12:00:00`);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  /** Shift every date in a recorded value by delta ms (dates without a time by whole days). */
  function shift(v, delta) {
    const days = Math.round(delta / DAY);
    const walk = (x) => {
      if (typeof x === 'string') {
        if (ISO.test(x)) { const t = Date.parse(x); return Number.isFinite(t) ? new Date(t + delta).toISOString() : x; }
        if (YMD.test(x) && days) return shiftDay(x, days);
        return x;
      }
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === 'object') {
        const o = {};
        for (const [k, val] of Object.entries(x)) o[YMD.test(k) && days ? shiftDay(k, days) : k] = walk(val);
        return o;
      }
      return x;
    };
    return walk(v);
  }
  window.__birddogShift = shift; // for tests

  const dataUrl = new URL('demo-data.json', document.currentScript?.src ?? location.href).href;
  let state = null;
  const ready = realFetch(dataUrl).then((r) => r.json()).then((d) => {
    const delta = Date.now() - d.capturedAt;
    const r = shift(d.responses, delta);
    // No key field on a public page: the demo's answers are scripted, not from Claude.
    for (const k of ['/api/chat/status', '/api/chat/status#on']) if (r[k]) Object.assign(r[k], { hasKey: true, keyVariable: 'none', keyFrom: 'nowhere: this demo replays scripted answers' });
    state = {
      r,
      chats: d.chats,
      items: r['/api/items'],
      prefs: r['/api/prefs'],
      ws: r['/api/workspace'],
      board: r['/api/board'],
      replies: new Map(),
      sessions: 0,
      lastChat: new Map(),
    };
  });

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const bad = (msg, status = 400) => json({ error: msg }, status);
  const now = () => new Date().toISOString();

  // Profiles, as in src/profiles.mjs: the recording holds every item (profile "all"), and
  // the page filters them by the profile you pick.
  const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  function inSchedule(s, t) {
    if (!s) return false;
    const d = new Date(t);
    const n = d.getHours() * 60 + d.getMinutes();
    const from = mins(s.from);
    const to = mins(s.to);
    if (from < to) return s.days.includes(d.getDay()) && n >= from && n < to;
    if (n >= from) return s.days.includes(d.getDay());
    return n < to && s.days.includes((d.getDay() + 6) % 7);
  }
  function profileView() {
    const pv = state.r['/api/profiles'];
    const list = pv?.list ?? [];
    const choice = state.prefs.profile ?? 'auto';
    let profile = null;
    let auto = false;
    if (choice !== 'all') {
      profile = list.find((p) => p.id === choice) ?? null;
      if (!profile) { auto = true; profile = list.find((p) => inSchedule(p.schedule, Date.now())) ?? list.find((p) => !p.schedule) ?? list[0] ?? null; }
    }
    return { ...pv, choice: auto ? 'auto' : choice, active: profile?.id ?? 'all', name: profile?.name ?? 'All sources', auto, notify: profile ? profile.notify : true, list, profile };
  }
  function itemsPayload() {
    state.items.refreshedAt = now();
    const { profile, sources: _all, ...view } = profileView();
    const shows = (id) => !profile || !profile.sources || profile.sources.includes(id);
    const items = state.items.items.filter((i) => shows(i.source));
    return { ...state.items, items, sources: state.items.sources.filter((x) => shows(x.id)), profile: { ...view, hidden: state.items.items.length - items.length } };
  }
  function setItem(id, patch) {
    const i = state.items.items.find((x) => x.id === id);
    if (!i) return false;
    Object.assign(i, patch);
    return true;
  }

  /** An NDJSON stream that types out like the real one. */
  function stream(events) {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      async start(c) {
        for (const e of events) {
          if (e.type === 'text') {
            for (const piece of e.text.match(/[\s\S]{1,8}/g) ?? []) {
              c.enqueue(enc.encode(JSON.stringify({ type: 'text', text: piece }) + '\n'));
              await new Promise((r) => setTimeout(r, 12));
            }
          } else c.enqueue(enc.encode(JSON.stringify(e) + '\n'));
        }
        c.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
  }
  function chatAnswer(body) {
    const id = body.sessionId || `static-${++state.sessions}`;
    const q = String(body.message ?? '').trim();
    const rec = state.chats[q] ?? Object.entries(state.chats).find(([k]) => k.toLowerCase() === q.toLowerCase())?.[1];
    state.lastChat.set(id, rec ?? null);
    const events = rec ? rec.events : [{ type: 'text', text: `In this static demo, Fetch can only replay a few recorded answers: try one of the suggestions. Install Birddog and add your Anthropic key to ask anything ("${q.slice(0, 60)}").` }, { type: 'done' }];
    return stream([{ type: 'session', id }, ...events]);
  }

  function slotClaim(kind, id, body, release) {
    const list = kind === 'dev' ? state.ws.devSlots : state.ws.qaSlots;
    const s = list.find((x) => String(kind === 'dev' ? x.id : x.n) === String(id));
    if (!s) return bad(`No ${kind} slot ${id}`);
    if (release) {
      if (!s.claim) return bad('That slot has no claim');
      s.claim = null;
      if (kind === 'dev' && s.state === 'claimed') { s.state = 'free'; s.ticket = null; s.worktree = null; s.from = null; }
      return json(state.ws);
    }
    const ticket = String(body.ticket ?? '').trim().toUpperCase();
    if (ticket && !/^[A-Z][A-Z0-9]+-\d+$/.test(ticket)) return bad(`"${body.ticket}" doesn't look like a ticket key (like PROJ-123)`);
    if (kind === 'dev' && !ticket && !body.worktree) return bad('Pick a worktree or enter a ticket for this slot');
    if (kind === 'qa' && !ticket && !String(body.owner ?? '').trim()) return bad('Enter a ticket or who has this slot');
    s.claim = { ticket: ticket || null, owner: body.owner || null, worktree: body.worktree || null, note: body.note || null, at: now() };
    if (kind === 'dev' && s.state === 'free') { s.state = 'claimed'; s.ticket = ticket || null; s.worktree = body.worktree || null; s.from = 'you'; }
    return json(state.ws);
  }

  async function handle(method, p, query, body) {
    await ready;
    const key = p + (query ? `?${query}` : '');
    let m;
    if (method === 'GET') {
      if (p === '/api/items') return json(itemsPayload());
      if (p === '/api/prefs') return json(state.prefs);
      if (p === '/api/profiles') { const { profile: _p, ...v } = profileView(); return json(v); }
      if (p === '/api/workspace') return json(state.ws);
      if (p === '/api/board') return json(state.board);
      if (p === '/api/history') return json(state.r['/api/history?days=14']);
      if ((m = /^\/api\/replies\/([^/]+)$/.exec(p))) {
        const r = state.replies.get(m[1]);
        if (!r) return bad('That reply is gone.', 404);
        if (r.state === 'pending' && Date.now() >= Date.parse(r.sendsAt)) { r.state = 'sent'; setItem(r.itemId, { status: 'done', doneAt: now() }); }
        return json(r);
      }
      if (/^\/api\/chat\/conversations\//.test(p)) return bad('Not saved in the static demo', 404);
      if (key in state.r) return json(state.r[key]);
      if (p in state.r) return json(state.r[p]);
      return bad('Not in the static demo', 404);
    }
    if (method === 'POST' && (p === '/api/refresh' || /^\/api\/sources\/[^/]+\/retry$/.test(p))) return json(itemsPayload());
    if (method === 'POST' && (m = /^\/api\/items\/([^/]+)\/(done|snooze|restore)$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      const patch = m[2] === 'done' ? { status: 'done', doneAt: now() }
        : m[2] === 'snooze' ? { status: 'snoozed', snoozedAt: now(), snoozeUntil: body.until }
          : { status: 'open', doneAt: undefined, snoozedAt: undefined, snoozeUntil: undefined };
      return setItem(id, patch) ? json({ ok: true }) : bad('That item is gone. Try refreshing.', 404);
    }
    if (method === 'POST' && (m = /^\/api\/items\/([^/]+)\/reply$/.exec(p))) {
      const text = String(body.text ?? '').trim();
      if (!text) return bad('Type a reply first.');
      const id = `static-reply-${state.replies.size + 1}`;
      const r = { id, state: 'pending', itemId: decodeURIComponent(m[1]), sendsAt: new Date(Date.now() + 5000).toISOString(), text };
      state.replies.set(id, r);
      return json({ id, state: r.state, itemId: r.itemId, sendsAt: r.sendsAt });
    }
    if (method === 'POST' && (m = /^\/api\/replies\/([^/]+)\/undo$/.exec(p))) {
      const r = state.replies.get(m[1]);
      if (!r || r.state !== 'pending') return bad('Too late: it has already gone out.', 409);
      r.state = 'undone';
      return json(r);
    }
    if (method === 'PUT' && p === '/api/prefs') {
      if ('profile' in body && !['auto', 'all', ...(state.r['/api/profiles']?.list ?? []).map((x) => x.id)].includes(body.profile)) return bad('Invalid preference: profile');
      Object.assign(state.prefs, body);
      return json(state.prefs);
    }
    if (method === 'POST' && p === '/api/chat') return chatAnswer(body);
    if (method === 'POST' && p === '/api/chat/confirm') {
      const rec = state.lastChat.get(body.sessionId);
      return stream([{ type: 'session', id: body.sessionId }, ...(rec?.confirm ?? [{ type: 'text', text: 'Done (in this tab only).' }, { type: 'done' }])]);
    }
    if (method === 'POST' && p === '/api/chat/reset') return json({ ok: true });
    if (method === 'POST' && p === '/api/chat/setup') {
      if (body.consent !== true) return bad('Tick the box to agree first.');
      state.r['/api/chat/status'] = state.r['/api/chat/status#on'];
      return json(state.r['/api/chat/status']);
    }
    if (method === 'DELETE' && p === '/api/chat/setup') {
      state.r['/api/chat/status'] = { ...state.r['/api/chat/status#on'], enabled: false, consented: false };
      return json(state.r['/api/chat/status']);
    }
    if (method === 'DELETE' && /^\/api\/chat\/memory/.test(p)) return json({ notes: [] });
    if (method === 'POST' && p === '/api/notifications/claim') return json({ events: [] });
    if ((m = /^\/api\/workspace\/slots\/(dev|qa)\/([^/]+)$/.exec(p)) && (method === 'PUT' || method === 'DELETE')) return slotClaim(m[1], decodeURIComponent(m[2]), body, method === 'DELETE');
    return bad(READ_ONLY);
  }

  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method ?? 'GET').toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { /* not JSON */ }
    return handle(method, url.pathname, url.search.slice(1), body);
  };

  // A banner, so nobody mistakes the demo for a real inbox.
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.className = 'static-banner';
    b.setAttribute('role', 'note');
    b.innerHTML = '<b>Live demo</b> · made-up data, nothing leaves this page · <a href="../">About Birddog</a> · <code>npx @marcusferrell/birddog --demo</code>';
    b.style.cssText = 'position:fixed;left:50%;bottom:46px;transform:translateX(-50%);z-index:50;font:13px/1.4 system-ui,sans-serif;padding:7px 14px;border-radius:999px;background:var(--panel,#fff);color:var(--text,#111);border:1px solid var(--line,#ddd);box-shadow:0 4px 18px rgba(0,0,0,.18);white-space:nowrap;max-width:calc(100vw - 24px);overflow:hidden;text-overflow:ellipsis';
    b.querySelector('a').style.color = 'var(--accent,#d49b00)';
    document.body.append(b);
  });
})();
