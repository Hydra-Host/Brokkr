(function () {
  try {
    let theme = localStorage.getItem('brokkr-theme');
    const legacy = { violet: 'hydra-dark', 'atom-light': 'hydra-light', cyan: 'hydra-dark' };
    if (theme && legacy[theme]) {
      theme = legacy[theme];
      localStorage.setItem('brokkr-theme', theme);
    }
    if (theme && ['hydra-dark', 'yellow', 'blue', 'green', 'pink', 'hydra-light', 'solarized-light'].includes(theme)) {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch {
    // Theme initialization must never block first paint.
  }
})();
