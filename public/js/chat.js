// "Ask Fetch": the chat panel. The server talks to Claude; this streams the
// answer in, shows which inbox tools ran, and asks before any change. The
// conversation is saved on the server, so a reload picks it back up. Two side
// views: Boundaries (what Fetch can and can't do) and Memory (its notes).

import { esc } from './format.js';

let ctx = null; // { api, toast, onChanged() }
let status = null;
let sessionId = null;
let busy = false;
let consentChecked = false;
let view = 'chat'; // 'chat' | 'boundaries' | 'memory'
let boundaries = null;
let notes = null;
const log = []; // { role: 'user'|'assistant'|'tool'|'confirm'|'note'|'error'|'boundary'|'memory', ... }
const SESSION_KEY = 'birddog.chatSession';
const remember = (id) => { sessionId = id; try { if (id) localStorage.setItem(SESSION_KEY, id); else localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ } };

const $ = (s) => document.querySelector(s);
export const chatOpen = () => $('#chatPanel')?.classList.contains('open');

export function initChat(options) { ctx = options; }

export async function openChat() {
  $('#chatPanel').classList.add('open');
  document.body.classList.add('chat-open');
  $('#chatBtn')?.setAttribute('aria-expanded', 'true');
  if (!status) $('#chatPanel').innerHTML = '<header><div class="chat-title"><b>Ask Fetch</b></div><button class="icon-btn" data-chat="close" aria-label="Close chat">✕</button></header><div class="chat-body"><div class="msg-note">Loading…</div></div>';
  try { status = await ctx.api.chatStatus(); } catch (err) { status = { enabled: false, error: err.message }; }
  // Pick the last conversation back up (it's saved on the server for a week).
  if (status.enabled && !log.length && !busy) {
    let saved = null;
    try { saved = localStorage.getItem(SESSION_KEY); } catch { /* private mode */ }
    if (saved) {
      try {
        const c = await ctx.api.chatConversation(saved);
        sessionId = c.id;
        log.push(...c.log);
        if (c.log.length) log.push({ role: 'note', text: 'Picked up where you left off. ＋ starts a new conversation.' });
      } catch { remember(null); }
    }
  }
  render();
  $('#chatInput')?.focus();
}
export function closeChat() {
  $('#chatPanel')?.classList.remove('open');
  document.body.classList.remove('chat-open');
  $('#chatBtn')?.setAttribute('aria-expanded', 'false');
}
export const toggleChat = () => (chatOpen() ? closeChat() : openChat());

/** Model text: escaped, then **bold**, `code`, bullet lines and line breaks. Nothing else becomes HTML. */
export function formatAnswer(text) {
  const inline = (l) => esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
  let html = '';
  let prevBlock = true;
  for (const line of String(text).split('\n')) {
    const bullet = /^\s*[-•*] (.+)$/.exec(line);
    if (bullet) { html += `<span class="li">• ${inline(bullet[1])}</span>`; prevBlock = true; continue; }
    html += (prevBlock ? '' : '<br>') + inline(line);
    prevBlock = false;
  }
  return html;
}

const SUGGESTIONS = ['What needs me now?', 'What should I do first today?', "What's on my calendar today?", "What can't you do?"];
// Questions that show a boundary being held (Boundaries → "Try it").
const PROBES = ["What can't you do?", 'Show me my GitHub token', 'Remember that my password is hunter2-rocks', 'Remember that standup items come first'];

