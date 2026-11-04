// Birddog UI: inbox, details drawer, snooze, undo, command palette, setup, appearance.
// Plain ES modules, no framework. All item text is escaped before it touches the DOM.

import { api } from './api.js';
import {
  PALETTE_NAMES, appearanceHTML, cyclePalette, initAppearance, setMode, setPalette, toggleTheme,
} from './appearance.js';
import { chatOpen, closeChat, initChat, onChatEvent, toggleChat } from './chat.js';
import { bindOverview, overviewData, overviewHTML } from './overview.js';
import { closeNotifyPanel, initNotify, notifyPanelOpen, onNotifyPanelEvent, poll as pollNotifications, toggleNotifyPanel } from './notify.js';
import { esc, plain, relTime, shortAge, shortUntil, snoozeChoices, whenLabel, whyHTML } from './format.js';

// ---------------------------------------------------------------------------
// Static display info

const SRC = {
  git: { short: '⎇', c: 'var(--git)' },
  github: { short: 'GH', c: 'var(--gh)', cls: 'gh' },
  jira: { short: 'J', c: 'var(--jira)' },
  cal: { short: '◷', c: 'var(--cal)' },
};
const srcInfo = (id) => SRC[id] ?? { short: id.slice(0, 2).toUpperCase(), c: 'var(--later)' };
const URG = {
  now: { label: 'Now', c: 'var(--now)' },
  today: { label: 'Today', c: 'var(--today)' },
  later: { label: 'Later', c: 'var(--later)' },
};
const VIEWS = [['all', 'All', '◎'], ['now', 'Now'], ['today', 'Today'], ['later', 'Later'], ['snoozed', 'Snoozed', '☾'], ['done', 'Done', '✓']];
const HEADINGS = { overview: 'Overview', all: 'Needs me', now: 'Now', today: 'Today', later: 'Later', snoozed: 'Snoozed', done: 'Done' };
const COMING = [];

// ---------------------------------------------------------------------------
// State

const st = {
  loaded: false,
  view: 'overview', // the front page; the inbox is one click (or key 1) away
  history: [],
  hidden: new Set(),
  selId: null,
  query: '',
  undo: null,
  items: [],
  sources: [],
  refreshedAt: null,
  refreshing: false,
  setup: null,
  cards: {}, // per-source setup card UI state
  retrying: new Set(), // sources being retried from a stale bar
  wizard: null, // { step } while the first-run wizard is open
};

const $ = (s) => document.querySelector(s);
const byId = (id) => st.items.find((i) => i.id === id);

function matches(i, q) {
  const hay = `${i.title} ${plain(i.why)} ${Object.values(i.meta?.fields ?? {}).join(' ')}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

function visible(view = st.view) {
  if (view === 'overview') return [];
  return st.items.filter((i) => {
    if (st.hidden.has(i.source)) return false;
    if (view === 'done') return i.status === 'done';
    if (view === 'snoozed') return i.status === 'snoozed';
    if (i.status !== 'open') return false;
    if (st.query && !matches(i, st.query)) return false;
    return view === 'all' || i.urgency === view;
  });
}

function ordered() {
  const v = visible();
  if (st.view === 'done') return v.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  if (st.view === 'snoozed') return v.sort((a, b) => (b.snoozedAt ?? '').localeCompare(a.snoozedAt ?? ''));
  return ['now', 'today', 'later'].flatMap((u) => v.filter((i) => i.urgency === u));
}

function selIndex(list = ordered()) {
  const i = list.findIndex((x) => x.id === st.selId);
  return i < 0 ? 0 : i;
}
const current = () => { const l = ordered(); return l[selIndex(l)]; };

// ---------------------------------------------------------------------------
// Rendering

function renderNav() {
  const ov = `<button class="${st.view === 'overview' ? 'active' : ''}" data-view="overview" aria-current="${st.view === 'overview'}"><span style="width:8px;text-align:center" aria-hidden="true">◔</span>Overview<kbd class="hint">0</kbd><span class="count"></span></button>`;
  $('#views').innerHTML = ov + VIEWS.map(([k, label, icon], n) => {
    const dot = URG[k] ? `<span class="dot" style="background:${URG[k].c}"></span>` : `<span style="width:8px;text-align:center" aria-hidden="true">${icon}</span>`;
    const count = visible(k).length;
    return `<button class="${st.view === k ? 'active' : ''}" data-view="${k}" aria-current="${st.view === k}">${dot}${label}<kbd class="hint">${n + 1}</kbd><span class="count">${count || ''}</span></button>`;
  }).join('');

  const real = st.sources.map((s) => {
    const info = srcInfo(s.id);
    const on = !st.hidden.has(s.id);
    const status = s.status === 'stale' ? `<span class="src-status warn" title="${esc(staleTitle(s))}">! stale</span>`
      : s.status === 'pending' ? '<span class="src-status">…</span>'
        : `<span class="src-status">${s.count || ''}</span>`;
    return `<button class="src-toggle ${on ? 'on' : ''}" data-src="${esc(s.id)}" style="--c:${info.c}" aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} ${esc(s.name)} items"><span class="check">${on ? '✓' : ''}</span>${esc(s.name)}${status}</button>`;
  });
  const soon = COMING.filter(([id]) => !st.sources.some((s) => s.id === id))
    .map(([id, name]) => `<button class="src-toggle soon" data-soon="${id}" title="Coming soon"><span class="check"></span>${name}<span class="src-status">soon</span></button>`);
  $('#sources').innerHTML = [...real, ...soon].join('');

  const now = visible('now').length;
  document.title = now ? `(${now}) Birddog` : 'Birddog';
}

function staleTitle(s) {
  const next = s.nextRetryAt ? ` · next try ${whenLabel(s.nextRetryAt)}` : '';
  return `Could not refresh since ${whenLabel(s.staleSince ?? Date.now())}${next}: ${s.error ?? ''}`;
}

/** One bar per broken source, above the list: what's wrong, how old the data is, and Retry. */
function staleBarsHTML() {
  if (st.view === 'done' || st.view === 'snoozed') return '';
  return st.sources.filter((s) => s.status === 'stale' && !st.hidden.has(s.id) && s.count).map((s) => {
    const next = s.nextRetryAt && s.failures > 1 ? ` Next automatic try ${esc(whenLabel(s.nextRetryAt))}.` : '';
    const busy = st.retrying.has(s.id);
    return `<div class="stale-bar" role="status"><span class="icon" aria-hidden="true">⚠</span>
      <div class="txt"><b>${esc(s.name)}</b> is <span class="stale-badge">stale since ${esc(whenLabel(s.staleSince ?? Date.now()))}</span> · showing what it found ${esc(relTime(s.lastSuccess))}.${next}<br><small>${esc(s.error)}</small></div>
      <button class="btn small" data-retry="${esc(s.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Retrying…' : '↻ Retry'}</button><button class="btn small" data-setup>Fix</button></div>`;
  }).join('');
}

async function retrySource(id) {
  if (st.retrying.has(id)) return;
  st.retrying.add(id);
  render();
  try {
    applyData(await api.retrySource(id));
    const s = st.sources.find((x) => x.id === id);
    toast(s?.status === 'ok' ? `✓ ${esc(s.name)} is back` : `⚠ ${esc(s?.name ?? id)} still could not refresh: ${esc(s?.error ?? '')}`);
  } catch (err) {
    toast(`⚠ ${esc(err.message)}`);
  } finally {
    st.retrying.delete(id);
    render();
    renderUpdated();
  }
}

function ageCell(i) {
  if (i.status === 'done') return `done ${shortAge(i.doneAt)}`;
  if (i.status === 'snoozed') return i.snoozedUntil === 'change' ? 'until it changes' : `until ${whenLabel(i.snoozedUntil)}`;
  if (Date.parse(i.updatedAt) > Date.now() + 60_000) return shortUntil(i.updatedAt); // e.g. a meeting that hasn't started
  return shortAge(i.updatedAt);
}

