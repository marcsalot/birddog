// Birddog UI: inbox, details drawer, snooze, undo, command palette, setup, appearance.
// Plain ES modules, no framework. All item text is escaped before it touches the DOM.

import { api } from './api.js';
import {
  PALETTE_NAMES, appearanceHTML, cyclePalette, initAppearance, setMode, setPalette, toggleTheme,
} from './appearance.js';
import { chatOpen, closeChat, initChat, onChatEvent, toggleChat } from './chat.js';
import { closeGuide, guideOpen, guideWide, initGuide, loadShots, onGuideEvent, openGuide, toggleGuide, toggleGuideWide } from './guide.js';
import { bindOverview, overviewData, overviewHTML } from './overview.js';
import { initWork } from './work.js';
import { closeNotifyPanel, initNotify, notifyPanelOpen, onNotifyPanelEvent, poll as pollNotifications, toggleNotifyPanel } from './notify.js';
import { sourceMatches } from './source-search.js';
import { esc, plain, relTime, shortAge, shortUntil, snoozeChoices, whenLabel, whyHTML } from './format.js';

// ---------------------------------------------------------------------------
// Static display info

const SRC = {
  git: { short: '⎇', c: 'var(--git)' },
  github: { short: 'GH', c: 'var(--gh)', cls: 'gh' },
  jira: { short: 'J', c: 'var(--jira)' },
  cal: { short: '◷', c: 'var(--cal)' },
  gitlab: { short: 'GL', c: '#e2492f' },
  linear: { short: 'LN', c: '#5e6ad2' },
  azure: { short: 'AZ', c: '#0078d4' },
  sentry: { short: 'SE', c: '#6c5fc7' },
  pagerduty: { short: 'PD', c: '#06ac38' },
  slack: { short: 'SL', c: '#611f69' },
  teams: { short: 'TM', c: '#5b5fc7' },
};
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
const sourceName = (id) => st.sources?.find((x) => x.id === id)?.name ?? id;
const srcInfo = (id) => SRC[id] ?? { short: id.slice(0, 2).toUpperCase(), c: 'var(--later)' };
const URG = {
  now: { label: 'Now', c: 'var(--now)' },
  today: { label: 'Today', c: 'var(--today)' },
  later: { label: 'Later', c: 'var(--later)' },
};
const VIEWS = [['all', 'All', '◎'], ['now', 'Now'], ['today', 'Today'], ['later', 'Later'], ['snoozed', 'Snoozed', '☾'], ['done', 'Done', '✓']];
const WORK_VIEWS = [['board', 'Board', '▦', 'b'], ['worktrees', 'Worktrees & slots', '⎇', 'w']];
const isWork = (v) => WORK_VIEWS.some(([k]) => k === v);
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
  firstRun: null, // { folders, other, busy, msg } while the one-step first-run screen is open
  srcQuery: '', // the search box in Sources & settings
  only: null, // 'github' while setup shows just that card (the suggested next step)
  nextStep: null, // { github: connected? } for the next-step card; null = don't show it
};

const $ = (s) => document.querySelector(s);
const byId = (id) => st.items.find((i) => i.id === id);
// The Work views (board, worktrees & slots) draw into the same content area.
const work = initWork({ root: () => $('#list'), currentView: () => st.view, copy });

function matches(i, q) {
  const hay = `${i.title} ${plain(i.why)} ${Object.values(i.meta?.fields ?? {}).join(' ')}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

function visible(view = st.view) {
  if (view === 'overview' || isWork(view)) return [];
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
  const ov = `<button class="${st.view === 'overview' ? 'active' : ''}" data-view="overview" aria-current="${st.view === 'overview'}" title="Overview (0)" aria-label="Overview"><span class="ico" aria-hidden="true">◔</span><span class="rl">Overview</span><kbd class="hint">0</kbd><span class="count"></span></button>`;
  $('#views').innerHTML = ov + VIEWS.map(([k, label, icon], n) => {
    const mark = URG[k] ? `<span class="ico" aria-hidden="true"><span class="dot" style="background:${URG[k].c}"></span></span>` : `<span class="ico" aria-hidden="true">${icon}</span>`;
    const count = visible(k).length;
    return `<button class="${st.view === k ? 'active' : ''}" data-view="${k}" aria-current="${st.view === k}" title="${label} (${n + 1})" aria-label="${label}${count ? `, ${count}` : ''}">${mark}<span class="rl">${label}</span><kbd class="hint">${n + 1}</kbd><span class="count">${count || ''}</span></button>`;
  }).join('');

  $('#work').innerHTML = WORK_VIEWS.map(([k, label, icon, key]) => `<button class="${st.view === k ? 'active' : ''}" data-view="${k}" aria-current="${st.view === k}" title="${label} (${key})" aria-label="${label}"><span class="ico" aria-hidden="true">${icon}</span><span class="rl">${label}</span><kbd class="hint">${key}</kbd><span class="count"></span></button>`).join('');

  const real = st.sources.map((s) => {
    const info = srcInfo(s.id);
    const on = !st.hidden.has(s.id);
    const status = s.status === 'stale' ? `<span class="src-status warn" title="${esc(staleTitle(s))}">! stale</span>`
      : s.status === 'pending' ? '<span class="src-status">…</span>'
        : `<span class="src-status">${s.count || ''}</span>`;
    return `<button class="src-toggle ${on ? 'on' : ''} ${s.status === 'stale' ? 'is-stale' : ''}" data-src="${esc(s.id)}" style="--c:${info.c}" aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} ${esc(s.name)} items${s.status === 'stale' ? ' (stale)' : ''}" aria-label="${esc(s.name)}${s.status === 'stale' ? ', stale' : ''}"><span class="check" aria-hidden="true">${on ? '✓' : ''}</span><span class="rl">${esc(s.name)}</span>${status}</button>`;
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

/** A sign-in that couldn't be renewed: one click to sign in again (GitHub opens its own dialog). */
const needsSignIn = (s) => s.status === 'stale' && /sign in/i.test(s.error ?? '');
function reauthButton(s) {
  if (!needsSignIn(s)) return '';
  if (s.signIn) return `<button class="btn small primary" data-oauth="${esc(s.signIn)}">Sign in again</button>`;
  if (s.id === 'github') return '<button class="btn small primary" data-next="github">Sign in again</button>';
  return '';
}