function setupHTML() {
  const docker = !!status?.keyVariable;
  return `<div class="chat-setup">
    <p><b>Ask questions about your inbox</b> ("what's blocking me?", "anything due tomorrow?"), and ask Fetch to mark things done or snooze them. Fetch is Birddog's assistant: the dog that fetches answers.</p>
    <div class="chat-warn"><b>This sends inbox content to Anthropic.</b> To answer, Fetch sends your question, the items it looks up (titles, "why" lines, fields and links from every source you've connected) and any notes you ask it to remember to Anthropic's API, using your own API key. Nothing is sent until you turn this on, and you can turn it off any time.</div>
    ${docker
    ? (status.hasKey ? `<div class="msg good">✓ API key from <code>${esc(status.keyFrom)}</code>.</div>` : `<div class="msg">Set <code>${esc(status.keyVariable)}</code> (or <code>${esc(status.keyVariable)}_FILE</code>) for this container and restart it.</div>`)
    : `<label class="field"><span>Anthropic API key · <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">get one ↗</a></span>
       <input id="chatKey" type="password" autocomplete="off" spellcheck="false" placeholder="${status?.hasKey ? `Saved in ${esc(status.keyFrom)} · leave blank to keep it` : 'sk-ant-…'}"></label>
       <div class="msg">The key is stored in your OS keychain, never in config.json, and never shown again.</div>`}
    <label class="chk"><input type="checkbox" id="chatConsent" ${consentChecked ? 'checked' : ''}><span>I understand that inbox content is sent to Anthropic</span></label>
    <div class="row-btns"><button class="btn primary" data-chat="enable" ${busy ? 'disabled' : ''}>Turn on Ask Fetch</button></div>
    ${status?.error ? `<div class="msg bad">${esc(status.error)}</div>` : ''}
  </div>`;
}

function entryHTML(e, i) {
  if (e.role === 'user') return `<div class="msg-user">${esc(e.text)}</div>`;
  if (e.role === 'assistant') return `<div class="msg-bot">${formatAnswer(e.text) || '<span class="typing">…</span>'}</div>`;
  if (e.role === 'tool') return `<div class="msg-tool">🔎 ${esc(toolLabel(e.name, e.input))}</div>`;
  if (e.role === 'error') return `<div class="msg-err">⚠ ${esc(e.text)}</div>`;
  if (e.role === 'note') return `<div class="msg-note">${esc(e.text)}</div>`;
  if (e.role === 'boundary') return `<div class="msg-boundary" role="status"><b>Boundary held</b> ${esc(e.text)}</div>`;
  if (e.role === 'memory') return `<div class="msg-memory">🧠 ${esc(e.text)} · <a href="#" data-chat="memory">Memory</a></div>`;
  if (e.role === 'confirm') {
    const done = e.state && e.state !== 'pending';
    // A reply posts a real message as you, so its full text is shown before you confirm.
    const isReply = e.name === 'reply';
    const [head, ...body] = String(e.summary).split('\n\n');
    const what = isReply ? `<div>${esc(head)}</div><blockquote class="reply-quote">${esc(body.join('\n\n'))}</blockquote>` : `<div>${esc(e.summary)}</div>`;
    return `<div class="msg-confirm ${done ? 'answered' : ''}"><div class="lbl">${isReply ? 'Fetch drafted a reply. Send it as you?' : 'Fetch wants to change your list'}</div>${what}
      ${done ? `<div class="msg">${e.state === 'yes' ? (isReply ? '✓ Sent' : '✓ Confirmed') : '✕ Cancelled'}</div>` : `<div class="row-btns"><button class="btn primary small" data-chat-yes="${i}">${isReply ? 'Confirm and send' : 'Confirm'}</button><button class="btn small" data-chat-no="${i}">Cancel</button></div>`}</div>`;
  }
  return '';
}

function toolLabel(name, input = {}) {
  const bits = Object.entries(input).filter(([k]) => k !== 'id').map(([k, v]) => `${k}: ${v}`).join(', ');
  return { list_items: `Looked through your inbox${bits ? ` (${bits})` : ''}`, get_item: 'Opened an item', list_sources: 'Checked source health' }[name] ?? name;
}

