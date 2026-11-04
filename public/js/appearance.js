// Themes: three palettes × light / dark / system. Saved on the server (so they
// survive a port change) and mirrored to localStorage (so boot.js paints right).

export const PALETTES = ['gold', 'violet', 'sunset'];
export const PALETTE_NAMES = { gold: 'Retriever gold', violet: 'Electric violet', sunset: 'Sunset' };
const FAVICON = {
  gold: ['#f5b700', '#17171a'],
  violet: ['#7c5cff', '#ffffff'],
  sunset: ['#ff7a59', '#ffffff'],
};

const root = document.documentElement;
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
let mode = 'system';
let onSave = () => {};
let onChange = () => {};

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

function favicon(palette) {
  const [pin, paw] = FAVICON[palette] ?? FAVICON.gold;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 5C20.4 5 12 13.8 12 25c0 14.5 20 34 20 34s20-19.5 20-34C52 13.8 43.6 5 32 5z" fill="${pin}"/><g fill="${paw}"><ellipse cx="32" cy="30" rx="7.2" ry="6.2"/><circle cx="23.4" cy="22.6" r="3.2"/><circle cx="28.6" cy="16.6" r="3.3"/><circle cx="35.4" cy="16.6" r="3.3"/><circle cx="40.6" cy="22.6" r="3.2"/></g></svg>`;
  const link = document.getElementById('favicon');
  if (link) link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function applyMode() {
  root.dataset.theme = mode === 'system' ? (darkMQ.matches ? 'dark' : 'light') : mode;
  onChange();
}

export function initAppearance({ prefs, save, changed }) {
  onSave = save;
  onChange = changed;
  darkMQ.addEventListener('change', () => { if (mode === 'system') applyMode(); });
  setPalette(prefs.palette ?? root.dataset.palette ?? 'gold', false);
  setMode(prefs.mode ?? 'system', false);
}

export const currentPalette = () => root.dataset.palette;
export const currentMode = () => mode;

export function setPalette(p, persist = true) {
  if (!PALETTES.includes(p)) p = 'gold';
  root.dataset.palette = p;
  store('birddogPalette', p);
  favicon(p);
  if (persist) onSave({ palette: p });
  onChange();
}

export function cyclePalette() {
  setPalette(PALETTES[(PALETTES.indexOf(currentPalette()) + 1) % PALETTES.length]);
  return PALETTE_NAMES[currentPalette()];
}

export function setMode(m, persist = true) {
  if (!['light', 'dark', 'system'].includes(m)) m = 'system';
  mode = m;
  store('birddogMode', m);
  if (persist) onSave({ mode: m });
  applyMode();
}

export function toggleTheme() {
  setMode(root.dataset.theme === 'dark' ? 'light' : 'dark');
  return root.dataset.theme;
}

export function appearanceHTML() {
  const cur = currentPalette();
  const th = root.dataset.theme;
  return `<div class="ap-h">Theme</div><div class="ap-themes">${PALETTES.map((p) => `<button data-pal="${p}" class="${p === cur ? 'on' : ''}" aria-pressed="${p === cur}"><div class="mini" data-palette="${p}" data-theme="${th}"><div class="side"><svg viewBox="0 0 64 64"><use href="#pin"/></svg></div><div class="main"><div class="r"></div><div class="r sel"></div><div class="r"></div><div class="b"></div></div></div><span>${PALETTE_NAMES[p]}</span></button>`).join('')}</div>
  <div class="ap-h">Mode</div><div class="seg">${['light', 'dark', 'system'].map((m) => `<button data-mode="${m}" class="${m === mode ? 'on' : ''}" aria-pressed="${m === mode}">${{ light: '☀ Light', dark: '☾ Dark', system: '◐ System' }[m]}</button>`).join('')}</div>
  <div class="ap-foot"><span><kbd>p</kbd> next theme</span><span><kbd>t</kbd> light / dark</span></div>`;
}