/** One bar per broken source, above the list: what's wrong, how old the data is, and Retry. */
function staleBarsHTML() {
  if (st.view === 'done' || st.view === 'snoozed') return '';
  return st.sources.filter((s) => s.status === 'stale' && !st.hidden.has(s.id) && s.count).map((s) => {
    const next = s.nextRetryAt && s.failures > 1 ? ` Next automatic try ${esc(whenLabel(s.nextRetryAt))}.` : '';
    const busy = st.retrying.has(s.id);
    return `<div class="stale-bar" role="status"><span class="icon" aria-hidden="true">⚠</span>
      <div class="txt"><b>${esc(s.name)}</b> is <span class="stale-badge">stale since ${esc(whenLabel(s.staleSince ?? Date.now()))}</span> · showing what it found ${esc(relTime(s.lastSuccess))}.${next}<br><small>${esc(s.error)}</small></div>
      ${reauthButton(s) || `<button class="btn small" data-retry="${esc(s.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Retrying…' : '↻ Retry'}</button><button class="btn small" data-setup>Fix</button>`}</div>`;
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
    return `<div class="empty"><div class="big">🧭</div><h2>${esc(broken.name)} needs a hand</h2><div>${esc(broken.error)}</div>${reauthButton(broken) || '<button class="btn primary" data-setup>Fix in setup →</button>'}</div>`;
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
  el.innerHTML = nextStepHTML() + overviewHTML(data, { width: el.clientWidth });
  bindOverview(el);
}

function render() {
  renderNav();
  $('#list').classList.toggle('wide', isWork(st.view));
  if (isWork(st.view)) return work.render(st.view);
  if (st.view === 'overview') return renderOverview();
  const list = ordered();
  const idx = selIndex(list);
  st.selId = list[idx]?.id ?? null;
  const bars = staleBarsHTML();
  const head = bars + nextStepHTML() + `<div class="page-head"><h1>${HEADINGS[st.view]}</h1><span class="sub">${list.length} item${list.length === 1 ? '' : 's'}${st.query ? ` matching “${esc(st.query)}” <button class="chip" id="clearQ">clear ✕</button>` : ''}</span></div>`;
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
  st.sources = [...data.sources].sort(byName);
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

function toast(html, undo, { label = 'Undo', ms } = {}) {
  st.undo = undo ?? null;
  $('#toastMsg').innerHTML = html;
  $('#undoBtn').style.display = undo ? '' : 'none';
  $('#undoBtn').innerHTML = `${esc(label)} <kbd>z</kbd>`;
  const t = $('#toast');
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms ?? (undo ? 6000 : 4000));
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
  ${i.reply && !parked ? `<div class="reply-box" id="replyBox">${replyBoxHTML(i, srcName)}</div>` : ''}
  ${i.stale ? `<div class="why-box" style="--u:var(--warn)"><div class="lbl">Stale data</div>${esc(srcName)} could not refresh. Showing what it found ${esc(relTime(i.stale.since))}.<br><small>${esc(i.stale.error)}</small><div class="row-btns" style="margin-top:8px"><button class="btn small" data-retry="${esc(i.source)}">↻ Retry now</button><button class="btn small" data-setup>Fix in setup →</button></div></div>` : ''}
  </div>
  <footer>${host ? `<a class="btn primary" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">Open on ${esc(host)} ↗</a>` : ''}
  ${i.meta?.path ? `<button class="btn ${host ? '' : 'primary'}" data-copy="path">Copy path</button>` : ''}
  ${parked ? '<button class="btn" data-d="restore">↩ Restore</button>' : '<button class="btn" data-d="done">Done <kbd>x</kbd></button><button class="btn" data-d="snooze">Snooze <kbd>s</kbd></button>'}</footer>`;
  $('#drawer').classList.add('open');
  $('#drawer').dataset.id = i.id;
  if (i.reply?.allowed && !parked) checkReply(i);
}
// ---------------------------------------------------------------------------
// Replies (sources with the "reply" capability, e.g. Slack). Posting is opt-in per source,
// shows who and where it goes, and waits 5 seconds with "Undo send" before it leaves.

const drafts = new Map(); // item id → unsent text, so moving around keeps what you typed
let sending = null; // { itemId, pid, text, sendsAt, label, timer }

function replyBoxHTML(i, srcName) {
  const r = i.reply;
  if (!r.allowed) {
    return `<div class="lbl">Reply</div><div class="msg">You can answer this from Birddog. Replying is off until you turn on <b>Allow replies</b> on the ${esc(srcName)} card; then Birddog posts <b>as you</b>.</div><div class="row-btns"><button class="btn small" data-setup>Open Sources &amp; settings</button></div>`;
  }
  if (r.missingScope && i.source === 'teams') {
    return `<div class="lbl">${esc(r.label)}</div><div class="msg warn">⚠ Birddog can't send Teams messages yet: Microsoft hasn't granted <code>${esc(r.missingScope)}</code>. Sign in with Microsoft Teams again and allow sending messages. (If your organization makes an admin approve apps, ask them.)</div><div class="row-btns"><button class="btn small primary" data-oauth="teams">Sign in with Microsoft Teams again</button></div>`;
  }
  if (r.missingScope) {
    return `<div class="lbl">${esc(r.label)}</div><div class="msg warn">⚠ Your ${esc(srcName)} token can't post yet: it needs the <code>${esc(r.missingScope)}</code> scope. Add it under <b>User Token Scopes</b> in your Slack app, reinstall the app, then paste the new token on the ${esc(srcName)} card.</div><div class="row-btns"><button class="btn small" data-guide-link="replies">How to set it up</button><button class="btn small" data-setup>Open Sources &amp; settings</button></div>`;
  }
  if (sending?.itemId === i.id) {
    const left = Math.max(0, Math.ceil((sending.sendsAt - Date.now()) / 1000));
    return `<div class="lbl">${esc(r.label)}</div><blockquote class="reply-quote">${esc(sending.text)}</blockquote><div class="reply-foot"><span class="msg" data-reply-msg>${left ? `Sending in ${left} s…` : 'Sending…'}</span>${left ? '<button class="btn small" data-reply-undo>Undo send <kbd>z</kbd></button>' : ''}</div>`;
  }
  const text = drafts.get(i.id) ?? '';
  return `<label class="lbl" for="replyText">${esc(r.label)} <small>· posts as you</small></label>
    <textarea id="replyText" data-reply rows="3" maxlength="${r.maxLength ?? 4000}" placeholder="Write a reply… (plain text)">${esc(text)}</textarea>
    ${r.canBroadcast ? `<label class="reply-also"><input type="checkbox" data-reply-broadcast> Also send to ${esc(r.where)}</label>` : ''}
    <div class="reply-foot"><span class="msg" data-reply-msg>You'll have 5 seconds to undo.</span><span class="reply-count" data-reply-count>${text.length}/${r.maxLength ?? 4000}</span><button class="btn primary small" data-reply-send>Send <kbd>⌘↵</kbd></button></div>`;
}

function renderReplyBox(i) {
  const box = $('#replyBox');
  if (!box || !i || drawerItem()?.id !== i.id) return;
  box.innerHTML = replyBoxHTML(i, st.sources.find((x) => x.id === i.source)?.name ?? i.source);
}

/** Before you type: e.g. does the Slack token have chat:write? */
async function checkReply(i) {
  try {
    const d = await api.replyDetails(i.id);
    if (d.missingScope && !i.reply.missingScope) { i.reply = { ...i.reply, missingScope: d.missingScope }; renderReplyBox(i); }
  } catch { /* the send itself will say what's wrong */ }
}

function focusReply(i) {
  if (!i?.reply) return toast('This item can’t be answered from Birddog.');
  if (!drawerOpen() || drawerItem()?.id !== i.id) openDrawer(i);
  const ta = $('#replyText');
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } else $('#replyBox')?.scrollIntoView({ block: 'nearest' });
}

async function sendReply() {
  const i = drawerItem();
  const ta = $('#replyText');
  if (!i?.reply || !ta || sending) return;
  const text = ta.value.trim();
  if (!text) { ta.focus(); return; }
  const broadcast = !!$('[data-reply-broadcast]')?.checked;
  const btn = $('[data-reply-send]');
  if (btn) btn.disabled = true;
  let q;
  try { q = await api.reply(i.id, text, broadcast); } catch (err) { return replyFailed(i, text, err); }
  sending = { itemId: i.id, pid: q.id, text, sendsAt: Date.parse(q.sendsAt), label: i.reply.label };
  drafts.delete(i.id);
  renderReplyBox(i);
  toast(`✉ Sending ${esc(i.reply.label.replace(/^Reply/, 'reply'))}…`, () => undoReply(), { label: 'Undo send', ms: Math.max(1000, sending.sendsAt - Date.now()) });
  sending.timer = setInterval(() => tickReply(i), 400);
}

