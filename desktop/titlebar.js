// Injected by the native shell into its trusted documents; never loaded by a browser.
(() => {
  const markDesktop = () => document.documentElement.setAttribute('data-nootify-desktop', window.__NOOTIFY_PLATFORM__ || 'macos');
  if (document.documentElement) markDesktop();
  else document.addEventListener('DOMContentLoaded', markDesktop, { once: true });

  document.addEventListener('mousedown', event => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (!event.target.closest('.titlebar, .brand-row, .topbar')) return;
    if (event.target.closest('a, button, input, select, textarea, label, [role="button"]')) return;
    event.preventDefault();
    location.href = `nootify://window/${event.detail === 2 ? 'zoom' : 'drag'}`;
  });
})();
