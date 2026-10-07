// Track AA: runs in <head>, before anything is drawn. VYSTRAL hands over the last Home snapshot before any
// script runs (globalThis.__vystralFirstPaint); its theme goes on <html> now, so even the very first frame has
// the right background. Plain ES5, no imports; any problem simply leaves the default (dark) theme.
(function () {
  try {
    var fp = globalThis.__vystralFirstPaint;
    if (!fp && !(window.chrome && window.chrome.webview) && /[?&]firstpaint(=|&|$)/.test(location.search)) {
      // Browser preview only (?firstpaint): the snapshot lives in localStorage there.
      fp = JSON.parse(localStorage.getItem('vystral.preview.firstPaint') || 'null');
    }
    var theme = fp && fp.appearance && fp.appearance.theme;
    if (theme === 'obsidian' || theme === 'oled' || theme === 'light' || theme === 'contrast') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (e) {
    // the interface decides the theme a moment later
  }
})();