async function tickReply(i) {
  const s = sending;
  if (!s) return;
  if (Date.now() < s.sendsAt) return renderReplyBox(i);
  if (s.polling) return;
  s.polling = true;
  try {
    const r = await api.replyStatus(s.pid);
    if (r.state === 'sent') {
      clearInterval(s.timer); sending = null;
      if (drawerItem()?.id === i.id) closeDrawer();
      leave(i.id, () => { i.status = 'done'; i.doneAt = new Date().toISOString(); });
      toast(`✓ Sent ${esc(s.label.replace(/^Reply/, 'reply'))}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open in ${esc(sourceName(i.source))} ↗</a>` : ''}`);
    } else if (r.state === 'failed') {
      clearInterval(s.timer); sending = null;
      replyFailed(i, s.text, Object.assign(new Error(r.error?.message ?? 'Not sent.'), r.error ?? {}));
    } else if (Date.now() - s.sendsAt > 60_000) {
      clearInterval(s.timer); sending = null;
      toast(`⚠ No answer from ${esc(sourceName(i.source))} yet. Check there before sending again.`);
    }
  } catch (err) {
    clearInterval(s.timer); sending = null;
    replyFailed(i, s.text, err);
  } finally { s.polling = false; }
}

async function undoReply() {
  const s = sending;
  if (!s) return;
  try {
    await api.replyUndo(s.pid);
    clearInterval(s.timer); sending = null;
    drafts.set(s.itemId, s.text);
    const i = byId(s.itemId);
    renderReplyBox(i);
    const m = $('[data-reply-msg]');
    if (m) m.textContent = 'Not sent. Your reply is back in the box.';
    toast('↩ Not sent');
  } catch (err) { toast(`⚠ ${esc(err.message)}`); }
}

function replyFailed(i, text, err) {
  drafts.set(i.id, text);
  if (err.code === 'missing_scope') i.reply = { ...i.reply, missingScope: err.scope ?? (i.source === 'teams' ? 'ChatMessage.Send' : 'chat:write') };
  if (drawerItem()?.id === i.id) {
    renderReplyBox(i);
    const m = $('[data-reply-msg]');
    if (m) { m.textContent = `⚠ ${err.message}`; m.classList.add('warn'); }
  }
  toast(`⚠ Not sent: ${esc(err.message)}`);
}

async function setAllowReplies(id, allow, input) {
  input.disabled = true;
  try {
    st.setup = await api.allowReplies(id, allow);
    toast(allow ? '✉ Replies on: Birddog can now post as you when you send a reply.' : 'Replies off: Birddog is read-only again.');
    await load({ quiet: true });
  } catch (err) { input.checked = !allow; toast(`⚠ ${esc(err.message)}`); }
  input.disabled = false;
  renderCards();
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

function setView(v) { st.view = v; st.selId = null; closeDrawer(); closeMobileRail(); render(); }

// ---------------------------------------------------------------------------
// Main menu rail: collapsible on desktop (icons only), a drawer on phones.

const mobile = () => matchMedia('(max-width: 760px)').matches;
function setRail(open, { save = true } = {}) {
  document.body.classList.toggle('rail-collapsed', !open);
  const t = $('#railToggle');
  t.setAttribute('aria-expanded', String(open));
  t.title = open ? 'Collapse the menu (m)' : 'Expand the menu (m)';
  t.setAttribute('aria-label', open ? 'Collapse the menu' : 'Expand the menu');
  if (save) savePrefs({ railOpen: open });
  window.dispatchEvent(new Event('resize'));
}
function openMobileRail() {
  document.body.classList.add('rail-mobile-open');
  $('#railScrim').hidden = false;
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  $('#rail').querySelector('button')?.focus();
}
function closeMobileRail() {
  if (!document.body.classList.contains('rail-mobile-open')) return;
  document.body.classList.remove('rail-mobile-open');
  $('#railScrim').hidden = true;
  $('#menuBtn').setAttribute('aria-expanded', 'false');
}
function toggleRail() {
  if (mobile()) return document.body.classList.contains('rail-mobile-open') ? closeMobileRail() : openMobileRail();
  return setRail(document.body.classList.contains('rail-collapsed'));
}

function setHidden(next) {
  st.hidden = new Set(next);
  savePrefs({ hiddenSources: [...st.hidden] });
  render();
}

function openOverlay(sel) { closeAll(); $(sel).classList.add('open'); }
function closeAll() {
  closeAcct();
  if (st.firstRun) { st.firstRun = null; savePrefs({ seenSetup: true }); load({ quiet: true }); }
  st.wizard = null;
  st.only = null;
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
    ...WORK_VIEWS.map(([v, l, , k]) => ({ label: `Go to ${l}`, k, run: () => setView(v) })),
    ...VIEWS.map(([v, l], n) => ({ label: `Go to ${l}`, k: String(n + 1), run: () => setView(v) })),
    { sec: 'Actions' },
    { label: 'Refresh all sources', k: 'r', run: refresh },
    ...(sel?.meta?.command ? [{ label: `Copy next step: ${sel.meta.command}`, k: 'c', run: () => copy(sel.meta.command, 'command') }] : []),
    { label: 'Toggle dark / light', k: 't', run: () => toggleTheme() },
    { label: 'Appearance…', run: openAppear },
    { label: 'Notifications…', run: () => toggleNotifyPanel() },
    { label: 'Ask Fetch (chat)…', k: 'a', run: () => toggleChat() },
    { label: guideOpen() ? 'Hide the guide' : 'Open the guide', k: 'g', run: () => toggleGuide() },
    { label: guideWide() ? 'Narrow the guide' : 'Widen the guide', k: 'G', run: () => { if (!guideOpen()) openGuide(); toggleGuideWide(); } },
    { label: document.body.classList.contains('rail-collapsed') ? 'Expand the menu' : 'Collapse the menu', k: 'm', run: () => toggleRail() },
    ...[['start', 'Getting started'], ['sources', 'Sources'], ['notifications', 'Notifications'], ['chat', 'Ask Fetch'], ['docker', 'Docker'], ['mcp', 'MCP']].map(([id, t]) => ({ label: `Guide: ${t}`, run: () => openGuide(id) })),
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
    const left = Math.max(0, Math.round((dev.expiresAt - Date.now()) / 1000));
    const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    let host = 'github.com';
    try { host = new URL(dev.verificationUri).host; } catch { /* keep default */ }
    return `${cardTop('github', src.name, 'Waiting for GitHub…')}<ol class="gh-steps">
        <li>Copy this code: <span class="code">${esc(dev.userCode)}</span></li>
        <li>Open <b>${esc(host)}/login/device</b>, paste it and approve Birddog.</li>
        <li>Come back here. This card updates by itself.</li></ol>
      <div class="row-btns"><button class="btn primary" data-gh="open">Copy code &amp; open GitHub ↗</button><button class="btn" data-gh="device">New code</button><button class="btn" data-gh="disconnect">Cancel</button></div>
      <div class="msg">${left ? `The code expires in <b>${mmss}</b>.` : 'The code expired. Get a new one.'} Birddog asks only for read access to repositories and organizations.</div></div>`;
  }
  const err = ui.msg ?? (dev && dev.status !== 'done' ? dev.error : null);
  const device = conn.deviceFlowAvailable;
  return `${cardTop('github', src.name, ui.busy ? 'Working…' : 'Not signed in', err ? 'err' : '')}<div class="msg">${esc(src.description)}</div>
    ${err ? `<div class="msg bad">${esc(err)}</div>` : ''}
    ${device ? `<div class="signin-row"><button class="btn primary" data-gh="device" ${ui.busy ? 'disabled' : ''}>Sign in with GitHub</button><span class="consent">Birddog will read ${READS.github}. GitHub's OAuth apps can only ask for full repo access; Birddog never writes.</span></div>` : ''}
    <div class="row-btns"><button class="btn ${device ? '' : 'primary'}" data-gh="cli" ${ui.busy ? 'disabled' : ''}>Use my gh CLI login</button></div>
    ${device ? '' : '<div class="msg">Your <code>gh</code> login is the quickest way in (Birddog stores no token for it). One-click browser sign-in isn\'t set up in this copy of Birddog; <button class="linkish" data-guide-link="logins">bring your own OAuth App</button> if you want it.</div>'}</div>`;
}

const JIRA_TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** Jira: site, email and an API token. The token goes to the keychain, never config.json. */
/** A provider's sign-in state from /api/oauth (never tokens). */
const oauthState = (p) => st.setup?.oauth?.find((x) => x.id === p) ?? null;
/** What each sign-in lets Birddog read, for the consent line next to the button. */
const READS = {
  github: 'your review requests, pull requests, mentions and issues',
  google: 'your calendar events, read-only',
  microsoft: 'your calendar events and your name, read-only',
  gitlab: 'your merge requests, pipelines and issues (read_api)',
  linear: 'the issues assigned to you (read)',
  pagerduty: 'your incidents and on-call shifts (read)',
  atlassian: 'your Jira issues (read)',
  teams: 'your Teams chats and the messages that mention you (Chat.Read)',
};
const signInReady = (o) => !!o && o.canStore && o.configured && !(o.needsSecret && !o.hasSecret);

/** The one step left when Birddog's built-in app needs a secret that doesn't ship with it (Google). */
function secretStepHTML(o) {
  const p = o.id;
  const v = `BIRDDOG_${p.toUpperCase()}_CLIENT_SECRET`;
  const who = o.name.split(' ')[0];
  return `<div class="signin-note" role="note"><b>${esc(who)} sign-in: one more step.</b> Birddog's ${esc(who)} app secret doesn't ship with Birddog. Ask whoever runs the Birddog ${esc(who)} project for it, then run
    <code>birddog secret set ${esc(p)}-client-secret</code> and paste it at the prompt (it isn't shown, and it's kept in ${esc(st.setup?.secretStore ?? 'your keychain')}). Or set <code>${esc(v)}</code> or <code>${esc(v)}_FILE</code> and restart Birddog. Then reload this page.
    ${p === 'google' ? `<div class="row-btns"><button class="btn small" data-calmode="ics">Use an iCal link instead</button><span class="msg">Works right away, no sign-in.</span></div>` : ''}</div>`;
}

const ICAL_BTN = `<div class="row-btns"><button class="btn small" data-calmode="ics">Use an iCal link instead</button><span class="msg">No Google sign-in needed.</span></div>`;

/**
 * The notice next to "Sign in with Google" while Google hasn't verified Birddog's app.
 * status 'testing': invite-only (test users) and a 7-day sign-in; 'unverified': the warning screen.
 */
function googleNoticeHTML(status) {
  if (status === 'testing') {
    return `<div class="signin-note" role="note"><b>Invite-only for now:</b> Birddog's Google sign-in is still in testing, so Google only lets in accounts the maintainer has added as test users. Anyone else gets an <b>“access denied”</b> or <b>“has not completed verification”</b> error. Not on the list? Use your calendar's secret <b>iCal link</b> instead. If you are on it, Google shows an <b>“unverified app”</b> screen: choose <b>Continue</b> (or <b>Advanced → Go to Birddog (unsafe)</b>). And while the app is in testing, Google ends each sign-in after 7 days, so expect to <b>Sign in again</b> about once a week. Birddog only reads your calendar events (read-only), and they stay on this computer.
    ${ICAL_BTN}</div>`;
  }
  return `<div class="signin-note" role="note"><b>Before you sign in:</b> Google will show an <b>“unverified app”</b> screen, because Google hasn't finished verifying Birddog yet. To continue, choose <b>Advanced → Go to Birddog (unsafe)</b>. Birddog only reads your calendar events (read-only), and they stay on this computer. Until verification is done, only the first 100 Google accounts can sign in.
    ${ICAL_BTN}</div>`;
}

/**
 * The one "Sign in" row on a source card: the button and what Birddog will read, or, when this
 * copy of Birddog has no app for the provider, the fallback (token / bring your own app).
 */
function signInRow(p, { label, fallback = 'use a token below', compact = false } = {}) {
  const o = oauthState(p);
  if (!o) return '';
  if (!o.canStore) return compact ? '' : `<div class="signin-row off"><span class="msg">${esc(label)} isn't available in Docker (no keychain for its tokens), so ${esc(fallback)}.</span></div>`;
  if (o.connected) {
    return `<div class="signin-row on"><span>✓ Signed in to ${esc(o.name)}${o.account ? ` as <b>${esc(o.account)}</b>` : ''}</span><button class="btn small" data-oauth="${esc(p)}">Sign in again</button><button class="btn small" data-oauth-off="${esc(p)}">Disconnect</button></div>`;
  }
  if (!signInReady(o)) {
    if (o.builtIn && o.secretMissing) return secretStepHTML(o);
    if (compact) return '';
    const who = o.name.replace(/ \(.*\)$/, ''); // "Atlassian (Jira Cloud)" → "Atlassian"
    const why = o.noBuiltIn ? `${esc(who)} sign-in needs a secret that a downloadable app can't keep, so the quickest way in is to ${esc(fallback)}.`
      : `One-click sign-in isn't set up in this copy of Birddog, so ${esc(fallback)}.`;
    return `<div class="signin-row off"><span class="msg">${why} Have your own ${esc(who)} app? <button class="linkish" data-guide-link="logins">Bring your own app</button>.</span></div>`;
  }
  const writes = p === 'teams' ? 'It only posts a reply you send yourself, once you turn on Allow replies' : 'It never changes anything';
  return `<div class="signin-row"><button class="btn primary" data-oauth="${esc(p)}">${esc(label)}</button><span class="consent">Birddog will read ${READS[p] ?? 'your data, read-only'}. ${writes}, and the tokens stay in your keychain.</span></div>${p === 'google' && o.unverified ? googleNoticeHTML(o.googleStatus) : ''}`;
}

function jiraCardHTML(src) {
  const ui = st.cards.jira ?? {};
  const s = src.settings ?? {};
  const hasToken = !!src.secrets?.token;
  const at = oauthState('atlassian');
  const viaOauth = s.auth === 'oauth' && at?.connected;
  const connected = src.enabled && (viaOauth || (s.site && hasToken));
  const { status, cls, label, msg, summary } = cardState(src, ui);
  if (viaOauth && src.enabled && !ui.editing) {
    return `${cardTop('jira', src.name, label, cls)}<div class="msg">${esc(src.description)}</div>
      <div class="msg">Signed in with Atlassian to <b>${esc(at.site ? new URL(at.site).host : 'your site')}</b>${at.account ? ` (${esc(at.account)})` : ''}. Tokens kept in ${esc(st.setup.secretStore)} and renewed automatically${summary.replace(/^ · [^ ]+/, '')}</div>${msg}
      <div class="row-btns"><button class="btn" data-test="jira" ${ui.busy ? 'disabled' : ''}>Test again</button><button class="btn" data-oauth-off="atlassian" ${ui.busy ? 'disabled' : ''}>Disconnect</button></div></div>`;
  }
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
    ${signInRow('atlassian', { label: 'Sign in with Atlassian', fallback: 'use an API token below' })}
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
  const provider = s.provider || 'ics';
  const { status, cls, label, msg, summary } = cardState(src, ui);
  const store = esc(st.setup.secretStore);
  const signedIn = (provider === 'google' || provider === 'microsoft') && oauthState(provider)?.connected;
  if (src.enabled && signedIn && !ui.editing) {
    const o = oauthState(provider);
    return `${cardTop('cal', src.name, label, cls)}<div class="msg">${esc(src.description)}</div>
      <div class="msg">Signed in to <b>${esc(o.name)}</b>${o.account ? ` as <b>${esc(o.account)}</b>` : ''}, read-only. Tokens kept in ${store} and renewed automatically.</div>${msg}
      <div class="row-btns"><button class="btn" data-test="cal" ${ui.busy ? 'disabled' : ''}>Test again</button><button class="btn" data-edit="cal">Use another calendar</button><button class="btn" data-oauth-off="${provider}" ${ui.busy ? 'disabled' : ''}>Disconnect</button></div></div>`;
  }
  if (src.enabled && provider === 'caldav' && s.caldavUser && src.secrets?.caldavPassword && !ui.editing && status !== 'stale') {
    return `${cardTop('cal', src.name, label, cls)}<div class="msg">${esc(src.description)}</div>
      <div class="msg">Reading <b>iCloud</b> calendars as <b>${esc(s.caldavUser)}</b>, app-specific password kept in ${store}${summary.replace(/^ · [^·]+/, '')}</div>${msg}
      <div class="row-btns"><button class="btn" data-edit="cal">Change</button><button class="btn" data-test="cal" ${ui.busy ? 'disabled' : ''}>Test again</button><button class="btn" data-disconnect="cal" ${ui.busy ? 'disabled' : ''}>Disconnect</button></div></div>`;
  }
  const mode = ui.mode ?? (provider === 'caldav' ? 'caldav' : 'ics');
  const notReady = ['google', 'microsoft'].map(oauthState).filter((o) => o && !signInReady(o));
  const noOneClick = notReady.filter((o) => !(o.builtIn && o.secretMissing)).map((o) => o.name); // a missing secret shows its own step
  const picker = `${signInRow('google', { label: 'Sign in with Google', compact: true })}${signInRow('microsoft', { label: 'Sign in with Microsoft', compact: true })}
    ${noOneClick.length ? `<div class="msg">One-click ${esc(noOneClick.join(' and '))} sign-in isn't set up in this copy of Birddog: use the calendar's iCal link below, or <button class="linkish" data-guide-link="logins">bring your own app</button>.</div>` : ''}
    <div class="oauth-row"><button class="btn ${mode === 'caldav' ? 'on' : ''}" data-calmode="caldav">iCloud</button><button class="btn ${mode === 'ics' ? 'on' : ''}" data-calmode="ics">iCal link or file</button></div>`;
  if (mode === 'caldav') {
    const d = ui.draft ?? { caldavUser: s.caldavUser ?? '', caldavPassword: '' };
    return `${cardTop('cal', src.name, ui.busy ? 'Working…' : 'Not connected', ui.msg && !ui.msgGood ? 'err' : '')}<div class="msg">${esc(src.description)}</div>${picker}
      <input type="hidden" data-f="cal.provider" value="caldav">
      <div class="fields">
        <label><span>Apple ID</span><input data-f="cal.caldavUser" type="email" value="${esc(d.caldavUser)}" placeholder="you@icloud.com" autocomplete="off" spellcheck="false"></label>
        <label><span>App-specific password · <a href="https://appleid.apple.com/account/manage" target="_blank" rel="noopener noreferrer">make one ↗</a></span><input data-f="cal.caldavPassword" type="password" value="" placeholder="${src.secrets?.caldavPassword ? `Saved in ${store} · leave blank to keep it` : 'xxxx-xxxx-xxxx-xxxx'}" autocomplete="off"></label>
      </div>
      <div class="msg">Apple has no sign-in flow for calendars, so iCloud uses CalDAV with an <b>app-specific password</b>: at appleid.apple.com → Sign-In and Security → App-Specific Passwords. Never your real Apple ID password. It's kept in ${store}.</div>${msg}
      <div class="row-btns"><button class="btn primary" data-connect="cal" ${ui.busy ? 'disabled' : ''}>Test &amp; connect <kbd>↵</kbd></button></div></div>`;
  }
  const connected = src.enabled && provider === 'ics' && (hasUrl || !!s.file);
  if (connected && !ui.editing && status !== 'stale') {
    const what = [hasUrl && (envSecret('cal-url') ? `the iCal link from <code>${esc(envSecret('cal-url').from)}</code>` : `an iCal link kept in ${store}`), s.file && `<b>${esc(s.file)}</b>`].filter(Boolean).join(' and ');
    return `${cardTop('cal', src.name, label, cls)}<div class="msg">${esc(src.description)}</div>
      <div class="msg">Reading ${what}${summary.replace(/^ · [^·]+/, '')}</div>${msg}
      <div class="row-btns"><button class="btn" data-edit="cal">Change</button><button class="btn" data-test="cal" ${ui.busy ? 'disabled' : ''}>Test again</button><button class="btn" data-disconnect="cal" ${ui.busy ? 'disabled' : ''}>Disconnect</button></div></div>`;
  }
  const d = ui.draft ?? { url: '', file: s.file ?? '', email: s.email ?? '' };
  const off = ui.busy ? 'disabled' : '';
  const state = connected ? label : ui.busy ? 'Working…' : 'Not connected';
  return `${cardTop('cal', src.name, state, connected ? cls : ui.msg && !ui.msgGood ? 'err' : '')}<div class="msg">${esc(src.description)}</div>${picker}
    <input type="hidden" data-f="cal.provider" value="ics">
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

/** Any token-based source (GitLab, Linear, Azure DevOps, Sentry, PagerDuty, Slack), from its `setup` metadata. */
/** "Allow replies" on a source that can reply (Slack, Teams): the only switch that lets Birddog post. */
function replySwitchHTML(src) {
  if (!src.replies) return '';
  const on = src.replies.allowed;
  return `<div class="reply-switch ${on ? 'on' : ''}"><label><input type="checkbox" data-allow-replies="${esc(src.id)}" ${on ? 'checked' : ''}> <b>Allow replies</b></label>
    <div class="msg">${on ? 'On. When you send a reply from an item, Birddog posts it <b>as you</b> in' : 'Off: Birddog only reads. Turn this on to answer from Birddog. It will post <b>as you</b> in'} ${esc(src.name)}${src.id === 'teams' ? ', into the chat' : ': into the DM, or in the thread of a mention'}. It never posts on its own, and every reply waits 5 seconds so you can undo it. ${src.setup?.replyNote ? esc(src.setup.replyNote) : 'Needs the <code>chat:write</code> scope on your token.'}</div></div>`;
}

function tokenCardHTML(src) {
  const ui = st.cards[src.id] ?? {};
  const s = src.settings ?? {};
  const setup = src.setup;
  const tokenName = src.secretNames?.token;
  const hasToken = !!src.secrets?.token;
  const viaOauth = setup.oauth && s.auth === 'oauth' && oauthState(setup.oauth)?.connected;
  const complete = setup.fields.filter((f) => !f.optional).every((f) => s[f.key]);
  const connected = src.enabled && (viaOauth || (hasToken && complete));
  const { status, cls, label, msg, summary } = cardState(src, ui);
  if (connected && !ui.editing && status !== 'stale') {
    const how = viaOauth ? `signed in with ${esc(oauthState(setup.oauth).name)}` : envSecret(tokenName)?.from ? `token from <code>${esc(envSecret(tokenName).from)}</code>` : `token kept in ${esc(st.setup.secretStore)}`;
    return `${cardTop(src.id, src.name, label, cls)}<div class="msg">${esc(src.description)}</div>
      <div class="msg">Connected, ${how}${summary}</div>${msg}${replySwitchHTML(src)}
      <div class="row-btns"><button class="btn" data-edit="${src.id}">Change</button><button class="btn" data-test="${src.id}" ${ui.busy ? 'disabled' : ''}>Test again</button>${viaOauth ? `<button class="btn" data-oauth-off="${esc(setup.oauth)}">Disconnect</button>` : `<button class="btn" data-disconnect="${src.id}" ${ui.busy ? 'disabled' : ''}>Disconnect</button>`}</div></div>`;
  }
  const d = ui.draft ?? Object.fromEntries(setup.fields.map((f) => [f.key, s[f.key] ?? '']));
  const off = ui.busy ? 'disabled' : '';
  const env = envSecret(tokenName);
  return `${cardTop(src.id, src.name, ui.busy ? 'Working…' : src.enabled && status === 'stale' ? 'Needs attention' : 'Not connected', ui.msg && !ui.msgGood ? 'err' : status === 'stale' && src.enabled ? 'err' : '')}<div class="msg">${esc(src.description)}</div>
    ${setup.oauth ? signInRow(setup.oauth, { label: `Sign in with ${src.name}` }) : ''}${setup.oauth && signInReady(oauthState(setup.oauth)) ? '<div class="msg or-token">Or use a token:</div>' : ''}
    <div class="fields">
      ${setup.fields.map((f) => `<label><span>${esc(f.label)}${f.optional ? ' <i>(optional)</i>' : ''}</span><input data-f="${src.id}.${esc(f.key)}" value="${esc(d[f.key] ?? '')}" placeholder="${esc(f.placeholder ?? '')}" autocomplete="off" spellcheck="false"></label>`).join('')}
      ${env ? '' : `<label class="full"><span>${esc(setup.token.label)} · <a href="${esc(setup.token.help)}" target="_blank" rel="noopener noreferrer">how to get one ↗</a></span><input data-f="${src.id}.token" type="password" value="" placeholder="${hasToken ? `Saved in ${esc(st.setup.secretStore)} · leave blank to keep it` : esc(setup.token.placeholder ?? 'Paste your token')}" autocomplete="off"></label>`}
    </div>
    ${setup.notes ? `<div class="msg">${esc(setup.notes)}</div>` : ''}
    ${env ? envSecretHTML(tokenName, 'The token') : `<div class="msg">The token is stored in ${esc(st.setup.secretStore)}, never in config.json. Birddog only reads.</div>`}${msg}
    <div class="row-btns"><button class="btn primary" data-connect="${src.id}" ${off}>Test &amp; connect <kbd>↵</kbd></button>${connected ? `<button class="btn" data-cancel="${src.id}">Cancel</button>` : ''}${hasToken ? `<button class="btn" data-disconnect="${src.id}" ${off}>Disconnect</button>` : ''}</div></div>`;
}

/** A source you can only reach through a sign-in (Microsoft Teams). */
function signInCardHTML(src) {
  const ui = st.cards[src.id] ?? {};
  const p = src.setup.oauth;
  const o = oauthState(p);
  const { status, cls, label, msg, summary } = cardState(src, ui);
  if (src.enabled && o?.connected) {
    return `${cardTop(src.id, src.name, label, cls)}<div class="msg">${esc(src.description)}</div>
      <div class="msg">Connected, signed in${o.account ? ` as <b>${esc(o.account)}</b>` : ''}${summary}</div>${msg}${replySwitchHTML(src)}
      <div class="row-btns"><button class="btn" data-test="${src.id}" ${ui.busy ? 'disabled' : ''}>Test again</button><button class="btn" data-oauth="${esc(p)}">Sign in again</button><button class="btn" data-oauth-off="${esc(p)}">Disconnect</button></div></div>`;
  }
  return `${cardTop(src.id, src.name, ui.busy ? 'Working…' : src.enabled && status === 'stale' ? 'Needs attention' : 'Not connected', status === 'stale' && src.enabled ? 'err' : '')}<div class="msg">${esc(src.description)}</div>
    ${signInRow(p, { label: `Sign in with ${src.name}`, fallback: 'bring your own Microsoft app (the same one the Outlook calendar sign-in uses)' })}
    ${src.setup.notes ? `<div class="msg">${esc(src.setup.notes)}</div>` : ''}${msg}</div>`;
}

const CARDS = { git: gitCardHTML, github: githubCardHTML, jira: jiraCardHTML, cal: calCardHTML };
const cardFor = (src) => (src.enabled === false && (src.id === 'git' || src.id === 'github') ? offCardHTML(src) : (CARDS[src.id] ?? (src.setup?.oauthOnly ? signInCardHTML : src.setup ? tokenCardHTML : gitCardHTML))(src));

// ---------------------------------------------------------------------------
// First-run wizard: one source per step, each tested live as you reach it.

const WIZARD = [
  { id: 'welcome', title: 'Welcome to Birddog 🐾', intro: 'Birddog looks through your work and points at what needs you next. Connect the places your work lives; each one is tested as soon as you reach it. Skip anything you don’t use. You can change all of it later from <b>Connect a source</b>.' },
  { id: 'git', name: 'Local git', title: 'Your local repos', intro: 'Which folders hold your code? Birddog finds uncommitted work, unpushed commits and branches to tidy. It never changes your repos.',
    dockerIntro: 'Birddog sees the folders you mounted into the container, read-only (usually <code>/repos</code>). It finds uncommitted work, unpushed commits and branches to tidy, and never changes them.' },
  { id: 'github', name: 'GitHub', title: 'GitHub', intro: 'Review requests, your PRs that need work, mentions and assigned issues. The quickest way in is your existing <code>gh</code> login.',
    dockerIntro: 'Review requests, your PRs that need work, mentions and assigned issues. In Docker, Birddog uses the token you pass as <code>GITHUB_TOKEN</code>.' },
  { id: 'jira', name: 'Jira Cloud', title: 'Jira Cloud', intro: 'The tickets assigned to you, ranked by due date, sprint end, blockers and priority. You need your site, your email and an API token.',
    dockerIntro: 'The tickets assigned to you, ranked by due date, sprint end, blockers and priority. Enter your site and email here; the API token comes from <code>BIRDDOG_JIRA_TOKEN</code>.' },
  { id: 'cal', name: 'Calendar', title: 'Calendar', intro: 'Your next meetings, so a 10:00 standup never sneaks up on you. Paste an iCal link from Google, Outlook or iCloud, or pick an .ics file.',
    dockerIntro: 'Your next meetings, so a 10:00 standup never sneaks up on you. The private iCal link comes from <code>BIRDDOG_CAL_URL</code>; set <code>TZ</code> so times show in your zone.' },
  { id: 'done', title: 'You’re all set', intro: 'Here’s what Birddog is watching. Press <kbd>r</kbd> any time to refresh, or <kbd>⌘K</kbd> → “Run the setup wizard” to come back here.' },
];
// Source steps go A–Z by name, like every other list of sources.
WIZARD.splice(1, WIZARD.length - 2, ...WIZARD.slice(1, -1).sort(byName));
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

// ---------------------------------------------------------------------------
// First run: one step. Pick the folder(s) of repos (the best guess is already
// ticked), and the inbox fills with local git work. No account needed.

function firstRunHTML() {
  const fr = st.firstRun;
  $('#setupHead').innerHTML = '<h2 id="setupTitle">Where do you keep your code? 🐾</h2><p>Birddog starts with the git repos on this computer: uncommitted work, unpushed commits and branches to tidy. It only reads them, nothing leaves this machine, and you don\'t need an account.</p>';
  let body;
  if (!fr.folders) body = '<div class="card wide"><div class="msg">Looking for your repos…</div></div>';
  else {
    const rows = fr.folders.map((f, i) => `<label class="chk fr-row"><input type="checkbox" data-fr="${i}" ${f.selected ? 'checked' : ''}><code>${esc(f.path)}</code><span class="fr-n">${f.repos == null ? 'lots of folders' : `${f.repos} repo${f.repos === 1 ? '' : 's'}`}</span></label>`).join('');
    body = `<div class="card wide fr-card">${rows || '<div class="msg">No usual code folder here (like <code>~/code</code> or <code>~/Projects</code>). Type the folder below.</div>'}
      <label for="frOther">${rows ? 'Or another folder' : 'Folder with your repos'}</label>
      <input id="frOther" data-fr-other spellcheck="false" placeholder="${esc(fr.home)}/…" value="${esc(fr.other ?? '')}">
      ${fr.msg ? `<div class="msg bad">${esc(fr.msg)}</div>` : ''}</div>`;
  }
  $('#cards').innerHTML = body;
  $('#setupFoot').innerHTML = `<span class="progress">That's the only step. Everything else is optional.</span><span style="flex:1"></span><button class="btn" data-wiz="start">Full setup…</button><button class="btn primary" data-fr-go ${fr.busy || !fr.folders ? 'disabled' : ''}>${fr.busy ? 'Scanning…' : 'Show my work →'}</button>`;
  if (fr.folders && !fr.busy) setTimeout(() => $('[data-fr-go]')?.focus(), 0);
}

async function openFirstRun() {
  openOverlay('#setupScrim');
  st.wizard = null; st.only = null;
  st.firstRun = { folders: null, home: '~' };
  renderCards();
  try {
    const r = await api.firstRun();
    st.firstRun = { ...st.firstRun, folders: r.folders, home: r.home };
    st.nextStep = r.github.connected ? null : { github: false };
  } catch (err) {
    st.firstRun = { ...st.firstRun, folders: [], msg: err.message };
  }
  renderCards();
}

async function firstRunGo() {
  const fr = st.firstRun;
  document.querySelectorAll('[data-fr]').forEach((el) => { fr.folders[+el.dataset.fr].selected = el.checked; });
  fr.other = $('#frOther')?.value.trim() ?? '';
  const roots = [...fr.folders.filter((f) => f.selected).map((f) => f.path), ...(fr.other ? [fr.other] : [])];
  if (!roots.length) { fr.msg = 'Tick a folder, or type one.'; return renderCards(); }
  fr.busy = true; fr.msg = null;
  renderCards();
  const same = !fr.other && fr.folders.every((f) => f.selected === !!f.configured);
  try {
    // The usual case: the guess was right. config.json already scans it, so there's nothing to save.
    if (!same) await api.saveSource('git', { roots });
  } catch (err) {
    fr.busy = false; fr.msg = err.message;
    return renderCards();
  }
  savePrefs({ seenSetup: true });
  st.firstRun = null;
  closeAll();
  await load();
  st.view = 'all';
  render();
}

/** The one suggested next step after the first run: connect GitHub. Shown until it's connected or dismissed. */
function nextStepHTML() {
  if (!st.nextStep || st.nextStep.github) return '';
  return `<div class="next-step" role="region" aria-label="Suggested next step"><span class="ns-ico" aria-hidden="true">→</span>
    <div class="ns-txt"><b>Next: connect GitHub</b><div>Review requests, your PRs with failing checks, and mentions, next to your local work. Takes a few seconds with your <code>gh</code> login.</div>
    <small>Jira, Linear, Slack, calendars and more are in <button class="linkish" data-setup>Sources &amp; settings</button> and the <button class="linkish" data-guide-link="sources">guide</button>, whenever you want them.</small></div>
    <button class="btn primary small" data-next="github">Connect GitHub</button><button class="btn small" data-next="hide">Not now</button></div>`;
}

async function nextStepAction(a) {
  if (a === 'hide') { st.nextStep = null; savePrefs({ hideNextStep: true }); return render(); }
  return openSetup({ only: 'github' });
}

function settingsChrome() {
  // Built once per opening, so typing in the search box never loses focus.
  if (!$('#srcSearch')) {
    $('#setupHead').innerHTML = `<h2 id="setupTitle">Connect your sources</h2><p>Everything stays on this machine. Birddog only reads: it never changes your repos, PRs, tickets or calendar.</p>
      <div class="src-search"><span aria-hidden="true">🔍</span><input id="srcSearch" type="search" placeholder="Search sources: calendar, tickets, ci…" aria-label="Search sources" aria-describedby="srcCount" autocomplete="off" spellcheck="false" value="${esc(st.srcQuery)}"><span class="src-count" id="srcCount" aria-live="polite"></span></div>`;
  }
  const s = st.setup;
  const ok = s ? s.sources.filter((x) => x.status?.status === 'ok').length : 0;
  const on = s ? s.sources.filter((x) => x.enabled !== false).length : 0;
  $('#setupFoot').innerHTML = `<span class="progress" id="setupProgress">${s ? `${ok} of ${on} switched-on sources working` : ''}</span><span style="flex:1"></span><button class="btn" data-wiz="start">Run the setup wizard</button><button class="btn primary" data-close>Go to my inbox →</button>`;
}

function renderCards() {
  if (st.firstRun) return firstRunHTML();
  if (st.wizard) return wizardHTML();
  if (st.only === 'github') {
    $('#setupHead').innerHTML = '<h2 id="setupTitle">Connect GitHub</h2><p>Birddog only reads: review requests, your PRs, mentions and issues. Your <code>gh</code> login is the quickest way in; Birddog stores no token for it.</p>';
    const src = st.setup?.sources.find((x) => x.id === 'github');
    const done = !!st.setup?.connections?.github?.connected;
    $('#cards').innerHTML = !st.setup ? '<div class="card wide"><div class="msg">Loading…</div></div>' : src ? githubCardHTML({ ...src, enabled: true }) : '';
    $('#setupFoot').innerHTML = `<span class="progress">${done ? '✓ Connected' : ''}</span><span style="flex:1"></span><button class="btn" data-only-all>All sources…</button><button class="btn primary" data-close>${done ? 'Go to my inbox →' : 'Not now'}</button>`;
    if (done && st.nextStep) { st.nextStep = null; }
    return;
  }
  settingsChrome();
  const s = st.setup;
  if (!s) { $('#cards').innerHTML = '<div class="card wide"><div class="msg">Loading…</div></div>'; return; }
  const warn = s.secretWarning ? `<div class="card wide warnbox"><div class="msg">⚠ ${esc(s.secretWarning)}</div></div>` : '';
  const soon = s.comingSoon.map((c) => `${cardTop(c.id, c.name, 'Coming soon', 'soon', false)}<div class="msg">${esc(c.description)}</div></div>`);
  const tag = (html, id) => html.replace('<div class="card', `<div data-card="${esc(id)}" class="card`);
  $('#cards').innerHTML = warn + s.sources.map((src) => tag(cardFor(src), src.id)).join('') + soon.map((html, i) => tag(html, s.comingSoon[i].id)).join('')
    + '<div class="card wide src-empty" id="srcEmpty" hidden><div class="msg">No source matches that. Try a kind of thing, like <i>tickets</i>, <i>calendar</i> or <i>ci</i>.</div></div>';
  filterCards();
}

/** Hide the cards that don't match (instead of re-rendering, so half-typed fields survive). */
function filterCards() {
  const s = st.setup;
  if (!s || !$('#srcSearch')) return;
  const all = [...s.sources, ...s.comingSoon];
  let shown = 0;
  for (const src of all) {
    const el = document.querySelector(`[data-card="${CSS.escape(src.id)}"]`);
    const ok = sourceMatches(src, st.srcQuery);
    if (el) el.hidden = !ok;
    if (ok) shown++;
  }
  $('#srcEmpty').hidden = shown > 0;
  $('#srcCount').textContent = st.srcQuery.trim() ? `${shown} of ${all.length}` : `${all.length} sources, A–Z`;
}

async function openSetup({ wizard = false, only = null } = {}) {
  openOverlay('#setupScrim');
  st.cards = {};
  st.firstRun = null;
  st.only = only;
  st.srcQuery = '';
  $('#setupHead').innerHTML = '';
  st.wizard = wizard ? { step: 0 } : null;
  renderCards();
  try {
    const [setup, oauth] = await Promise.all([api.setup(), api.oauth().catch(() => ({ providers: [] }))]);
    st.setup = { ...setup, oauth: oauth.providers };
    renderCards();
  } catch (err) {
    $('#cards').innerHTML = `<div class="card wide err"><div class="msg">${esc(err.message)}</div></div>`;
  }
  savePrefs({ seenSetup: true });
}
const openWizard = () => openSetup({ wizard: true });

/** "Sign in with …": the browser goes to the provider and comes back to /auth/oauth/<p>/callback. */
async function oauthSignIn(p) {
  try {
    const { url } = await api.oauthStart(p);
    location.assign(url);
  } catch (err) { toast(`⚠ ${esc(err.message)}`); }
}
async function oauthSignOut(p) {
  try {
    const r = await api.oauthOff(p);
    toast(r.revoked ? '✓ Signed out and revoked at the provider.' : `Signed out. Birddog forgot the tokens${r.manage ? '; to remove its access entirely, see your account\'s app settings' : ''}.`);
    const [setup, oauth] = await Promise.all([api.setup(), api.oauth()]);
    st.setup = { ...setup, oauth: oauth.providers };
    st.cards = {};
    renderCards();
    await load({ quiet: true });
  } catch (err) { toast(`⚠ ${esc(err.message)}`); }
}

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
    const e = envSecret(st.setup.sources.find((x) => x.id === id)?.secretNames?.token ?? (id === 'cal' ? 'cal-url' : `${id}-token`));
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
  const t = e.target.closest('[data-allow-replies],[data-reply-send],[data-reply-undo],[data-oauth],[data-oauth-off],[data-calmode],[data-guide-link],[data-ov-item],[data-view],[data-src],[data-soon],[data-act],.row,[data-close-drawer],[data-d],[data-sn],[data-p],[data-test],[data-save],[data-edit],[data-cancel],[data-connect],[data-disconnect],[data-retry],[data-enable],[data-wiz],[data-fr-go],[data-next],[data-only-all],[data-close],[data-setup],[data-copy],[data-gh],[data-logout],#clearQ');
  if (!t) { if (snoozeOpen() && !e.target.closest('#snooze')) closeSnooze(); return; }
  const d = t.dataset;
  if (d.allowReplies) return setAllowReplies(d.allowReplies, t.checked, t);
  if ('replySend' in d) return sendReply();
  if ('replyUndo' in d) return undoReply();
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
  if (d.oauth) return oauthSignIn(d.oauth);
  if (d.oauthOff) return oauthSignOut(d.oauthOff);
  if (d.calmode) { st.cards.cal = { ...(st.cards.cal ?? {}), mode: d.calmode, editing: true, draft: undefined, msg: null }; return renderCards(); }
  if (d.guideLink) { closeAll(); return openGuide(d.guideLink); }
  if (d.retry) return retrySource(d.retry);
  if (d.enable) return enableAction(d.enable);
  if (d.wiz) return d.wiz === 'start' ? openWizard() : wizardAction(d.wiz);
  if ('frGo' in d) return firstRunGo();
  if (d.next) return nextStepAction(d.next);
  if ('onlyAll' in d) { st.only = null; return renderCards(); }
  if (d.disconnect) return disconnectCard(d.disconnect);
  if (d.edit) { st.cards[d.edit] = { editing: true }; renderCards(); return document.querySelector(`[data-in="${CSS.escape(d.edit)}"],[data-f^="${CSS.escape(d.edit)}."]`)?.focus(); }
  if (d.cancel) { st.cards[d.cancel] = {}; return renderCards(); }
  if ('close' in d) return closeAll();
  if ('setup' in d) { e.preventDefault(); closeDrawer(); return openSetup(); }
  if (d.copy) { const i = drawerItem(); return copy(d.copy === 'path' ? i?.meta?.path : i?.meta?.command, d.copy); }
});