function rowHTML(i, selected) {
  const s = srcInfo(i.source);
  const parked = i.status !== 'open';
  const extra = (i.wokeAt ? '<span class="woke">☀ back from snooze</span> · ' : '');
  const staleAt = st.sources.find((s) => s.id === i.source)?.staleSince ?? i.stale?.since;
  const stale = i.stale ? ` · <span class="stale">⚠ stale since ${esc(whenLabel(staleAt ?? Date.now()))}</span>` : '';
  return `<div class="row ${selected ? 'sel' : ''}" data-id="${esc(i.id)}" style="--u:${URG[i.urgency].c}" role="option" aria-selected="${selected}">
    <div class="badge ${s.cls ?? ''}" style="--c:${s.c}" title="${esc(i.source)}">${s.short}</div>
    <div style="min-width:0"><div class="title">${esc(i.title)}</div><div class="why">${extra}${whyHTML(i.why)}${stale}</div></div>
    <div class="meta"><span class="age">${esc(ageCell(i))}</span><span class="actions">
      ${parked
    ? '<button class="act" data-act="restore">↩ Restore</button>'
    : '<button class="act" data-act="done" title="Done (x)">✓ Done</button><button class="act" data-act="snooze" title="Snooze (s)">☾ Snooze</button>'}
    </span></div></div>`;
}

function emptyHTML() {
  if (!st.loaded || (st.sources.length && st.sources.every((s) => s.status === 'pending'))) {
    return '<div class="empty loading"><div class="big">🐾</div><h2>Sniffing around your repos…</h2><div>The first scan takes a few seconds.</div></div>';
  }
  const broken = st.sources.find((s) => s.status === 'stale' && !s.count);
  if (broken && st.view !== 'done' && st.view !== 'snoozed') {
    return `<div class="empty"><div class="big">🧭</div><h2>${esc(broken.name)} needs a hand</h2><div>${esc(broken.error)}</div><button class="btn primary" data-setup>Fix in setup →</button></div>`;
  }
  if (st.view === 'done') return '<div class="empty"><div class="big">·</div><h2>Nothing done yet</h2><div>Press <kbd>x</kbd> on an item and it lands here. If it changes later, it comes back.</div></div>';
  if (st.view === 'snoozed') return '<div class="empty"><div class="big">☾</div><h2>Nothing snoozed</h2><div>Press <kbd>s</kbd> to hide an item until later.</div></div>';
  if (st.query) return `<div class="empty"><div class="big">🔍</div><h2>No matches</h2><div>Nothing open matches “${esc(st.query)}”.</div></div>`;
  const total = st.sources.reduce((n, s) => n + (s.count || 0), 0);
  const git = st.sources.find((s) => s.id === 'git');
  const note = total ? 'Nothing needs you here right now. Nice work.'
    : `${git?.summary ? `${esc(git.summary[0].toUpperCase() + git.summary.slice(1))}, ` : ''}all clean. Nothing needs you right now.`;
  return `<div class="empty"><div class="big">🌤</div><h2>Inbox zero</h2><div>${note}</div></div>`;
}

function renderOverview() {
  const el = $('#list');
  const data = overviewData({ items: st.items, sources: st.sources, history: st.history.length ? st.history : [{ date: new Date().toISOString().slice(0, 10), missing: true }] });
  el.innerHTML = overviewHTML(data, { width: el.clientWidth });
  bindOverview(el);
}

function render() {
  renderNav();
  if (st.view === 'overview') return renderOverview();
  const list = ordered();
  const idx = selIndex(list);
  st.selId = list[idx]?.id ?? null;
  const bars = staleBarsHTML();
  const head = bars + `<div class="page-head"><h1>${HEADINGS[st.view]}</h1><span class="sub">${list.length} item${list.length === 1 ? '' : 's'}${st.query ? ` matching “${esc(st.query)}” <button class="chip" id="clearQ">clear ✕</button>` : ''}</span></div>`;
  if (!list.length) {
    $('#list').innerHTML = head + emptyHTML();
    return;
  }
  let html = head;
  let n = 0;
  if (st.view === 'done' || st.view === 'snoozed') {
    html += `<div class="list" role="listbox">${list.map((i) => rowHTML(i, n++ === idx)).join('')}</div>`;
  } else {
    for (const u of ['now', 'today', 'later']) {
      const g = list.filter((i) => i.urgency === u);
      if (!g.length) continue;
      html += `<section class="group"><div class="group-head"><span class="dot" style="background:${URG[u].c}"></span>${URG[u].label}<span style="color:var(--faint)">${g.length}</span></div><div class="list" role="listbox" aria-label="${URG[u].label}">${g.map((i) => rowHTML(i, n++ === idx)).join('')}</div></section>`;
    }
  }
  $('#list').innerHTML = html;
  document.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
}

function renderUpdated() {
  const el = $('#updated');
  if (st.refreshing) { el.textContent = `Refreshing ${st.sources.length || ''} source${st.sources.length === 1 ? '' : 's'}…`; return; }
  const stale = st.sources.filter((s) => s.status === 'stale');
  if (stale.length) { el.textContent = `⚠ ${stale.map((s) => s.name).join(', ')} could not refresh`; return; }
  el.textContent = st.refreshedAt ? `Updated ${relTime(st.refreshedAt)}` : '';
}

// ---------------------------------------------------------------------------
// Data

function applyData(data) {
  st.items = data.items;
  st.sources = data.sources;
  st.refreshedAt = data.refreshedAt;
  st.loaded = true;
}

async function load({ quiet = false } = {}) {
  try {
    const [data, hist] = await Promise.all([api.items(), api.history(14).catch(() => null)]);
    if (hist) st.history = hist.days;
    applyData(data);
    render();
    renderUpdated();
    // First run: the server is still scanning. Check back shortly.
    if (data.refreshing || data.sources.some((s) => s.status === 'pending')) setTimeout(() => load({ quiet: true }), 1200);
  } catch (err) {
    if (!quiet) toast(`⚠ ${esc(err.message)}`);
  }
}

async function refresh() {
  if (st.refreshing) return;
  st.refreshing = true;
  const icon = $('#refresh span');
  icon.classList.add('spin');
  renderUpdated();
  const before = new Set(st.items.map((i) => i.id));
  try {
    const data = await api.refresh();
    applyData(data);
    const fresh = data.items.filter((i) => !before.has(i.id) && i.status === 'open');
    render();
    for (const i of fresh) document.querySelector(`.row[data-id="${CSS.escape(i.id)}"]`)?.classList.add('new');
    pollNotifications();
    const stale = data.sources.filter((s) => s.status === 'stale');
    if (stale.length) toast(`⚠ ${esc(stale[0].name)} could not refresh: ${esc(stale[0].error)}`);
    else if (fresh.length) toast(`${fresh.length} new item${fresh.length === 1 ? '' : 's'}: ${esc(fresh[0].title)}${fresh.length > 1 ? ' and more' : ''}`);
    else toast('Everything is up to date');
  } catch (err) {
    toast(`⚠ Refresh failed: ${esc(err.message)}`);
  } finally {
    st.refreshing = false;
    icon.classList.remove('spin');
    renderUpdated();
  }
}

function savePrefs(patch) {
  api.savePrefs(patch).catch((err) => toast(`⚠ Could not save preference: ${esc(err.message)}`));
}

// ---------------------------------------------------------------------------
// Triage actions (optimistic, with undo)

function toast(html, undo) {
  st.undo = undo ?? null;
  $('#toastMsg').innerHTML = html;
  $('#undoBtn').style.display = undo ? '' : 'none';
  const t = $('#toast');
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), undo ? 6000 : 4000);
}

function runUndo() {
  const fn = st.undo;
  st.undo = null;
  $('#toast').classList.remove('show');
  fn?.();
}

/** Animate a row out, move the selection to its neighbour, then re-render. */
function leave(id, change) {
  const list = ordered();
  const at = list.findIndex((x) => x.id === id);
  if (st.selId === id) st.selId = (list[at + 1] ?? list[at - 1])?.id ?? null;
  const el = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  const finish = () => { change(); render(); };
  if (el && !matchMedia('(prefers-reduced-motion: reduce)').matches) { el.classList.add('leaving'); setTimeout(finish, 260); } else finish();
}

const short = (t) => esc(t.length > 48 ? `${t.slice(0, 48)}…` : t);

function reopen(i, snapshot) {
  Object.assign(i, snapshot);
  st.selId = i.id;
  render();
  api.restore(i.id).catch((err) => toast(`⚠ Undo failed: ${esc(err.message)}`));
}

