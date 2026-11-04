// Desktop notifications: the 🔔 panel and showing notifications while a tab is open.
// The server decides what is news (and makes sure nothing is announced twice);
// this tab asks for it every 20 seconds and shows it with the Notification API.

import { esc, whenLabel } from './format.js';

const POLL_MS = 20_000;
const supported = typeof window !== 'undefined' && 'Notification' in window;
const permission = () => (supported ? Notification.permission : 'unsupported');

let ctx = null; // { api, toast, sources: () => [], openItem(id), save(patch) }
let settings = null;
let kinds = [];
let timer = null;

export function initNotify(options) {
  ctx = options;
  settings = options.prefs.notifications ?? { enabled: false, channel: 'auto', sources: {}, kinds: {}, staleSources: true, quietHours: { enabled: false, start: '22:00', end: '08:00' }, snoozeUntil: null };
  renderButton();
  timer = setInterval(poll, POLL_MS);
  poll();
}

export const notifyPanelOpen = () => document.querySelector('#notifyPanel')?.classList.contains('open');
export function closeNotifyPanel() { document.querySelector('#notifyPanel')?.classList.remove('open'); }
export async function toggleNotifyPanel() {
  if (notifyPanelOpen()) return closeNotifyPanel();
  if (!kinds.length) { try { kinds = (await ctx.api.notifyKinds()).kinds; } catch { kinds = []; } }
  render();
  document.querySelector('#notifyPanel').classList.add('open');
}

const snoozed = () => settings.snoozeUntil && Date.parse(settings.snoozeUntil) > Date.now();

function renderButton() {
  const b = document.querySelector('#notifyBtn');
  if (!b) return;
  const off = !settings.enabled || snoozed();
  b.textContent = off ? '🔕' : '🔔';
  b.title = !settings.enabled ? 'Notifications are off' : snoozed() ? `Notifications snoozed until ${whenLabel(settings.snoozeUntil)}` : 'Notifications';
  b.setAttribute('aria-label', b.title);
  b.classList.toggle('on', !off);
}

async function save(patch) {
  try {
    const prefs = await ctx.api.savePrefs({ notifications: patch });
    settings = prefs.notifications;
  } catch (err) {
    ctx.toast(`⚠ ${esc(err.message)}`);
  }
  renderButton();
  if (notifyPanelOpen()) render();
}

function permissionLine() {
  const p = permission();
  if (p === 'granted') return '<div class="msg good">✓ This browser may show notifications.</div>';
  if (p === 'denied') return '<div class="msg bad">This browser blocks notifications for Birddog. Allow them in the site settings (the icon left of the address), or let the system show them instead.</div>';
  if (p === 'unsupported') return '<div class="msg">This browser can\'t show notifications; Birddog will use the system\'s.</div>';
  return '<div class="msg">The browser will ask for permission when you switch notifications on.</div>';
}