document.addEventListener('input', (e) => {
  if (!e.target.matches?.('textarea[data-reply]')) return;
  const i = drawerItem();
  if (i) drafts.set(i.id, e.target.value);
  const c = $('[data-reply-count]');
  if (c) c.textContent = `${e.target.value.length}/${e.target.maxLength}`;
});

$('#openPalette').onclick = () => openPalette();
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (st.view === 'overview') renderOverview(); }, 120); });
$('#openSetup').onclick = () => { closeMobileRail(); openSetup(); };
$('#refresh').onclick = refresh;
$('#appearBtn').onclick = (e) => { e.stopPropagation(); appearOpen() ? closeAppear() : openAppear(); };
$('#chatBtn').onclick = () => toggleChat();
$('#railToggle').onclick = () => toggleRail();
$('#menuBtn').onclick = () => openMobileRail();
$('#railScrim').onclick = () => closeMobileRail();
$('#guideBtn').onclick = () => toggleGuide();
$('#meBtn').onclick = (e) => { e.stopPropagation(); acctOpen() ? closeAcct() : openAcct(); };
$('#acctMenu').addEventListener('click', (e) => { const b = e.target.closest('[data-acct]'); if (b) { e.stopPropagation(); acctAction(b.dataset.acct); } });
$('#acctMenu').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  const items = [...document.querySelectorAll('#acctMenu [role=menuitem]')];
  const i = items.indexOf(document.activeElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
});
for (const type of ['click', 'input', 'keydown', 'pointerdown', 'dblclick']) $('#guideRail').addEventListener(type, (e) => { if (onGuideEvent(e)) e.stopPropagation(); });
for (const type of ['click', 'change', 'submit', 'keydown']) $('#chatPanel').addEventListener(type, (e) => { e.stopPropagation(); onChatEvent(e); });
$('#notifyBtn').onclick = (e) => { e.stopPropagation(); closeAppear(); closeAcct(); toggleNotifyPanel(); };
$('#notifyPanel').addEventListener('change', (e) => { onNotifyPanelEvent(e); });
$('#notifyPanel').addEventListener('click', (e) => { e.stopPropagation(); onNotifyPanelEvent(e); });
$('#undoBtn').onclick = runUndo;
$('#pInput').addEventListener('input', () => { pSel = 0; renderPalette(); });
$('#setupHead').addEventListener('input', (e) => { if (e.target.id === 'srcSearch') { st.srcQuery = e.target.value; filterCards(); } });
$('#appear').onclick = (e) => {
  e.stopPropagation();
  const b = e.target.closest('[data-pal],[data-mode]');
  if (!b) return;
  if (b.dataset.pal) setPalette(b.dataset.pal); else setMode(b.dataset.mode);
};
document.addEventListener('mousedown', (e) => {
  if (appearOpen() && !e.target.closest('#appear,#appearBtn')) closeAppear();
  if (acctOpen() && !e.target.closest('#acctMenu,#meBtn')) closeAcct();
  if (notifyPanelOpen() && !e.target.closest('#notifyPanel,#notifyBtn')) closeNotifyPanel();
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return overlay() ? closeAll() : openPalette(); }
  if (e.key === 'Escape') {
    if (e.target.id === 'srcSearch' && e.target.value) { e.preventDefault(); e.target.value = ''; st.srcQuery = ''; return filterCards(); }
    if (acctOpen()) return closeAcct({ focus: true });
    if (appearOpen()) return closeAppear();
    if (notifyPanelOpen()) return closeNotifyPanel();
    if (chatOpen()) return closeChat();
    if (document.body.classList.contains('rail-mobile-open')) return closeMobileRail();
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
  if (e.target.matches?.('textarea[data-reply]') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendReply(); return; }
  if (e.target.matches?.('input[data-fr-other]') && e.key === 'Enter') { e.preventDefault(); firstRunGo(); return; }
  if (e.target.matches?.('input[data-f]') && e.key === 'Enter') { e.preventDefault(); connectCard(e.target.dataset.f.split('.')[0]); return; }
  if (e.target.matches?.('input,textarea,select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (overlay()) return;
  if (snoozeOpen()) {
    const n = +e.key - 1;
    if (n >= 0 && n < choices.length) snooze(byId($('#snooze').dataset.id), choices[n]);
    return;
  }
  if (st.view === 'overview' && ['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); return setView('all'); }
  if (isWork(st.view) && ['j', 'k', 'ArrowDown', 'ArrowUp', 'Enter', 'x', 's', 'u', 'c', 'o', 'R'].includes(e.key)) return; // no item list here
  if (isWork(st.view) && e.key === 'r') return work.refresh(st.view);
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
    case 'R': e.preventDefault(); return focusReply(drawerOpen() ? drawerItem() : sel);
    case 'c': return sel?.meta?.command ? copy(sel.meta.command, 'command') : undefined;
    case 'o': return openLink(sel);
    case 'a': e.preventDefault(); return toggleChat();
    case 'g': e.preventDefault(); return toggleGuide();
    case 'G': e.preventDefault(); if (!guideOpen()) openGuide(); return toggleGuideWide();
    case 'm': e.preventDefault(); return toggleRail();
    case 'r': return refresh();
    // No toast here: it would replace a pending "Undo" toast, and the change is visible anyway.
    case 't': toggleTheme(); return;
    case 'p': cyclePalette(); return;
    case '/': e.preventDefault(); return openPalette();
    case '?': return openOverlay('#helpScrim');
    case 'b': return setView('board');
    case 'w': return setView('worktrees');
    default: {
      if (e.key === '0') return setView('overview');
      const v = VIEWS[+e.key - 1]?.[0];
      if (v) setView(v);
    }
  }
});

// ---------------------------------------------------------------------------
// Signed-in user (only when login is turned on)

// ---------------------------------------------------------------------------
// Account menu (the avatar, top right)

function renderMe(me) {
  st.me = me;
  const user = me?.authEnabled ? me.user : null;
  const label = user ? (user.email ?? user.name ?? 'signed in') : null;
  const btn = $('#meBtn');
  if (label) $('#meAvatar').textContent = label[0].toUpperCase();
  btn.title = label ? `Account: ${label}` : 'Account';
  btn.setAttribute('aria-label', label ? `Account menu, signed in as ${label}` : 'Account menu');
  if (acctOpen()) renderAcct();
}

const acctOpen = () => !$('#acctMenu').hidden;
function renderAcct() {
  const user = st.me?.authEnabled ? st.me.user : null;
  const who = user
    ? `<div class="acct-who"><span class="avatar" aria-hidden="true">${esc((user.email ?? user.name ?? '?')[0].toUpperCase())}</span><div><b>${esc(user.name ?? user.email ?? 'Signed in')}</b>${user.email && user.name ? `<small>${esc(user.email)}</small>` : ''}</div></div>`
    : '<div class="acct-who"><div><b>Just you, on this computer</b><small>No sign-in: Birddog only listens on this machine.</small></div></div>';
  const item = (a, label, k = '') => `<button role="menuitem" data-acct="${a}">${label}${k ? `<kbd>${k}</kbd>` : ''}</button>`;
  $('#acctMenu').innerHTML = `${who}<div class="acct-items">${item('setup', 'Sources &amp; settings')}${item('appear', 'Appearance…', 'p')}${item('keys', 'Keyboard shortcuts', '?')}${user ? item('logout', 'Sign out') : ''}</div>`;
}
function openAcct() {
  closeAppear(); closeNotifyPanel();
  renderAcct();
  $('#acctMenu').hidden = false;
  $('#meBtn').setAttribute('aria-expanded', 'true');
  $('#acctMenu [role=menuitem]')?.focus();
}
function closeAcct({ focus = false } = {}) {
  if (!acctOpen()) return;
  $('#acctMenu').hidden = true;
  $('#meBtn').setAttribute('aria-expanded', 'false');
  if (focus) $('#meBtn').focus();
}
function acctAction(a) {
  closeAcct();
  if (a === 'setup') return openSetup();
  if (a === 'appear') return openAppear();
  if (a === 'keys') return openOverlay('#helpScrim');
  if (a === 'logout') return signOut();
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
  initAppearance({ prefs, save: savePrefs, changed: () => { if (appearOpen()) renderAppear(); loadShots(); } });
  initGuide({ open: !!prefs.guideOpen, width: prefs.guideWidth ?? null, save: (open) => savePrefs({ guideOpen: open }), saveWidth: (w) => savePrefs({ guideWidth: w }), theme: () => document.documentElement.dataset.theme });
  st.hidden = new Set(prefs.hiddenSources ?? []);
  setRail(prefs.railOpen !== false, { save: false });
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
  const qs = new URLSearchParams(location.search);
  if (qs.has('connected') || qs.has('setup')) {
    const p = qs.get('connected');
    history.replaceState(null, '', location.pathname);
    if (p) toast(`✓ Signed in to ${esc({ google: 'Google', microsoft: 'Microsoft', atlassian: 'Atlassian' }[p] ?? p)}`);
    setTimeout(() => openSetup(), 200);
  } else if (!prefs.seenSetup) openFirstRun();
  else if (!prefs.hideNextStep) api.github().then((g) => { if (!g.connected) { st.nextStep = { github: false }; render(); } }).catch(() => {});
  liveReload();
}

boot();
