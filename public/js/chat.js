// "Ask Fetch": the chat panel. The server talks to Claude; this streams the
// answer in, shows which inbox tools ran, and asks before any change.

import { esc } from './format.js';

let ctx = null; // { api, toast, onChanged() }
let status = null;
let sessionId = null;
let busy = false;
let consentChecked = false;
const log = []; // { role: 'user'|'assistant'|'tool'|'confirm'|'note'|'error', ... }

const $ = (s) => document.querySelector(s);
export const chatOpen = () => $('#chatPanel')?.classList.contains('open');

export function initChat(options) { ctx = options; }

export async function openChat() {
  $('#chatPanel').classList.add('open');
  document.body.classList.add('chat-open');
  $('#chatBtn')?.setAttribute('aria-expanded', 'true');
  if (!status) $('#chatPanel').innerHTML = '<header><div class="chat-title"><b>Ask Fetch</b></div><button class="icon-btn" data-chat="close" aria-label="Close chat">✕</button></header><div class="chat-body"><div class="msg-note">Loading…</div></div>';
  try { status = await ctx.api.chatStatus(); } catch (err) { status = { enabled: false, error: err.message }; }
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

const SUGGESTIONS = ['What needs me now?', 'What should I do first today?', "What's on my calendar today?", 'Which of my PRs need work?'];

function setupHTML() {
  const docker = !!status?.keyVariable;
  return `<div class="chat-setup">
    <p><b>Ask questions about your inbox</b> ("what's blocking me?", "anything due tomorrow?"), and ask Fetch to mark things done or snooze them. Fetch is Birddog's assistant: the dog that fetches answers.</p>
    <div class="chat-warn"><b>This sends inbox content to Anthropic.</b> To answer, Fetch sends your question and the items it looks up (titles, "why" lines, fields and links from git, GitHub, Jira and your calendar) to Anthropic's API, using your own API key. Nothing is sent until you turn this on, and you can turn it off any time.</div>
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
  if (e.role === 'confirm') {
    const done = e.state && e.state !== 'pending';
    return `<div class="msg-confirm ${done ? 'answered' : ''}"><div class="lbl">Fetch wants to change your list</div><div>${esc(e.summary)}</div>
      ${done ? `<div class="msg">${e.state === 'yes' ? '✓ Confirmed' : '✕ Cancelled'}</div>` : `<div class="row-btns"><button class="btn primary small" data-chat-yes="${i}">Confirm</button><button class="btn small" data-chat-no="${i}">Cancel</button></div>`}</div>`;
  }
  return '';
}

function toolLabel(name, input = {}) {
  const bits = Object.entries(input).filter(([k]) => k !== 'id').map(([k, v]) => `${k}: ${v}`).join(', ');
  return { list_items: `Looked through your inbox${bits ? ` (${bits})` : ''}`, get_item: 'Opened an item', list_sources: 'Checked source health' }[name] ?? name;
}

function render() {
  const el = $('#chatPanel');
  if (!el) return;
  const on = status?.enabled;
  el.innerHTML = `<header><div class="chat-title"><b>Ask Fetch</b>${on ? `<span class="chat-model">${status.demo ? 'demo: a scripted stand-in, not Claude' : esc(status.model)}</span>` : ''}</div>
      ${on ? '<button class="icon-btn" data-chat="new" title="New conversation" aria-label="New conversation">＋</button>' : ''}
      <button class="icon-btn" data-chat="close" aria-label="Close chat">✕</button></header>
    <div class="chat-body" id="chatBody">${on
    ? (log.length ? log.map(entryHTML).join('') : `<div class="chat-empty"><p>Ask about anything in your inbox.</p>${SUGGESTIONS.map((q) => `<button class="chip" data-chat-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>`)
    : setupHTML()}</div>
    ${on ? `<form class="chat-form" id="chatForm"><textarea id="chatInput" rows="2" placeholder="Ask about your inbox…" ${busy ? 'disabled' : ''}></textarea><button class="btn primary" ${busy ? 'disabled' : ''}>Send</button></form>
    <div class="chat-foot">${status.demo ? 'Demo mode: nothing is sent to Anthropic.' : `Answers come from ${esc(status.model)} via your Anthropic key.`} <a href="#" data-chat="off">Turn off</a></div>` : ''}`;
  const body = $('#chatBody');
  if (body) body.scrollTop = body.scrollHeight;
}

/** POST and read the NDJSON stream line by line. */
async function stream(path, payload) {
  busy = true;
  render();
  let answer = null;
  const onEvent = (ev) => {
    if (ev.type === 'session') sessionId = ev.id;
    else if (ev.type === 'text') {
      if (!answer) { answer = { role: 'assistant', text: '' }; log.push(answer); }
      answer.text += ev.text;
    } else if (ev.type === 'tool') { log.push({ role: 'tool', name: ev.name, input: ev.input }); answer = null; }
    else if (ev.type === 'confirm') { log.push({ role: 'confirm', id: ev.id, name: ev.name, summary: ev.summary, state: 'pending' }); answer = null; }
    else if (ev.type === 'changed') { ctx.onChanged(); answer = null; }
    else if (ev.type === 'error') { log.push({ role: 'error', text: ev.message }); answer = null; }
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
  const b = t.closest('[data-chat],[data-chat-ask],[data-chat-yes],[data-chat-no]');
  if (!b) return false;
  const d = b.dataset;
  if (d.chatAsk) { await ask(d.chatAsk); return true; }
  if (d.chatYes) { await answerConfirm(+d.chatYes, true); return true; }
  if (d.chatNo) { await answerConfirm(+d.chatNo, false); return true; }
  if (d.chat === 'close') { closeChat(); return true; }
  if (d.chat === 'new') {
    if (sessionId) ctx.api.chatReset(sessionId).catch(() => {});
    sessionId = null; log.length = 0; render(); $('#chatInput')?.focus(); return true;
  }
  if (d.chat === 'off') {
    e.preventDefault();
    status = await ctx.api.chatOff().catch((err) => ({ ...status, error: err.message }));
    sessionId = null; log.length = 0; consentChecked = false;
    ctx.toast('Ask Fetch is off. The API key was removed.');
    render();
    return true;
  }
  if (d.chat === 'enable') {
    busy = true; render();
    try {
      status = await ctx.api.chatSetup({ apiKey: $('#chatKey')?.value ?? '', consent: consentChecked });
      ctx.toast('✓ Ask Fetch is on');
    } catch (err) {
      status = { ...status, error: err.message };
    }
    busy = false; render(); $('#chatInput')?.focus();
    return true;
  }
  return false;
}
