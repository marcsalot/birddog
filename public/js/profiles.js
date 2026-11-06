// Profiles (Work, Home, …): the switcher in the top bar and its editor.
// Pure HTML builders are exported for tests; initProfiles() wires the DOM.
// The server decides what each profile shows (src/profiles.mjs); this only picks one
// and edits the list.

import { api } from './api.js';
import { esc } from './format.js';

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "Mon–Fri 08:00–18:00", "Sat, Sun all day"… */
export function scheduleText(s) {
  if (!s) return 'no schedule';
  const d = [...s.days].sort();
  const run = d.length > 2 && d.every((x, n) => n === 0 || x === d[n - 1] + 1);
  const days = d.length === 7 ? 'Every day' : run ? `${DAY_NAMES[d[0]]}–${DAY_NAMES[d[d.length - 1]]}` : d.map((x) => DAY_NAMES[x]).join(', ');
  return `${days} ${s.from}–${s.to}`;
}

const sourcesText = (p, all) => (!p.sources ? 'every source' : p.sources.length ? p.sources.map((id) => all.find((s) => s.id === id)?.name ?? id).join(', ') : 'no sources');

/** The top-bar button's label. */
export function buttonLabel(view) {
  if (!view) return 'Profile';
  return view.auto ? `${view.name} · auto` : view.name;
}

/** The switcher: Auto, each profile, All sources. */
export function pickerHTML(view) {
  const row = (choice, title, sub, on) => `<button class="pf-row ${on ? 'on' : ''}" data-pf-pick="${esc(choice)}" role="menuitemradio" aria-checked="${on}"><b>${esc(title)}</b><span>${esc(sub)}</span></button>`;
  const autoNow = view.auto ? view.name : (view.list.find((p) => p.schedule) ? 'by schedule' : view.list[0]?.name ?? '');
  return `<h4>Profile</h4>
    <div class="pf-list" role="menu">
      ${row('auto', 'Auto', view.auto ? `Now: ${autoNow}, by schedule` : 'Switch by schedule', view.choice === 'auto')}
      ${view.list.map((p) => row(p.id, p.name, `${sourcesText(p, view.sources)} · ${scheduleText(p.schedule)}${p.notify ? '' : ' · silent'}`, view.choice === p.id)).join('')}
      ${row('all', 'All sources', 'Everything, no filter', view.choice === 'all')}
    </div>
    ${view.hidden ? `<div class="msg">${plural(view.hidden, 'item')} hidden by this profile.</div>` : ''}
    <div class="row-btns"><button class="btn small" data-pf-edit>Edit profiles</button></div>`;
}

