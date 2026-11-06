// Preferences: one place for everything that's yours to choose. Appearance,
// notifications, profiles, where emails open, layout, and what version this is.
// Opened from the account menu, the command palette or the "," key. Each section saves
// as you change it; there's no Save button to forget.
//
// Pure HTML builders are exported for tests; initPrefs() wires the DOM.

import { appearanceHTML, setMode, setPalette } from './appearance.js';
import { esc } from './format.js';
import { onNotifyPanelEvent, renderNotifySettings } from './notify.js';

export const SECTIONS = Object.freeze([
  ['appearance', 'Appearance'],
  ['notifications', 'Notifications'],
  ['profiles', 'Profiles'],
  ['email', 'Email'],
  ['layout', 'Layout'],
  ['about', 'About'],
]);

const EMAIL = [['birddog', 'In Birddog', 'As plain text in the details panel: no images or tracking pixels load.'], ['web', 'In its web app', 'Gmail or Outlook on the web, at that message.'], ['apple-mail', 'In Apple Mail', 'Opens the message by its Message-ID (macOS).']];

export function navHTML(current) {
  return SECTIONS.map(([id, label]) => `<button role="tab" data-pref-sec="${id}" aria-selected="${id === current}" class="${id === current ? 'on' : ''}">${label}</button>`).join('');
}

/** The body of one section. `s` is what the section needs (prefs, profiles, version…). */
export function sectionHTML(id, s = {}) {
  const p = s.prefs ?? {};
  const check = (key, on, label, help = '') => `<label class="pref-row"><input type="checkbox" data-pref-check="${key}" ${on ? 'checked' : ''}><span><b>${label}</b>${help ? `<small>${help}</small>` : ''}</span></label>`;
  if (id === 'appearance') return `<h3>Appearance</h3><div class="appear-in" id="prefAppear">${appearanceHTML()}</div>`;
  if (id === 'notifications') return '<div id="notifyPanel" class="notify-panel np-in"></div>';
  if (id === 'profiles') {
    const v = s.profiles;
    if (!v) return '<h3>Profiles</h3><div class="msg">Loading…</div>';
    const row = (choice, title, sub) => `<label class="pref-row"><input type="radio" name="prefProfile" data-pref-profile="${esc(choice)}" ${v.choice === choice ? 'checked' : ''}><span><b>${esc(title)}</b><small>${esc(sub)}</small></span></label>`;
    return `<h3>Profiles</h3><p class="pref-help">A profile picks which sources you see and which may notify you. Switch with the profile button in the top bar or <kbd>⇧P</kbd>.</p>
      ${row('auto', 'Auto', v.auto ? `By schedule (now: ${v.name})` : 'By schedule')}
      ${v.list.map((x) => row(x.id, x.name, `${x.sources ? `${x.sources.length} sources` : 'every source'}${x.schedule ? ' · on a schedule' : ''}${x.notify ? '' : ' · silent'}`)).join('')}
      ${row('all', 'All sources', 'No filter')}
      <div class="row-btns"><button class="btn" data-pref-act="edit-profiles">Edit profiles…</button></div>`;
  }
  if (id === 'email') {
    return `<h3>Email</h3><p class="pref-help">Where an email opens when you press <kbd>o</kbd> or its main button. If that app can't open a particular email (a Thunderbird message has no web link), it opens in Birddog.</p>
      ${EMAIL.map(([v, t, h]) => `<label class="pref-row"><input type="radio" name="prefEmail" data-pref-email="${v}" ${(p.emailOpen ?? 'birddog') === v ? 'checked' : ''}><span><b>${t}</b><small>${h}</small></span></label>`).join('')}
      <p class="pref-help">Gmail and Outlook show message text in Birddog only after you set <b>Read message text</b> on their card in <button class="linkish" data-pref-act="setup">Sources &amp; settings</button>. What counts as noise is set per mail source there too.</p>`;
  }
  if (id === 'layout') {
    return `<h3>Layout</h3>
      ${check('railOpen', p.railOpen !== false, 'Show the menu expanded', 'Otherwise it starts as icons only. <kbd>m</kbd> toggles it.')}
      ${check('guideOpen', !!p.guideOpen, 'Open the guide on the right when Birddog starts', '<kbd>g</kbd> opens and closes it; the tab on the right edge does too.')}
      ${check('showNextStep', !p.hideNextStep, 'Show the "next step" card', 'The suggestion above the list, like connecting GitHub.')}
      <div class="pref-row static"><span><b>Sources hidden from the inbox</b><small>${(p.hiddenSources ?? []).length ? esc(p.hiddenSources.join(', ')) : 'None: every source shows.'}</small></span>${(p.hiddenSources ?? []).length ? '<button class="btn small" data-pref-act="show-all">Show all</button>' : ''}</div>`;
  }
  if (id === 'about') {
    return `<h3>About Birddog</h3><p class="pref-help">Version <b>${esc(s.version ?? '…')}</b>. Everything stays on this computer: your settings in <code>config.json</code>, your choices in <code>state.json</code>, tokens in your keychain.</p>
      <div class="row-btns"><a class="btn" href="https://github.com/marcsalot/birddog/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer">What's new ↗</a><a class="btn" href="https://github.com/marcsalot/birddog#readme" target="_blank" rel="noopener noreferrer">README ↗</a><button class="btn" data-pref-act="setup">Sources &amp; settings</button></div>`;
  }
  return '';
}