function markDone(i) {
  if (!i || i.status === 'done') return;
  const prev = { status: i.status, doneAt: i.doneAt, snoozedUntil: i.snoozedUntil };
  closeDrawer();
  leave(i.id, () => { i.status = 'done'; i.doneAt = new Date().toISOString(); });
  api.done(i.id).catch((err) => { Object.assign(i, prev); render(); toast(`⚠ ${esc(err.message)}`); });
  toast(`✓ Done: ${short(i.title)}`, () => reopen(i, { status: 'open', doneAt: undefined }));
}

function snooze(i, choice) {
  if (!i) return;
  const prev = { status: i.status, snoozedUntil: i.snoozedUntil, snoozedAt: i.snoozedAt };
  closeSnooze();
  closeDrawer();
  leave(i.id, () => { i.status = 'snoozed'; i.snoozedUntil = choice.until; i.snoozedAt = new Date().toISOString(); });
  api.snooze(i.id, choice.until).catch((err) => { Object.assign(i, prev); render(); toast(`⚠ ${esc(err.message)}`); });
  const when = choice.until === 'change' ? 'it changes' : whenLabel(choice.until);
  toast(`☾ Snoozed until ${esc(when)}`, () => reopen(i, { status: 'open', snoozedUntil: undefined }));
}

function restore(i) {
  if (!i) return;
  const prev = { status: i.status, doneAt: i.doneAt, snoozedUntil: i.snoozedUntil, snoozedAt: i.snoozedAt };
  leave(i.id, () => { i.status = 'open'; });
  api.restore(i.id).catch((err) => { Object.assign(i, prev); render(); toast(`⚠ ${esc(err.message)}`); });
  toast('↩ Back in your inbox');
}

async function copy(text, what) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(`📋 Copied ${what}: <code>${esc(text.length > 60 ? `${text.slice(0, 60)}…` : text)}</code>`);
}

function openLink(i) {
  if (i?.url) window.open(i.url, '_blank', 'noopener');
  else if (i) toast('This item has no web link. Press <kbd>c</kbd> to copy its command instead.');
}

// ---------------------------------------------------------------------------
// Details drawer