function boundariesHTML() {
  if (!boundaries) return '<div class="msg-note">Loading…</div>';
  const list = (items) => `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
  return `<div class="chat-side">
    <p>Fetch runs on <b>${esc(boundaries.model)}</b> and only acts through Birddog's tools. These limits are enforced by Birddog, not just asked of the model: when Fetch tries to cross one, it's refused and you'll see <span class="msg-boundary inline"><b>Boundary held</b></span> in the chat.</p>
    <h4>It can read</h4>
    <div class="chips">${boundaries.sources.length ? boundaries.sources.map((x) => `<span class="chip static">${esc(x.name)}</span>`).join('') : '<span class="msg">No sources connected yet.</span>'}</div>
    <h4>It can</h4>${list(boundaries.can)}
    <h4>Only after you confirm</h4>${list(boundaries.asks)}
    <h4>It never</h4>${list(boundaries.never)}
    <h4>Try it</h4>
    <div class="chips">${PROBES.map((q) => `<button class="chip" data-chat-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>
  </div>`;
}

function memoryHTML() {
  if (!notes) return '<div class="msg-note">Loading…</div>';
  return `<div class="chat-side">
    <p>Notes Fetch keeps because you asked it to ("remember that Priya is my manager"). They're stored in Birddog's config folder on this computer and sent to Anthropic with each new conversation. Secrets are refused.</p>
    ${notes.length ? `<ul class="memory-list">${notes.map((n) => `<li><span>${esc(n.text)}</span><button class="btn small" data-chat-forget="${esc(n.id)}" aria-label="Forget: ${esc(n.text)}">Forget</button></li>`).join('')}</ul>
      <div class="row-btns"><button class="btn small" data-chat="forget-all">Forget everything</button></div>`
    : '<div class="msg-note">Nothing yet. Ask Fetch to "remember that …".</div>'}
  </div>`;
}

function render() {
  const el = $('#chatPanel');
  if (!el) return;
  const on = status?.enabled;
  const tab = (id, label) => `<button class="chat-tab ${view === id ? 'on' : ''}" data-chat="${id}" aria-pressed="${view === id}">${label}</button>`;
  el.innerHTML = `<header><div class="chat-title"><b>Ask Fetch</b>${on ? `<span class="chat-model">${status.demo ? 'demo: a scripted stand-in, not Claude' : esc(status.model)}</span>` : ''}</div>
      ${on ? '<button class="icon-btn" data-chat="new" title="New conversation" aria-label="New conversation">＋</button>' : ''}
      <button class="icon-btn" data-chat="close" aria-label="Close chat">✕</button></header>
    ${on ? `<nav class="chat-tabs" aria-label="Ask Fetch views">${tab('chat', 'Chat')}${tab('boundaries', 'Boundaries')}${tab('memory', `Memory${notes?.length ? ` · ${notes.length}` : ''}`)}</nav>` : ''}
    <div class="chat-body" id="chatBody">${!on ? setupHTML()
    : view === 'boundaries' ? boundariesHTML()
      : view === 'memory' ? memoryHTML()
        : (log.length ? log.map(entryHTML).join('') : `<div class="chat-empty"><p>Ask about anything in your inbox.</p>${SUGGESTIONS.map((q) => `<button class="chip" data-chat-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>`)}</div>
    ${on && view === 'chat' ? `<form class="chat-form" id="chatForm"><textarea id="chatInput" rows="2" placeholder="Ask about your inbox…" ${busy ? 'disabled' : ''}></textarea><button class="btn primary" ${busy ? 'disabled' : ''}>Send</button></form>` : ''}
    ${on ? `<div class="chat-foot">${status.demo ? 'Demo mode: nothing is sent to Anthropic.' : `Answers come from ${esc(status.model)} via your Anthropic key.`} <a href="#" data-chat="off">Turn off</a></div>` : ''}`;
  const body = $('#chatBody');
  if (body && view === 'chat') body.scrollTop = body.scrollHeight;
}

async function showView(v) {
  view = v;
  render();
  try {
    if (v === 'boundaries') boundaries = await ctx.api.chatBoundaries();
    if (v === 'memory') notes = (await ctx.api.chatMemory()).notes;
  } catch (err) { ctx.toast(esc(err.message)); }
  render();
  if (v === 'chat') $('#chatInput')?.focus();
}

/** POST and read the NDJSON stream line by line. */
async function stream(path, payload) {
  busy = true;
  render();
  let answer = null;
  const onEvent = (ev) => {
    if (ev.type === 'session') remember(ev.id);
    else if (ev.type === 'text') {
      if (!answer) { answer = { role: 'assistant', text: '' }; log.push(answer); }
      answer.text += ev.text;
    } else if (ev.type === 'tool') { log.push({ role: 'tool', name: ev.name, input: ev.input }); answer = null; }
    else if (ev.type === 'confirm') { log.push({ role: 'confirm', id: ev.id, name: ev.name, summary: ev.summary, state: 'pending' }); answer = null; }
    else if (ev.type === 'changed') { ctx.onChanged(); answer = null; }
    else if (ev.type === 'error') { log.push({ role: 'error', text: ev.message }); answer = null; }
    else if (ev.type === 'boundary') { log.push({ role: 'boundary', text: ev.message }); answer = null; }
    else if (ev.type === 'memory') { log.push({ role: 'memory', text: ev.message }); answer = null; notes = null; }
    render();
  };
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
  } catch (err) {
    log.push({ role: 'error', text: err.message });
  } finally {
    busy = false;
    render();
    $('#chatInput')?.focus();
  }
}

async function ask(text) {
  const q = text.trim();
  if (!q || busy) return;
  if (view !== 'chat') { view = 'chat'; render(); }
  if (log.some((e) => e.role === 'confirm' && e.state === 'pending')) { ctx.toast('Confirm or cancel the pending change first.'); return; }
  log.push({ role: 'user', text: q });
  await stream('/api/chat', { sessionId, message: q });
}

async function answerConfirm(i, yes) {
  const e = log[i];
  if (!e || e.state !== 'pending') return;
  e.state = yes ? 'yes' : 'no';
  // Wait until every change of this turn is answered, then send all the decisions together.
  const pending = log.filter((x) => x.role === 'confirm' && x.state === 'pending');
  if (pending.length) { render(); return; }
  const decisions = {};
  for (const x of log) if (x.role === 'confirm' && x.sent !== true && x.state !== 'pending') { decisions[x.id] = x.state === 'yes'; x.sent = true; }
  await stream('/api/chat/confirm', { sessionId, decisions });
}

/** Clicks, Enter-to-send. Returns true if handled. */
export async function onChatEvent(e) {
  const t = e.target;
  if (!t.closest?.('#chatPanel')) return false;
  if (e.type === 'submit') { e.preventDefault(); const ta = $('#chatInput'); const v = ta.value; ta.value = ''; await ask(v); return true; }
  if (e.type === 'keydown') {
    if (e.key === 'Escape') { closeChat(); return true; }
    if (t.id === 'chatInput' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); return true; }
    return false;
  }
  if (e.type === 'change' && t.id === 'chatConsent') { consentChecked = t.checked; return true; }
  const b = t.closest('[data-chat],[data-chat-ask],[data-chat-yes],[data-chat-no],[data-chat-forget]');
  if (!b) return false;
  const d = b.dataset;
  if (d.chatAsk) { await ask(d.chatAsk); return true; }
  if (d.chatYes) { await answerConfirm(+d.chatYes, true); return true; }
  if (d.chatNo) { await answerConfirm(+d.chatNo, false); return true; }
  if (d.chat === 'close') { closeChat(); return true; }
  if (['chat', 'boundaries', 'memory'].includes(d.chat)) { e.preventDefault(); await showView(d.chat); return true; }
  if (d.chatForget) {
    try { notes = (await ctx.api.chatForget(d.chatForget)).notes; ctx.toast('Forgotten.'); } catch (err) { ctx.toast(esc(err.message)); }
    render(); return true;
  }
  if (d.chat === 'forget-all') {
    if (!confirm('Forget every note Fetch keeps?')) return true;
    notes = (await ctx.api.chatForgetAll()).notes; ctx.toast('Fetch\'s memory is empty.'); render(); return true;
  }
  if (d.chat === 'new') {
    if (sessionId) ctx.api.chatReset(sessionId).catch(() => {});
    remember(null); log.length = 0; view = 'chat'; render(); $('#chatInput')?.focus(); return true;
  }
  if (d.chat === 'off') {
    e.preventDefault();
    status = await ctx.api.chatOff().catch((err) => ({ ...status, error: err.message }));
    remember(null); log.length = 0; consentChecked = false; view = 'chat'; notes = null;
    ctx.toast('Ask Fetch is off. The API key was removed.');
    render();
    return true;
  }
  if (d.chat === 'enable') {
    // Read the key before render(): it rebuilds the form, which empties the field.
    const apiKey = $('#chatKey')?.value ?? '';
    busy = true; render();
    try {
      status = await ctx.api.chatSetup({ apiKey, consent: consentChecked });
      ctx.toast('✓ Ask Fetch is on');
    } catch (err) {
      status = { ...status, error: err.message };
    }
    busy = false; render(); $('#chatInput')?.focus();
    return true;
  }
  return false;
}