/** The editor: one block per profile. `draft` is the list being edited. */
export function editorHTML(draft, sources, msg = null) {
  const block = (p, n) => {
    const all = !p.sources;
    return `<fieldset class="pf-edit" data-pf-n="${n}">
      <div class="pf-head"><input class="pf-name" data-pf-name="${n}" value="${esc(p.name)}" maxlength="40" aria-label="Profile name" placeholder="Name">
        ${draft.length > 1 ? `<button class="btn small" data-pf-remove="${n}" aria-label="Remove ${esc(p.name)}">Remove</button>` : ''}</div>
      <label class="pf-check"><input type="checkbox" data-pf-all="${n}" ${all ? 'checked' : ''}> Every source</label>
      ${all ? '' : `<div class="pf-srcs">${sources.map((s) => `<label class="pf-check ${s.enabled ? '' : 'off'}"><input type="checkbox" data-pf-src="${n}" value="${esc(s.id)}" ${p.sources.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div>`}
      <label class="pf-check"><input type="checkbox" data-pf-sched="${n}" ${p.schedule ? 'checked' : ''}> On a schedule (for Auto)</label>
      ${p.schedule ? `<div class="pf-sched">
        <span class="pf-days">${DAYS.map((d, i) => `<button type="button" class="pf-day ${p.schedule.days.includes(i) ? 'on' : ''}" data-pf-day="${n}:${i}" aria-pressed="${p.schedule.days.includes(i)}" aria-label="${DAY_NAMES[i]}">${d}</button>`).join('')}</span>
        <input type="time" data-pf-from="${n}" value="${esc(p.schedule.from)}" aria-label="From"> – <input type="time" data-pf-to="${n}" value="${esc(p.schedule.to)}" aria-label="To">
      </div>` : ''}
      <label class="pf-check"><input type="checkbox" data-pf-notify="${n}" ${p.notify ? 'checked' : ''}> Notifications while this profile shows</label>
    </fieldset>`;
  };
  return `<h4>Edit profiles</h4>
    <div class="pf-edits">${draft.map(block).join('')}</div>
    ${msg ? `<div class="msg ${msg.good ? 'good' : 'bad'}">${esc(msg.text)}</div>` : ''}
    <div class="row-btns">
      <button class="btn primary small" data-pf-save>Save</button>
      <button class="btn small" data-pf-cancel>Cancel</button>
      ${draft.length < 12 ? '<button class="btn small" data-pf-add>Add a profile</button>' : ''}
      <button class="btn small" data-pf-reset title="Back to Work and Home">Reset</button>
    </div>
    <div class="msg">Every source keeps refreshing. A profile only changes what you see and what can notify you.</div>`;
}

/**
 * @param {object} o
 * @param {() => void} o.changed   reload the inbox after a switch or a save
 * @param {(html: string) => void} o.toast
 */
export function initProfiles({ changed, toast }) {
  const btn = document.getElementById('profileBtn');
  const panel = document.getElementById('profilePanel');
  if (!btn || !panel) return { update() {}, isOpen: () => false, close() {}, cycle() {}, pick() {} };
  let view = null;
  let draft = null; // the list being edited, or null
  let msg = null;

  const isOpen = () => panel.classList.contains('open');
  const render = () => { panel.innerHTML = view ? (draft ? editorHTML(draft, view.sources, msg) : pickerHTML(view)) : '<div class="msg">Loading…</div>'; };
  function update(v) {
    if (!v) return;
    view = { ...view, ...v };
    btn.querySelector('span').textContent = buttonLabel(view);
    btn.title = `Profile: ${buttonLabel(view)}${view.hidden ? ` · ${plural(view.hidden, 'item')} hidden` : ''} (⇧P)`;
    btn.classList.toggle('filtered', view.active !== 'all' && !!view.list?.find((p) => p.id === view.active)?.sources);
    if (isOpen() && !draft) render();
  }
  async function load() { try { update(await api.profiles()); } catch { /* keep the last view */ } }
  /** Open the switcher, or the editor with open('edit'). */
  async function open(mode) {
    draft = null; msg = null;
    panel.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    render();
    await load();
    if (mode === 'edit' && view) draft = structuredClone(view.list);
    render();
  }
  function close() {
    panel.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    draft = null;
  }
  async function pick(choice) {
    try {
      await api.savePrefs({ profile: choice });
      await load();
      changed();
      toast(`Profile: ${esc(buttonLabel(view))}`);
    } catch (err) { toast(`Couldn't switch: ${esc(err.message)}`); }
  }
  /** ⇧P: Auto → each profile → All sources → Auto. */
  function cycle() {
    if (!view) return load().then(() => view && cycle());
    const order = ['auto', ...view.list.map((p) => p.id), 'all'];
    return pick(order[(order.indexOf(view.choice) + 1) % order.length]);
  }

  // Read what's typed into the draft before re-rendering, so nothing is lost.
  function readInputs() {
    panel.querySelectorAll('[data-pf-name]').forEach((el) => { draft[+el.dataset.pfName].name = el.value; });
    panel.querySelectorAll('[data-pf-from]').forEach((el) => { const p = draft[+el.dataset.pfFrom]; if (p.schedule) p.schedule.from = el.value; });
    panel.querySelectorAll('[data-pf-to]').forEach((el) => { const p = draft[+el.dataset.pfTo]; if (p.schedule) p.schedule.to = el.value; });
    panel.querySelectorAll('[data-pf-notify]').forEach((el) => { draft[+el.dataset.pfNotify].notify = el.checked; });
    draft.forEach((p, n) => {
      if (p.sources) p.sources = [...panel.querySelectorAll(`[data-pf-src="${n}"]`)].filter((x) => x.checked).map((x) => x.value);
    });
  }

  btn.addEventListener('click', (e) => { e.stopPropagation(); return isOpen() ? close() : open(); });
  document.addEventListener('mousedown', (e) => { if (isOpen() && !e.target.closest('#profilePanel,#profileBtn')) close(); });
  panel.addEventListener('click', async (e) => {
    e.stopPropagation();
    const t = e.target.closest('[data-pf-pick],[data-pf-edit],[data-pf-cancel],[data-pf-add],[data-pf-remove],[data-pf-all],[data-pf-sched],[data-pf-day],[data-pf-save],[data-pf-reset]');
    if (!t) return;
    if (t.dataset.pfPick) { close(); return pick(t.dataset.pfPick); }
    if ('pfEdit' in t.dataset) { draft = structuredClone(view.list); msg = null; return render(); }
    if ('pfCancel' in t.dataset) { draft = null; msg = null; return render(); }
    readInputs();
    if ('pfAdd' in t.dataset) draft.push({ id: '', name: `Profile ${draft.length + 1}`, sources: [], schedule: null, notify: true });
    else if (t.dataset.pfRemove) draft.splice(+t.dataset.pfRemove, 1);
    else if (t.dataset.pfAll) { const p = draft[+t.dataset.pfAll]; p.sources = t.checked ? null : view.sources.filter((s) => s.enabled).map((s) => s.id); }
    else if (t.dataset.pfSched) { const p = draft[+t.dataset.pfSched]; p.schedule = t.checked ? { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' } : null; }
    else if (t.dataset.pfDay) {
      const [n, d] = t.dataset.pfDay.split(':').map(Number);
      const s = draft[n].schedule;
      s.days = s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d].sort();
    } else if ('pfSave' in t.dataset || 'pfReset' in t.dataset) {
      try {
        // A new profile has no id yet: the server makes one from its name.
        const v = 'pfReset' in t.dataset ? await api.resetProfiles() : await api.saveProfiles(draft.map((p) => ({ ...p, id: p.id || undefined })));
        draft = null; msg = null;
        update(v);
        render();
        changed();
        toast('✓ Profiles saved');
      } catch (err) { msg = { text: err.message, good: false }; }
    }
    if (draft) render();
  });
  load();
  return { update, isOpen, close, cycle, pick, open };
}