/**
 * @param {object} o
 * @param {object} o.api
 * @param {() => object} o.prefs        the current prefs (cached by the app)
 * @param {(patch) => void} o.save      save prefs (and update the app's copy)
 * @param {(id) => void} o.action       'edit-profiles' | 'setup' | 'show-all' | 'profile:<choice>' | 'email:<v>' | 'layout:<key>:<bool>'
 */
export function initPrefs({ api, prefs, action }) {
  const scrim = document.getElementById('prefsScrim');
  const nav = document.getElementById('prefsNav');
  const pane = document.getElementById('prefsPane');
  let current = 'appearance';
  let version = null;
  let profiles = null;

  async function render() {
    nav.innerHTML = navHTML(current);
    pane.innerHTML = sectionHTML(current, { prefs: prefs(), profiles, version });
    if (current === 'notifications') await renderNotifySettings();
    if (current === 'profiles' && !profiles) { try { profiles = await api.profiles(); } catch { /* keep loading text */ } if (current === 'profiles') pane.innerHTML = sectionHTML(current, { prefs: prefs(), profiles, version }); }
    if (current === 'about' && !version) { try { version = (await (await fetch('/api/health')).json()).version; } catch { version = 'unknown'; } if (current === 'about') pane.innerHTML = sectionHTML(current, { prefs: prefs(), profiles, version }); }
  }
  const isOpen = () => scrim.classList.contains('open');
  function open(section) {
    if (section && SECTIONS.some(([id]) => id === section)) current = section;
    profiles = null;
    scrim.classList.add('open');
    render();
    setTimeout(() => nav.querySelector('.on')?.focus(), 0);
  }

  nav.addEventListener('click', (e) => { const b = e.target.closest('[data-pref-sec]'); if (b) { current = b.dataset.prefSec; render(); } });
  nav.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const n = SECTIONS.findIndex(([id]) => id === current);
    current = SECTIONS[(n + (e.key === 'ArrowDown' ? 1 : SECTIONS.length - 1)) % SECTIONS.length][0];
    render().then(() => nav.querySelector('.on')?.focus());
  });
  pane.addEventListener('click', async (e) => {
    if (await onNotifyPanelEvent(e)) return;
    const pal = e.target.closest('[data-pal]');
    const mode = e.target.closest('[data-mode]');
    if (pal) { setPalette(pal.dataset.pal); return render(); }
    if (mode) { setMode(mode.dataset.mode); return render(); }
    const a = e.target.closest('[data-pref-act]');
    if (a) action(a.dataset.prefAct);
  });
  pane.addEventListener('change', async (e) => {
    if (await onNotifyPanelEvent(e)) return;
    const t = e.target;
    if (t.dataset.prefProfile) { action(`profile:${t.dataset.prefProfile}`); profiles = null; setTimeout(render, 200); }
    else if (t.dataset.prefEmail) action(`email:${t.dataset.prefEmail}`);
    else if (t.dataset.prefCheck) action(`layout:${t.dataset.prefCheck}:${t.checked}`);
  });
  return { open, isOpen, render };
}
