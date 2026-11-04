// Runs before first paint so the page never flashes the wrong theme.
// app.js later syncs these with the preferences saved on the server.
(function () {
  var d = document.documentElement, palette = 'gold', mode = 'system';
  try {
    palette = localStorage.getItem('birddogPalette') || palette;
    mode = localStorage.getItem('birddogMode') || mode;
  } catch (e) { /* storage blocked */ }
  d.dataset.palette = palette;
  d.dataset.theme = mode === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
})();