function openDrawer(i) {
  if (!i) return;
  const s = srcInfo(i.source);
  const srcName = st.sources.find((x) => x.id === i.source)?.name ?? i.source;
  const fields = Object.entries(i.meta?.fields ?? {});
  const host = i.url ? new URL(i.url).hostname.replace(/^www\./, '') : null;
  const parked = i.status !== 'open';
  const statusBox = i.status === 'done'
    ? `<div class="why-box" style="--u:var(--ok)"><div class="lbl">Done</div>Marked done ${esc(relTime(i.doneAt))}. It comes back if it changes.</div>`
    : i.status === 'snoozed'
      ? `<div class="why-box" style="--u:var(--later)"><div class="lbl">Snoozed</div>${i.snoozedUntil === 'change' ? 'Until it changes.' : `Until ${esc(whenLabel(i.snoozedUntil))}.`}</div>`
      : '';
  const future = Date.parse(i.updatedAt) > Date.now();
  $('#drawer').innerHTML = `<header><div class="badge ${s.cls ?? ''}" style="--c:${s.c}">${s.short}</div><div><div style="font-weight:600">${esc(srcName)}</div><div style="font-size:12px;color:var(--muted)">${URG[i.urgency].label} · ${future ? `starts ${esc(whenLabel(i.updatedAt))}` : `last activity ${esc(relTime(i.updatedAt))}`}</div></div><button class="icon-btn" style="margin-left:auto" data-close-drawer aria-label="Close details">✕</button></header>
  <div class="body"><h2>${esc(i.title)}</h2>
  ${statusBox}
  <div class="why-box" style="--u:${URG[i.urgency].c}"><div class="lbl">Why it's here</div>${whyHTML(i.why)}${i.meta?.rule ? `<div class="rule">Rule: ${esc(i.meta.rule.text)}</div>` : ''}</div>
  ${i.meta?.command ? `<div class="cmd"><div class="lbl">Suggested next step</div><div class="line"><code>${esc(i.meta.command)}</code><button class="btn small" data-copy="command">Copy <kbd>c</kbd></button></div></div>` : ''}
  ${fields.length ? `<dl class="kv">${fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
  ${i.stale ? `<div class="why-box" style="--u:var(--warn)"><div class="lbl">Stale data</div>${esc(srcName)} could not refresh. Showing what it found ${esc(relTime(i.stale.since))}.<br><small>${esc(i.stale.error)}</small><div class="row-btns" style="margin-top:8px"><button class="btn small" data-retry="${esc(i.source)}">↻ Retry now</button><button class="btn small" data-setup>Fix in setup →</button></div></div>` : ''}
  </div>
  <footer>${host ? `<a class="btn primary" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">Open on ${esc(host)} ↗</a>` : ''}
  ${i.meta?.path ? `<button class="btn ${host ? '' : 'primary'}" data-copy="path">Copy path</button>` : ''}
  ${parked ? '<button class="btn" data-d="restore">↩ Restore</button>' : '<button class="btn" data-d="done">Done <kbd>x</kbd></button><button class="btn" data-d="snooze">Snooze <kbd>s</kbd></button>'}</footer>`;
  $('#drawer').classList.add('open');
  $('#drawer').dataset.id = i.id;
}
function closeDrawer() { $('#drawer').classList.remove('open'); }
const drawerOpen = () => $('#drawer').classList.contains('open');
const drawerItem = () => byId($('#drawer').dataset.id);

// ---------------------------------------------------------------------------
// Snooze popover

let choices = [];
function openSnooze(i, anchor) {
  if (!i || i.status !== 'open') return;
  choices = snoozeChoices();
  const sn = $('#snooze');
  sn.dataset.id = i.id;
  sn.innerHTML = `<div class="lbl" style="padding:6px 10px 2px">Snooze until</div>${choices.map((c, n) => `<button data-sn="${n}" role="menuitem"><kbd>${n + 1}</kbd>${c.label}<small>${esc(c.hint)}</small></button>`).join('')}`;
  const r = (anchor ?? document.querySelector('.row.sel') ?? document.body).getBoundingClientRect();
  sn.style.top = `${Math.min(r.bottom + 6, innerHeight - 220)}px`;
  sn.style.left = `${Math.max(12, Math.min(r.right - 240, innerWidth - 252))}px`;
  sn.classList.add('open');
}
function closeSnooze() { $('#snooze').classList.remove('open'); }
const snoozeOpen = () => $('#snooze').classList.contains('open');

// ---------------------------------------------------------------------------
// Views, sources, overlays

function setView(v) { st.view = v; st.selId = null; closeDrawer(); render(); }

function setHidden(next) {
  st.hidden = new Set(next);
  savePrefs({ hiddenSources: [...st.hidden] });
  render();
}

function openOverlay(sel) { closeAll(); $(sel).classList.add('open'); }
function closeAll() {
  st.wizard = null;
  document.activeElement?.blur?.();
  document.querySelectorAll('.scrim.open').forEach((s) => s.classList.remove('open'));
  closeSnooze();
  closeAppear();
  closeNotifyPanel();
}
const overlay = () => document.querySelector('.scrim.open');

const appearOpen = () => $('#appear').classList.contains('open');
function renderAppear() { $('#appear').innerHTML = appearanceHTML(); }
function openAppear() { closeAll(); renderAppear(); $('#appear').classList.add('open'); }
function closeAppear() { $('#appear').classList.remove('open'); }

// ---------------------------------------------------------------------------
// Command palette

let pSel = 0;
let pItems = [];
function commands() {
  const sel = current();
  return [
    { sec: 'Go to' },
    { label: 'Go to Overview', k: '0', run: () => setView('overview') },
    ...VIEWS.map(([v, l], n) => ({ label: `Go to ${l}`, k: String(n + 1), run: () => setView(v) })),
    { sec: 'Actions' },
    { label: 'Refresh all sources', k: 'r', run: refresh },
    ...(sel?.meta?.command ? [{ label: `Copy next step: ${sel.meta.command}`, k: 'c', run: () => copy(sel.meta.command, 'command') }] : []),
    { label: 'Toggle dark / light', k: 't', run: () => toggleTheme() },
    { label: 'Appearance…', run: openAppear },
    { label: 'Notifications…', run: () => toggleNotifyPanel() },
    { label: 'Ask Birddog…', k: 'a', run: () => toggleChat() },
    ...Object.entries(PALETTE_NAMES).map(([p, n]) => ({ label: `Theme: ${n}`, run: () => setPalette(p) })),
    { label: 'Mode: follow system', run: () => setMode('system') },
    { label: 'Connect a source…', run: () => openSetup() },
    { label: 'Run the setup wizard', run: openWizard },
    ...st.sources.filter((s) => s.status === 'stale').map((s) => ({ label: `Retry ${s.name}`, run: () => retrySource(s.id) })),
    { label: 'Keyboard shortcuts', k: '?', run: () => openOverlay('#helpScrim') },
    ...(st.me?.authEnabled ? [{ label: `Sign out (${st.me.user?.email ?? ''})`, run: signOut }] : []),
    { sec: 'Filter by source' },
    ...st.sources.map((s) => ({ label: `Only show ${s.name}`, run: () => setHidden(st.sources.filter((x) => x.id !== s.id).map((x) => x.id)) })),
    { label: 'Show all sources', run: () => setHidden([]) },
  ];
}

function renderPalette() {
  const q = $('#pInput').value.trim();
  const ql = q.toLowerCase();
  let list = commands().filter((c) => (c.sec ? !q : c.label.toLowerCase().includes(ql)));
  if (q) {
    const hits = st.items.filter((i) => i.status === 'open' && matches(i, q)).slice(0, 6);
    if (hits.length) {
      list = [{ sec: 'Items' }, ...hits.map((i) => {
        const s = srcInfo(i.source);
        return {
          html: `<span class="badge ${s.cls ?? ''}" style="--c:${s.c};width:20px;height:20px;font-size:10px;border-radius:6px">${s.short}</span><span class="lab">${esc(i.title)}</span>`,
          run: () => { st.view = 'all'; st.query = ''; st.selId = i.id; render(); openDrawer(i); },
        };
      }), ...list];
    }
    list.push({ label: `Filter inbox by “${q}”`, k: '↵', run: () => { st.query = q; st.view = 'all'; st.selId = null; render(); } });
  }
  pItems = list.filter((c) => !c.sec);
  pSel = Math.max(0, Math.min(pSel, pItems.length - 1));
  let n = 0;
  $('#pList').innerHTML = list.map((c) => (c.sec
    ? `<li class="sec">${c.sec}</li>`
    : `<li class="${n === pSel ? 'sel' : ''}" data-p="${n++}" role="option">${c.html ?? `<span class="lab">${esc(c.label)}</span>`}${c.k ? `<kbd class="k">${esc(c.k)}</kbd>` : ''}</li>`)).join('')
    || '<li class="sec">No matches</li>';
  document.querySelector('#pList li.sel')?.scrollIntoView({ block: 'nearest' });
}
function openPalette(prefill = '') {
  openOverlay('#paletteScrim');
  $('#pInput').value = prefill;
  pSel = 0;
  renderPalette();
  $('#pInput').focus();
}
function runP(n) { const c = pItems[n]; closeAll(); c?.run(); }

// ---------------------------------------------------------------------------
// Setup wizard

// Each source gets its own card. They share the header, the status label and the message line.
function cardTop(id, nameText, state, cls = '', wide = true) {
  const info = srcInfo(id);
  return `<div class="card ${wide ? 'wide' : ''} ${cls}"><div class="top"><div class="badge ${info.cls ?? ''}" style="--c:${info.c}">${info.short}</div><span class="name">${esc(nameText)}</span><span class="state">${state}</span></div>`;
}

function cardState(src, ui) {
  const status = src.status?.status ?? 'pending';
  return {
    status,
    cls: ui.busy ? '' : status === 'stale' && !ui.msgGood ? 'err' : status === 'ok' ? 'ok' : '',
    label: ui.busy ? 'Working…' : status === 'ok' ? '✓ Connected' : status === 'stale' ? 'Needs attention' : 'Checking…',
    msg: ui.msg
      ? `<div class="msg ${ui.msgGood ? 'good' : 'bad'}">${esc(ui.msg)}</div>`
      : status === 'stale' ? `<div class="msg bad">${esc(src.status.error)}</div>` : '',
    summary: src.status?.summary ? ` · ${esc(src.status.summary)}` : '',
  };
}

function gitCardHTML(src) {
  const ui = st.cards[src.id] ?? {};
  const { status, cls, label, msg, summary } = cardState(src, ui);
  const roots = src.settings?.roots ?? [];
  const editing = ui.editing || status === 'stale';
  const body = editing
    ? `${st.setup?.container ? '<div class="msg">In Docker these are paths inside the container. Mount your code read-only, e.g. <code>-v ~/code:/repos:ro</code>, and scan <code>/repos</code>.</div>' : ''}<label for="in-${src.id}">Folders to scan, one per line</label><textarea id="in-${src.id}" data-in="${src.id}" spellcheck="false">${esc(ui.draft ?? roots.join('\n'))}</textarea>${msg}
       <div class="row-btns"><button class="btn primary" data-save="${src.id}" ${ui.busy ? 'disabled' : ''}>Save &amp; scan <kbd>⌘↵</kbd></button><button class="btn" data-test="${src.id}" ${ui.busy ? 'disabled' : ''}>Test</button>${status === 'ok' ? `<button class="btn" data-cancel="${src.id}">Cancel</button>` : ''}</div>`
    : `<div class="msg">Scanning <b>${esc(roots.join(', ') || 'nothing')}</b>${summary}</div>${msg}
       <div class="row-btns"><button class="btn" data-edit="${src.id}">Change folders</button><button class="btn" data-test="${src.id}" ${ui.busy ? 'disabled' : ''}>Test again</button></div>`;
  return `${cardTop(src.id, src.name, label, cls)}<div class="msg">${esc(src.description)}</div>${body}</div>`;
}

/** In Docker, secrets come from environment variables. Returns { variable, from } for a secret, or null outside Docker. */
const envSecret = (name) => st.setup?.secretsFrom?.[name] ?? null;
function envSecretHTML(name, label) {
  const e = envSecret(name);
  if (!e) return '';
  return e.from
    ? `<div class="msg good">✓ ${esc(label)} comes from <code>${esc(e.from)}</code>. Birddog never stores it.</div>`
    : `<div class="msg">${esc(label)}: set <code>${esc(e.variable)}</code> (or <code>${esc(e.variable)}_FILE</code> for a Docker secret) in the container's environment and restart it.</div>`;
}

/** GitHub: the sign-in card. Signing in is all the setup there is. */
function githubCardHTML(src) {
  const conn = st.setup.connections?.github ?? {};
  const ui = st.cards.github ?? {};
  const dev = conn.device;
  if (envSecret('github-token') && !conn.connected) {
    return `${cardTop('github', src.name, 'Not signed in')}<div class="msg">${esc(src.description)}</div>
      ${envSecretHTML('github-token', 'The GitHub token')}
      <div class="msg">Use a token that can read your repos and notifications, e.g. the output of <code>gh auth token</code> on your machine. Fine-grained tokens work too, but cannot read mentions.</div></div>`;
  }
  if (conn.connected) {
    const { cls, label, msg, summary } = cardState(src, ui);
    const how = conn.method === 'gh-cli' ? 'using your <code>gh</code> login (Birddog stores no token)'
      : conn.method === 'env' ? `using <code>${esc(conn.tokenFrom?.from ?? 'GITHUB_TOKEN')}</code> (Birddog stores no token)`
        : `token kept in ${esc(st.setup.secretStore)}`;
    return `${cardTop('github', src.name, label, cls)}<div class="msg">${esc(src.description)}</div>
      <div class="msg">Signed in as <b>@${esc(conn.login)}</b>, ${how}${summary.replace(/^ · @[^ ]+/, '')}</div>${msg}
      <div class="row-btns"><button class="btn" data-test="github" ${ui.busy ? 'disabled' : ''}>Test again</button>${conn.method === 'env' ? '' : `<button class="btn" data-gh="disconnect" ${ui.busy ? 'disabled' : ''}>Disconnect</button>`}</div></div>`;
  }
  if (dev?.status === 'waiting') {
    return `${cardTop('github', src.name, 'Waiting for GitHub…')}<div class="msg">Enter this code on GitHub:</div><div class="code">${esc(dev.userCode)}</div>
      <div class="row-btns"><button class="btn primary" data-gh="open">Copy code &amp; open GitHub ↗</button><button class="btn" data-gh="disconnect">Cancel</button></div>
      <div class="msg">This card updates by itself once you approve.</div></div>`;
  }
  const err = ui.msg ?? (dev && dev.status !== 'done' ? dev.error : null);
  const device = conn.deviceFlowAvailable;
  return `${cardTop('github', src.name, ui.busy ? 'Working…' : 'Not signed in', err ? 'err' : '')}<div class="msg">${esc(src.description)}</div>
    ${err ? `<div class="msg bad">${esc(err)}</div>` : ''}
    <div class="row-btns">${device ? `<button class="btn primary" data-gh="device" ${ui.busy ? 'disabled' : ''}>Sign in with GitHub</button>` : ''}<button class="btn ${device ? '' : 'primary'}" data-gh="cli" ${ui.busy ? 'disabled' : ''}>Use my gh CLI login</button></div>
    ${device ? '' : '<div class="msg">Prefer signing in through the browser? Add an OAuth App client ID as <code>sources.github.clientId</code> (see README).</div>'}</div>`;
}

const JIRA_TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** Jira: site, email and an API token. The token goes to the keychain, never config.json. */
function jiraCardHTML(src) {
  const ui = st.cards.jira ?? {};
  const s = src.settings ?? {};
  const hasToken = !!src.secrets?.token;
  const connected = src.enabled && s.site && hasToken;
  const { status, cls, label, msg, summary } = cardState(src, ui);
  if (connected && !ui.editing && status !== 'stale') {
    return `${cardTop('jira', src.name, label, cls)}<div class="msg">${esc(src.description)}</div>
      <div class="msg">Signed in to <b>${esc(new URL(s.site).host)}</b> as <b>${esc(s.email)}</b>, ${envSecret('jira-token') ? `token from <code>${esc(envSecret('jira-token').from)}</code>` : `token kept in ${esc(st.setup.secretStore)}`}${summary.replace(/^ · [^ ]+/, '')}</div>${msg}
      <div class="row-btns"><button class="btn" data-edit="jira">Change</button><button class="btn" data-test="jira" ${ui.busy ? 'disabled' : ''}>Test again</button><button class="btn" data-disconnect="jira" ${ui.busy ? 'disabled' : ''}>Disconnect</button></div></div>`;
  }
  const d = ui.draft ?? { site: s.site ? new URL(s.site).host : '', email: s.email ?? '', token: '' };
  const state = connected ? label : ui.busy ? 'Working…' : 'Not connected';
  const stateCls = connected ? cls : ui.msg && !ui.msgGood ? 'err' : '';
  const off = ui.busy ? 'disabled' : '';
  return `${cardTop('jira', src.name, state, stateCls)}<div class="msg">${esc(src.description)}</div>
    <div class="fields">
      <label><span>Site</span><input data-f="jira.site" value="${esc(d.site)}" placeholder="acme.atlassian.net" autocomplete="off" spellcheck="false"></label>
      <label><span>Email</span><input data-f="jira.email" type="email" value="${esc(d.email)}" placeholder="you@acme.com" autocomplete="off" spellcheck="false"></label>
      ${envSecret('jira-token') ? '' : `<label class="full"><span>API token · <a href="${JIRA_TOKEN_URL}" target="_blank" rel="noopener noreferrer">create one on Atlassian ↗</a></span><input data-f="jira.token" type="password" value="${esc(d.token)}" placeholder="${hasToken ? `Saved in ${esc(st.setup.secretStore)} · leave blank to keep it` : 'Paste your API token'}" autocomplete="off"></label>`}
    </div>
    ${envSecret('jira-token') ? envSecretHTML('jira-token', 'The API token') : `<div class="msg">The token is stored in ${esc(st.setup.secretStore)}, never in config.json. Birddog only reads from Jira.</div>`}${msg}
    <div class="row-btns"><button class="btn primary" data-connect="jira" ${off}>Test &amp; connect <kbd>↵</kbd></button>${connected ? '<button class="btn" data-cancel="jira">Cancel</button>' : ''}${hasToken ? `<button class="btn" data-disconnect="jira" ${off}>Disconnect</button>` : ''}</div></div>`;
}


let ghTimer = null;
function watchGithub() {
  clearTimeout(ghTimer);
  ghTimer = setTimeout(async () => {
    if (!$('#setupScrim').classList.contains('open')) return;
    try {
      const conn = await api.github();
      st.setup.connections.github = conn;
      renderCards();
      if (conn.device?.status === 'waiting') watchGithub();
      else if (conn.connected) { toast(`✓ Signed in to GitHub as @${esc(conn.login)}`); rescan('github'); }
    } catch { watchGithub(); }
  }, 2000);
}

/** Re-run the sources, then redraw both the inbox and setup. */
async function rescan(id) {
  if (id) { st.cards[id] = { ...st.cards[id], busy: true, msg: 'Looking for items…', msgGood: true }; renderCards(); }
  try {
    applyData(await api.refresh());
    render();
    renderUpdated();
    st.setup = await api.setup();
  } catch (err) {
    if (id) st.cards[id] = { msg: err.message, msgGood: false };
  }
  if (id && st.cards[id]?.busy) st.cards[id] = {};
  renderCards();
}

async function githubAction(action) {
  const conn = st.setup.connections.github;
  if (action === 'open') {
    const uri = conn.device?.verificationUri;
    copy(conn.device?.userCode, 'code');
    if (/^https:\/\//.test(uri ?? '')) window.open(uri, '_blank', 'noopener');
    return;
  }
  st.cards.github = { busy: true };
  renderCards();
  try {
    if (action === 'device') { await api.githubDevice(); st.setup.connections.github = await api.github(); watchGithub(); }
    if (action === 'cli') {
      st.setup.connections.github = await api.githubCli();
      toast(`✓ Signed in to GitHub as @${esc(st.setup.connections.github.login)}`);
    }
    if (action === 'disconnect') st.setup.connections.github = await api.githubDisconnect();
    st.cards.github = {};
  } catch (err) {
    st.cards.github = { msg: err.message };
    return renderCards();
  }
  if (action === 'device') return renderCards();
  return rescan('github');
}

/** Calendar: an iCal link (a secret, kept in the keychain) and/or a local .ics file. */
function calCardHTML(src) {
  const ui = st.cards.cal ?? {};
  const s = src.settings ?? {};
  const hasUrl = !!src.secrets?.url;
  const connected = src.enabled && (hasUrl || !!s.file);
  const { status, cls, label, msg, summary } = cardState(src, ui);
  const store = esc(st.setup.secretStore);
  if (connected && !ui.editing && status !== 'stale') {
    const what = [hasUrl && (envSecret('cal-url') ? `the iCal link from <code>${esc(envSecret('cal-url').from)}</code>` : `an iCal link kept in ${store}`), s.file && `<b>${esc(s.file)}</b>`].filter(Boolean).join(' and ');
    return `${cardTop('cal', src.name, label, cls)}<div class="msg">${esc(src.description)}</div>
      <div class="msg">Reading ${what}${summary.replace(/^ · [^·]+/, '')}</div>${msg}
      <div class="row-btns"><button class="btn" data-edit="cal">Change</button><button class="btn" data-test="cal" ${ui.busy ? 'disabled' : ''}>Test again</button><button class="btn" data-disconnect="cal" ${ui.busy ? 'disabled' : ''}>Disconnect</button></div></div>`;
  }
  const d = ui.draft ?? { url: '', file: s.file ?? '', email: s.email ?? '' };
  const off = ui.busy ? 'disabled' : '';
  const state = connected ? label : ui.busy ? 'Working…' : 'Not connected';
  return `${cardTop('cal', src.name, state, connected ? cls : ui.msg && !ui.msgGood ? 'err' : '')}<div class="msg">${esc(src.description)}</div>
    <div class="fields">
      ${envSecret('cal-url') ? '' : `<label class="full"><span>iCal link</span><input data-f="cal.url" type="password" value="${esc(d.url)}" placeholder="${hasUrl ? `Saved in ${store} · leave blank to keep it` : 'https://calendar.google.com/calendar/ical/…/basic.ics'}" autocomplete="off" spellcheck="false"></label>`}
      <label><span>…or a local .ics file</span><input data-f="cal.file" value="${esc(d.file)}" placeholder="~/Downloads/work.ics" autocomplete="off" spellcheck="false"></label>
      <label><span>Your email <i>(optional)</i></span><input data-f="cal.email" type="email" value="${esc(d.email)}" placeholder="hides meetings you declined" autocomplete="off" spellcheck="false"></label>
    </div>
    <details class="help"><summary>Where do I find my iCal link?</summary>
      <ul><li><b>Google Calendar:</b> Settings → your calendar → Integrate calendar → <i>Secret address in iCal format</i>.</li>
      <li><b>Outlook / Microsoft 365:</b> Settings → Calendar → Shared calendars → Publish a calendar → copy the <i>ICS</i> link.</li>
      <li><b>iCloud:</b> Calendar → share a calendar → <i>Public Calendar</i> → copy the link (<code>webcal://</code> is fine).</li></ul></details>
    ${envSecret('cal-url') ? `${envSecretHTML('cal-url', 'The iCal link')}<div class="msg">A file path here means a path inside the container: mount the file read-only, e.g. <code>-v ~/work.ics:/data/work.ics:ro</code>.</div>` : `<div class="msg">The link works like a password, so it is stored in ${store}, never in config.json. Birddog only reads the calendar.</div>`}${msg}
    <div class="row-btns"><button class="btn primary" data-connect="cal" ${off}>Test &amp; connect <kbd>↵</kbd></button>${connected ? '<button class="btn" data-cancel="cal">Cancel</button>' : ''}${hasUrl || (src.enabled && s.file) ? `<button class="btn" data-disconnect="cal" ${off}>Disconnect</button>` : ''}</div></div>`;
}

/** A source someone switched off (git or GitHub; Jira and Calendar are off until connected). */
function offCardHTML(src) {
  return `${cardTop(src.id, src.name, 'Off')}<div class="msg">${esc(src.description)}</div>
    <div class="msg">Turned off. Birddog is not checking ${esc(src.name)}.</div>
    <div class="row-btns"><button class="btn primary" data-enable="${esc(src.id)}">Turn on</button></div></div>`;
}

const CARDS = { git: gitCardHTML, github: githubCardHTML, jira: jiraCardHTML, cal: calCardHTML };
const cardFor = (src) => (src.enabled === false && (src.id === 'git' || src.id === 'github') ? offCardHTML(src) : (CARDS[src.id] ?? gitCardHTML)(src));

// ---------------------------------------------------------------------------
// First-run wizard: one source per step, each tested live as you reach it.

const WIZARD = [
  { id: 'welcome', title: 'Welcome to Birddog 🐾', intro: 'Birddog looks through your work and points at what needs you next. Connect the places your work lives; each one is tested as soon as you reach it. Skip anything you don’t use. You can change all of it later from <b>Connect a source</b>.' },
  { id: 'git', title: 'Your local repos', intro: 'Which folders hold your code? Birddog finds uncommitted work, unpushed commits and branches to tidy. It never changes your repos.',
    dockerIntro: 'Birddog sees the folders you mounted into the container, read-only (usually <code>/repos</code>). It finds uncommitted work, unpushed commits and branches to tidy, and never changes them.' },
  { id: 'github', title: 'GitHub', intro: 'Review requests, your PRs that need work, mentions and assigned issues. The quickest way in is your existing <code>gh</code> login.',
    dockerIntro: 'Review requests, your PRs that need work, mentions and assigned issues. In Docker, Birddog uses the token you pass as <code>GITHUB_TOKEN</code>.' },
  { id: 'jira', title: 'Jira Cloud', intro: 'The tickets assigned to you, ranked by due date, sprint end, blockers and priority. You need your site, your email and an API token.',
    dockerIntro: 'The tickets assigned to you, ranked by due date, sprint end, blockers and priority. Enter your site and email here; the API token comes from <code>BIRDDOG_JIRA_TOKEN</code>.' },
  { id: 'cal', title: 'Calendar', intro: 'Your next meetings, so a 10:00 standup never sneaks up on you. Paste an iCal link from Google, Outlook or iCloud, or pick an .ics file.',
    dockerIntro: 'Your next meetings, so a 10:00 standup never sneaks up on you. The private iCal link comes from <code>BIRDDOG_CAL_URL</code>; set <code>TZ</code> so times show in your zone.' },
  { id: 'done', title: 'You’re all set', intro: 'Here’s what Birddog is watching. Press <kbd>r</kbd> any time to refresh, or <kbd>⌘K</kbd> → “Run the setup wizard” to come back here.' },
];
const SOURCE_STEPS = WIZARD.filter((w) => w.id !== 'welcome' && w.id !== 'done').length;

function isConnected(src) {
  if (!src || src.enabled === false) return false;
  if (src.id === 'github') return !!st.setup.connections?.github?.connected;
  if (src.id === 'jira') return !!(src.settings?.site && src.secrets?.token);
  if (src.id === 'cal') return !!(src.secrets?.url || src.settings?.file);
  return src.status?.status === 'ok' || src.status?.status === 'pending';
}

function stateOf(src) {
  if (!src || src.enabled === false) return { icon: '–', cls: '', text: 'Skipped' };
  if (src.status?.status === 'stale') return { icon: '⚠', cls: 'warn', text: src.status.error };
  if (isConnected(src)) return { icon: '✓', cls: 'ok', text: src.status?.summary ?? 'Connected' };
  return { icon: '–', cls: '', text: 'Not connected' };
}

function wizardHTML() {
  const step = WIZARD[st.wizard.step];
  const n = st.wizard.step; // 1..SOURCE_STEPS for source steps
  const dots = WIZARD.map((w, i) => `<span class="dot ${i === n ? 'on' : i < n ? 'past' : ''}" title="${esc(w.title)}"></span>`).join('');
  const intro = st.setup?.container && step.dockerIntro ? step.dockerIntro : step.intro;
  $('#setupHead').innerHTML = `<div class="wiz-dots" aria-hidden="true">${dots}</div><h2 id="setupTitle">${step.title}</h2><p>${intro}</p>`;
  const warn = st.setup?.secretWarning ? `<div class="card wide warnbox"><div class="msg">⚠ ${esc(st.setup.secretWarning)}</div></div>` : '';
  let body;
  if (!st.setup) body = '<div class="card wide"><div class="msg">Loading…</div></div>';
  else if (step.id === 'welcome') {
    const docker = st.setup.container ? `<div class="card wide warnbox"><div class="msg">🐳 <b>Running in Docker.</b> Tokens come from environment variables or Docker secrets (<code>GITHUB_TOKEN</code>, <code>BIRDDOG_JIRA_TOKEN</code>, <code>BIRDDOG_CAL_URL</code>, or their <code>_FILE</code> versions), never from this screen, and Birddog never writes them to disk. Your code is read from <code>/repos</code>; mount it read-only.</div></div>` : '';
    body = `${warn}${docker}<div class="card wide wiz-list">${st.setup.sources.map((src) => `<div class="wiz-row"><div class="badge ${srcInfo(src.id).cls ?? ''}" style="--c:${srcInfo(src.id).c}">${srcInfo(src.id).short}</div><div><b>${esc(src.name)}</b><div class="msg">${esc(src.description)}</div></div></div>`).join('')}</div>`;
  } else if (step.id === 'done') {
    body = `<div class="card wide wiz-list">${st.setup.sources.map((src) => {
      const s = stateOf(src);
      return `<div class="wiz-row"><div class="badge ${srcInfo(src.id).cls ?? ''}" style="--c:${srcInfo(src.id).c}">${srcInfo(src.id).short}</div><div style="min-width:0"><b>${esc(src.name)}</b><div class="msg ${s.cls === 'warn' ? 'bad' : ''}">${esc(s.text)}</div></div><span class="wiz-state ${s.cls}">${s.icon}</span></div>`;
    }).join('')}</div>`;
  } else {
    const src = st.setup.sources.find((x) => x.id === step.id);
    body = src ? cardFor(src) : '';
  }
  $('#cards').innerHTML = body;
  const src = st.setup?.sources.find((x) => x.id === step.id);
  const progress = step.id === 'welcome' ? '' : step.id === 'done' ? 'Setup done' : `Step ${n} of ${SOURCE_STEPS}`;
  const next = step.id === 'welcome' ? '<button class="btn primary" data-wiz="next">Let’s go →</button>'
    : step.id === 'done' ? '<button class="btn primary" data-wiz="finish">Go to my inbox →</button>'
      : isConnected(src) ? '<button class="btn primary" data-wiz="next">Next →</button>'
        : '<button class="btn" data-wiz="skip">Skip</button>';
  $('#setupFoot').innerHTML = `<span class="progress">${progress}</span><span style="flex:1"></span>${n > 0 ? '<button class="btn" data-wiz="back">← Back</button>' : '<button class="btn" data-wiz="finish">Skip setup</button>'}${next}`;
}

/** Run a source's test() as soon as its step opens, so you see right away whether it works. */
function autoTest(id) {
  const src = st.setup?.sources.find((x) => x.id === id);
  if (!src) return;
  if (id === 'git' || (isConnected(src) && src.enabled !== false)) testCard(id);
}

async function wizardAction(action) {
  const step = WIZARD[st.wizard.step];
  if (action === 'finish') { st.wizard = null; closeAll(); return load(); }
  if (action === 'skip' && step.id === 'github') {
    // Not using GitHub: switch it off so it doesn't sit in the sidebar as "stale".
    const src = st.setup.sources.find((x) => x.id === 'github');
    if (src?.enabled !== false) { try { st.setup = await api.enableSource('github', false); } catch { /* keep going */ } }
  }
  st.wizard.step = Math.max(0, Math.min(WIZARD.length - 1, st.wizard.step + (action === 'back' ? -1 : 1)));
  st.cards = {};
  if (WIZARD[st.wizard.step].id === 'done') { try { st.setup = await api.setup(); } catch { /* show what we have */ } }
  renderCards();
  autoTest(WIZARD[st.wizard.step].id);
}

function settingsChrome() {
  $('#setupHead').innerHTML = '<h2 id="setupTitle">Connect your sources</h2><p>Everything stays on this machine. Birddog only reads: it never changes your repos, PRs, tickets or calendar.</p>';
  const s = st.setup;
  const ok = s ? s.sources.filter((x) => x.status?.status === 'ok').length : 0;
  const on = s ? s.sources.filter((x) => x.enabled !== false).length : 0;
  $('#setupFoot').innerHTML = `<span class="progress" id="setupProgress">${s ? `${ok} of ${on} switched-on sources working` : ''}</span><span style="flex:1"></span><button class="btn" data-wiz="start">Run the setup wizard</button><button class="btn primary" data-close>Go to my inbox →</button>`;
}

function renderCards() {
  if (st.wizard) return wizardHTML();
  settingsChrome();
  const s = st.setup;
  if (!s) { $('#cards').innerHTML = '<div class="card wide"><div class="msg">Loading…</div></div>'; return; }
  const warn = s.secretWarning ? `<div class="card wide warnbox"><div class="msg">⚠ ${esc(s.secretWarning)}</div></div>` : '';
  const soon = s.comingSoon.map((c) => `${cardTop(c.id, c.name, 'Coming soon', 'soon', false)}<div class="msg">${esc(c.description)}</div></div>`);
  $('#cards').innerHTML = warn + s.sources.map(cardFor).join('') + soon.join('');
}

async function openSetup({ wizard = false } = {}) {
  openOverlay('#setupScrim');
  st.cards = {};
  st.wizard = wizard ? { step: 0 } : null;
  renderCards();
  try {
    st.setup = await api.setup();
    renderCards();
  } catch (err) {
    $('#cards').innerHTML = `<div class="card wide err"><div class="msg">${esc(err.message)}</div></div>`;
  }
  savePrefs({ seenSetup: true });
}
const openWizard = () => openSetup({ wizard: true });

async function enableAction(id) {
  st.cards[id] = { busy: true };
  renderCards();
  try {
    st.setup = await api.enableSource(id, true);
    st.cards[id] = {};
    await load();
  } catch (err) {
    st.cards[id] = { msg: err.message, msgGood: false };
  }
  renderCards();
}

/** What a card's form says right now (drafts survive re-renders). */
function formOf(id) {
  if (id === 'git') {
    const ta = document.querySelector('[data-in="git"]');
    return { roots: ta ? ta.value : (st.setup.sources.find((x) => x.id === id)?.settings?.roots ?? []).join('\n') };
  }
  const inputs = [...document.querySelectorAll(`[data-f^="${CSS.escape(id)}."]`)];
  if (!inputs.length) return {};
  return Object.fromEntries(inputs.map((el) => [el.dataset.f.slice(id.length + 1), el.value]));
}
const draftOf = (id, form) => (id === 'git' ? form.roots : Object.keys(form).length ? form : undefined);

async function testCard(id) {
  const form = formOf(id);
  st.cards[id] = { ...st.cards[id], draft: draftOf(id, form), busy: true, msg: null };
  renderCards();
  try {
    const r = await api.testSource(id, form);
    st.cards[id] = { ...st.cards[id], busy: false, msg: r.message, msgGood: r.ok };
  } catch (err) {
    st.cards[id] = { ...st.cards[id], busy: false, msg: err.message, msgGood: false };
  }
  renderCards();
}

async function saveCard(id, form = formOf(id)) {
  const draft = draftOf(id, form);
  const editing = st.cards[id]?.editing;
  st.cards[id] = { ...st.cards[id], draft, busy: true, msg: 'Looking for items…', msgGood: true };
  renderCards();
  try {
    st.setup = await api.saveSource(id, form);
    const status = st.setup.sources.find((x) => x.id === id)?.status;
    st.cards[id] = status?.status === 'ok'
      ? { msg: `Saved. ${status.summary ?? ''}`, msgGood: true }
      : { editing: true, draft: id === 'git' ? draft : { ...draft, ...(draft && 'token' in draft ? { token: '' } : {}), ...(draft && 'url' in draft ? { url: '' } : {}) }, msg: status?.error ?? 'Saved, but the scan failed.', msgGood: false };
    renderCards();
    await load();
  } catch (err) {
    st.cards[id] = { editing: editing ?? true, draft, busy: false, msg: err.message, msgGood: false };
    renderCards();
  }
}

/** "Test & connect": try the settings first, and only save them if they work. */
async function connectCard(id) {
  const form = formOf(id);
  st.cards[id] = { ...st.cards[id], draft: draftOf(id, form), busy: true, msg: 'Testing…', msgGood: true };
  renderCards();
  let r;
  try { r = await api.testSource(id, form); } catch (err) { r = { ok: false, message: err.message }; }
  if (!r.ok) {
    st.cards[id] = { ...st.cards[id], busy: false, msg: r.message, msgGood: false };
    return renderCards();
  }
  await saveCard(id, form);
  if (st.cards[id]?.msgGood) toast(`✓ ${esc(r.message)}`);
}

async function disconnectCard(id) {
  st.cards[id] = { busy: true };
  renderCards();
  try {
    st.setup = await api.disconnectSource(id);
    const e = envSecret(id === 'jira' ? 'jira-token' : 'cal-url');
    st.cards[id] = { msg: e?.from ? `Switched off. The secret still comes from ${e.from}; remove it there.` : 'Disconnected. The token was removed.', msgGood: true };
    await load();
  } catch (err) {
    st.cards[id] = { msg: err.message, msgGood: false };
  }
  renderCards();
}

// ---------------------------------------------------------------------------
// Events

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('scrim')) { closeAll(); return; }
  const t = e.target.closest('[data-ov-item],[data-view],[data-src],[data-soon],[data-act],.row,[data-close-drawer],[data-d],[data-sn],[data-p],[data-test],[data-save],[data-edit],[data-cancel],[data-connect],[data-disconnect],[data-retry],[data-enable],[data-wiz],[data-close],[data-setup],[data-copy],[data-gh],[data-logout],#clearQ');
  if (!t) { if (snoozeOpen() && !e.target.closest('#snooze')) closeSnooze(); return; }
  const d = t.dataset;
  if (d.view) return setView(d.view);
  if (d.ovItem) { e.preventDefault(); setView('all'); const i = byId(d.ovItem); if (i) { st.selId = i.id; render(); openDrawer(i); } return; }
  if (d.src) { const next = new Set(st.hidden); next.has(d.src) ? next.delete(d.src) : next.add(d.src); return setHidden(next); }
  if (d.soon) return openSetup();
  if (t.id === 'clearQ') { st.query = ''; return render(); }
  if (d.act) {
    e.stopPropagation();
    const i = byId(t.closest('.row').dataset.id);
    if (d.act === 'done') return markDone(i);
    if (d.act === 'snooze') return openSnooze(i, t);
    return restore(i);
  }
  if (t.classList.contains('row')) { st.selId = d.id; render(); return openDrawer(byId(d.id)); }
  if ('closeDrawer' in d) return closeDrawer();
  if (d.d) {
    const i = drawerItem();
    if (d.d === 'done') return markDone(i);
    if (d.d === 'snooze') return openSnooze(i, t);
    closeDrawer(); return restore(i);
  }
  if (d.sn) return snooze(byId($('#snooze').dataset.id), choices[+d.sn]);
  if (d.p) return runP(+d.p);
  if (d.gh) return githubAction(d.gh);
  if ('logout' in d) return signOut();
  if (d.test) return testCard(d.test);
  if (d.save) return saveCard(d.save);
  if (d.connect) return connectCard(d.connect);
  if (d.retry) return retrySource(d.retry);
  if (d.enable) return enableAction(d.enable);
  if (d.wiz) return d.wiz === 'start' ? openWizard() : wizardAction(d.wiz);
  if (d.disconnect) return disconnectCard(d.disconnect);
  if (d.edit) { st.cards[d.edit] = { editing: true }; renderCards(); return document.querySelector(`[data-in="${CSS.escape(d.edit)}"],[data-f^="${CSS.escape(d.edit)}."]`)?.focus(); }
  if (d.cancel) { st.cards[d.cancel] = {}; return renderCards(); }
  if ('close' in d) return closeAll();
  if ('setup' in d) { e.preventDefault(); closeDrawer(); return openSetup(); }
  if (d.copy) { const i = drawerItem(); return copy(d.copy === 'path' ? i?.meta?.path : i?.meta?.command, d.copy); }
});