function render() {
  const el = document.querySelector('#notifyPanel');
  const s = settings;
  const sources = ctx.sources();
  const check = (attr, on, label, extra = '') => `<label class="chk"><input type="checkbox" ${attr} ${on ? 'checked' : ''} ${extra}><span>${label}</span></label>`;
  const radio = (v, label) => `<label class="chk"><input type="radio" name="nchan" data-nchan="${v}" ${s.channel === v ? 'checked' : ''}><span>${label}</span></label>`;

  el.innerHTML = `<h3>Notifications</h3>
    <div class="np-row">${check('data-n="enabled"', s.enabled, '<b>Tell me when something needs me now</b>')}</div>
    <div class="np-help">A review someone is waiting on, a meeting about to start, an overdue ticket, a source that stops working. Each thing at most once.</div>
    ${s.enabled ? `
    ${permissionLine()}
    <div class="np-sec">Where</div>
    ${radio('auto', 'In this browser while a Birddog tab is open, otherwise from the system')}
    ${radio('browser', 'Only in the browser')}
    ${radio('system', 'Always from the system (macOS, Linux, Windows)')}
    <div class="np-sec">Pause</div>
    <div class="row-btns">${snoozed()
    ? `<span class="np-help">Snoozed until <b>${esc(whenLabel(s.snoozeUntil))}</b></span><button class="btn small" data-nsnooze="off">Resume</button>`
    : '<button class="btn small" data-nsnooze="1h">Snooze all 1 hour</button><button class="btn small" data-nsnooze="tomorrow">Until tomorrow 9:00</button>'}</div>
    <div class="np-quiet">${check('data-n="quiet"', s.quietHours.enabled, 'Quiet hours')}
      <input type="time" data-nq="start" value="${esc(s.quietHours.start)}" aria-label="Quiet from"> – <input type="time" data-nq="end" value="${esc(s.quietHours.end)}" aria-label="Quiet until"></div>
    <div class="np-sec">What</div>
    <div class="np-group"><div class="np-help">From these sources</div>${sources.map((src) => check(`data-nsrc="${esc(src.id)}"`, s.sources[src.id] !== false, esc(src.name))).join('')}</div>
    <div class="np-group"><div class="np-help">About these things</div>${kinds.map((k) => check(`data-nkind="${esc(k.kind)}"`, s.kinds[k.kind] !== false, esc(k.label))).join('')}</div>
    ${check('data-n="staleSources"', s.staleSources, 'A source stops refreshing')}
    <div class="row-btns" style="margin-top:10px"><button class="btn small" data-ntest>Send a test notification</button></div>
    <div class="np-help">With no Birddog running at all, <code>birddog notify</code> keeps the system notifications coming.</div>` : ''}`;
}

/** Handle clicks and changes inside the panel. Returns true if it handled the event. */
export async function onNotifyPanelEvent(e) {
  const t = e.target;
  if (!t.closest?.('#notifyPanel')) return false;
  const d = t.dataset ?? {};
  if (e.type === 'change') {
    if (d.n === 'enabled') {
      if (t.checked && permission() === 'default') { try { await Notification.requestPermission(); } catch { /* old browsers */ } }
      await save({ enabled: t.checked });
    } else if (d.n === 'staleSources') await save({ staleSources: t.checked });
    else if (d.n === 'quiet') await save({ quietHours: { enabled: t.checked } });
    else if (d.nq) await save({ quietHours: { [d.nq]: t.value } });
    else if (d.nchan) await save({ channel: d.nchan });
    else if (d.nsrc) await save({ sources: { [d.nsrc]: t.checked } });
    else if (d.nkind) await save({ kinds: { [d.nkind]: t.checked } });
    return true;
  }
  if (e.type === 'click') {
    if (d.nsnooze) {
      const until = d.nsnooze === 'off' ? null
        : d.nsnooze === '1h' ? new Date(Date.now() + 3_600_000).toISOString()
          : (() => { const x = new Date(); x.setDate(x.getDate() + 1); x.setHours(9, 0, 0, 0); return x.toISOString(); })();
      await save({ snoozeUntil: until });
      return true;
    }
    if ('ntest' in d) {
      const system = settings.channel === 'system' || permission() !== 'granted';
      try {
        await ctx.api.notifyTest(system ? 'system' : undefined);
        if (system) ctx.toast('Sent a test notification from the system. Nothing? Allow notifications for Terminal or Script Editor in your OS settings.');
        else await poll(true);
      } catch (err) { ctx.toast(`⚠ ${esc(err.message)}`); }
      return true;
    }
  }
  return false;
}

/** Ask the server for anything new and show it. */
export async function poll(force = false) {
  if (!settings?.enabled && !force) return;
  if (settings?.channel === 'system') return;
  const canShow = permission() === 'granted';
  let events = [];
  try { events = (await ctx.api.notifyClaim(canShow)).events; } catch { return; }
  for (const ev of events) {
    const n = new Notification(ev.title, { body: ev.body, tag: `birddog-${ev.id}`, icon: '/favicon.svg' });
    n.onclick = () => { window.focus(); if (ev.itemId) ctx.openItem(ev.itemId); n.close(); };
  }
}

export function stopNotify() { clearInterval(timer); }
