/* Pre-paint theme bootstrap. Canonical in packages/ui (app copies byte-identical); external for CSP.
   Per-app first-visit defaults come from the script tag's data-default-{style,color,mode}. */
(function () {
  try {
    var doc = document.documentElement;
    var script = document.currentScript;
    var defaults = (script && script.dataset) || {};

    var LEGACY = {
      'hydra-dark': ['retro', 'violet', 'dark'],
      violet: ['retro', 'violet', 'dark'],
      cyan: ['retro', 'violet', 'dark'],
      yellow: ['retro', 'gold', 'dark'],
      blue: ['retro', 'blue', 'dark'],
      green: ['retro', 'green', 'dark'],
      pink: ['retro', 'pink', 'dark'],
      'hydra-light': ['retro', 'violet', 'light'],
      'atom-light': ['retro', 'violet', 'light'],
      'solarized-light': ['retro', 'violet', 'light'],
      'commerce-dark': ['modern', 'violet', 'dark'],
      'commerce-light': ['modern', 'violet', 'light'],
    };

    function valid(value, allowed) {
      return value && allowed.indexOf(value) !== -1 ? value : null;
    }

    var STYLES = ['retro', 'modern'];
    var COLORS = ['violet', 'blue', 'green', 'pink', 'gold'];
    var MODES = ['dark', 'light', 'system'];

    var style = valid(localStorage.getItem('brokkr-style'), STYLES);
    var color = valid(localStorage.getItem('brokkr-color'), COLORS);
    var mode = valid(localStorage.getItem('brokkr-mode'), MODES);

    if (!style && !color && !mode) {
      /* Translate pre-axis storage; the ThemeProvider owns the actual
         migration and key cleanup — never write storage here. */
      var stored = localStorage.getItem('brokkr-theme');
      var preferredKey = window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'brokkr-preferred-light'
        : 'brokkr-preferred-dark';
      var legacyTheme = stored === 'system' ? localStorage.getItem(preferredKey) || 'hydra-dark' : stored;
      var axes = legacyTheme && LEGACY[legacyTheme];
      if (axes) {
        style = axes[0];
        color = axes[1];
        mode = stored === 'system' ? 'system' : axes[2];
      }
    }

    style = style || defaults.defaultStyle || 'retro';
    color = color || defaults.defaultColor || 'violet';
    mode = mode || defaults.defaultMode || 'dark';
    if (mode === 'system') {
      mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }

    doc.setAttribute('data-style', style);
    doc.setAttribute('data-color', color);
    doc.setAttribute('data-mode', mode);
    doc.removeAttribute('data-preset');
    doc.removeAttribute('data-theme');
  } catch (error) {
    void error;
  }
})();