$('#openPalette').onclick = () => openPalette();
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (st.view === 'overview') renderOverview(); }, 120); });
$('#openSetup').onclick = () => openSetup();
$('#refresh').onclick = refresh;
$('#appearBtn').onclick = (e) => { e.stopPropagation(); appearOpen() ? closeAppear() : openAppear(); };
$('#chatBtn').onclick = () => toggleChat();
for (const type of ['click', 'change', 'submit', 'keydown']) $('#chatPanel').addEventListener(type, (e) => { e.stopPropagation(); onChatEvent(e); });
$('#notifyBtn').onclick = (e) => { e.stopPropagation(); closeAppear(); toggleNotifyPanel(); };
$('#notifyPanel').addEventListener('change', (e) => { onNotifyPanelEvent(e); });
$('#notifyPanel').addEventListener('click', (e) => { e.stopPropagation(); onNotifyPanelEvent(e); });
$('#undoBtn').onclick = runUndo;
$('#pInput').addEventListener('input', () => { pSel = 0; renderPalette(); });
$('#appear').onclick = (e) => {
  e.stopPropagation();
  const b = e.target.closest('[data-pal],[data-mode]');
  if (!b) return;
  if (b.dataset.pal) setPalette(b.dataset.pal); else setMode(b.dataset.mode);
};
document.addEventListener('mousedown', (e) => {
  if (appearOpen() && !e.target.closest('#appear,#appearBtn')) closeAppear();
  if (notifyPanelOpen() && !e.target.closest('#notifyPanel,#notifyBtn')) closeNotifyPanel();
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return overlay() ? closeAll() : openPalette(); }
  if (e.key === 'Escape') {
    if (appearOpen()) return closeAppear();
    if (notifyPanelOpen()) return closeNotifyPanel();
    if (chatOpen()) return closeChat();
    if (overlay() || snoozeOpen()) return closeAll();
    if (drawerOpen()) return closeDrawer();
    if (st.query) { st.query = ''; render(); }
    return;
  }
  if ($('#paletteScrim').classList.contains('open')) {
    if (e.key === 'ArrowDown') { e.preventDefault(); pSel = Math.min(pSel + 1, pItems.length - 1); renderPalette(); } else if (e.key === 'ArrowUp') { e.preventDefault(); pSel = Math.max(pSel - 1, 0); renderPalette(); } else if (e.key === 'Enter') { e.preventDefault(); runP(pSel); }
    return;
  }
  if (e.target.matches?.('textarea[data-in]') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveCard(e.target.dataset.in); return; }
  if (e.target.matches?.('input[data-f]') && e.key === 'Enter') { e.preventDefault(); connectCard(e.target.dataset.f.split('.')[0]); return; }
  if (e.target.matches?.('input,textarea,select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (overlay()) return;
  if (snoozeOpen()) {
    const n = +e.key - 1;
    if (n >= 0 && n < choices.length) snooze(byId($('#snooze').dataset.id), choices[n]);
    return;
  }
  if (st.view === 'overview' && ['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); return setView('all'); }
  const list = ordered();
  const idx = selIndex(list);
  const sel = list[idx];
  const move = (to) => { e.preventDefault(); st.selId = list[Math.max(0, Math.min(to, list.length - 1))]?.id ?? null; render(); if (drawerOpen()) openDrawer(current()); };
  switch (e.key) {
    case 'j': case 'ArrowDown': return move(idx + 1);
    case 'k': case 'ArrowUp': return move(idx - 1);
    case 'Enter': if (e.target.closest?.('button,a')) return; return openDrawer(sel);
    case 'x': return sel?.status === 'open' ? markDone(sel) : undefined;
    case 's': return openSnooze(sel);
    case 'u': return sel && sel.status !== 'open' ? restore(sel) : undefined;
    case 'z': return runUndo();
    case 'c': return sel?.meta?.command ? copy(sel.meta.command, 'command') : undefined;
    case 'o': return openLink(sel);
    case 'a': e.preventDefault(); return toggleChat();
    case 'r': return refresh();
    // No toast here: it would replace a pending "Undo" toast, and the change is visible anyway.
    case 't': toggleTheme(); return;
    case 'p': cyclePalette(); return;
    case '/': e.preventDefault(); return openPalette();
    case '?': return openOverlay('#helpScrim');
    default: {
      if (e.key === '0') return setView('overview');
      const v = VIEWS[+e.key - 1]?.[0];
      if (v) setView(v);
    }
  }
});

// ---------------------------------------------------------------------------
// Signed-in user (only when login is turned on)

function renderMe(me) {
  st.me = me;
  const el = $('#me');
  if (!me?.authEnabled || !me.user) { el.hidden = true; return; }
  const label = me.user.email ?? me.user.name ?? 'signed in';
  el.innerHTML = `<span class="avatar" aria-hidden="true">${esc(label[0].toUpperCase())}</span><span class="who" title="${esc(label)}">${esc(label)}</span><button data-logout title="Sign out">Sign out</button>`;
  el.hidden = false;
}

async function signOut() {
  try { await api.logout(); } catch { /* signing out anyway */ }
  location.assign('/auth/signed-out');
}

// ---------------------------------------------------------------------------
// Boot

/** Development only (npm run dev:watch): reload the page when the UI files or the server change. */
async function liveReload() {
  try {
    if (!(await (await fetch('/api/health')).json()).liveReload) return;
  } catch { return; }
  let opened = false;
  const es = new EventSource('/api/dev/events');
  es.addEventListener('reload', () => location.reload());
  es.onopen = () => { if (opened) location.reload(); opened = true; }; // reconnected = the server restarted
}

async function boot() {
  let prefs = {};
  try { prefs = await api.prefs(); } catch { /* use defaults */ }
  api.me().then(renderMe).catch(() => {});
  initAppearance({ prefs, save: savePrefs, changed: () => { if (appearOpen()) renderAppear(); } });
  st.hidden = new Set(prefs.hiddenSources ?? []);
  render();
  await load();
  initChat({ api, toast, onChanged: () => load({ quiet: true }) });
  initNotify({
    api, toast, prefs,
    sources: () => st.sources,
    openItem: (id) => { const i = byId(id); if (i) { st.selId = id; render(); openDrawer(i); } },
  });
  setInterval(() => { if (!st.refreshing) load({ quiet: true }); }, 60_000);
  setInterval(renderUpdated, 30_000);
  if (!prefs.seenSetup) setTimeout(openWizard, 400);
  liveReload();
}

boot();
