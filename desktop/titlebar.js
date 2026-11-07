// Injected by the native shell into its trusted documents; never loaded by a browser.
(() => {
  const platform = window.__NOOTIFY_PLATFORM__;
  if (platform !== 'macos' && platform !== 'windows') return;
  const markDesktop = () => {
    document.documentElement.setAttribute('data-nootify-desktop', platform);
    document.documentElement.setAttribute('data-nootify-window-controls', platform);
  };
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
