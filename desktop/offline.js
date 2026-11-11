// The native shell injects this at document start so offline copy starts in the app's language.
// A regular browser loads the same file directly, without native state or persistent preferences.
(() => {
  const bundled = (location.protocol === 'tauri:' && location.hostname === 'localhost')
    || (location.protocol === 'http:' && location.hostname === 'tauri.localhost' && !location.port);
  if (!bundled && !document.currentScript?.src.endsWith('/offline.js')) return;
  if (window.__nootifyOfflineLanguageReady) return;
  window.__nootifyOfflineLanguageReady = true;

  const copy = {
    en: {
      title: 'Nootify · Waiting for Service',
      local: 'Local service',
      heading: 'Waiting for the local service',
      lead: 'The background service is being prepared automatically. Your run logs will appear once it connects.',
      setup: 'On first launch, the service installs and starts automatically. Later launches connect directly, with no extra steps.',
      recovery: 'If the connection takes too long, quit and reopen Nootify to retry automatically.',
      footnote: 'You can reopen this window from the tray menu at any time. Quitting the desktop app keeps the service running.',
      polling: 'Checking the connection every 3 seconds',
    },
    'zh-CN': {
      title: 'Nootify · 等待服务',
      local: '本机服务',
      heading: '正在等待本机服务',
      lead: '正在自动准备后台服务，连接后会直接显示运行日志。',
      setup: '首次打开会自动安装并启动服务，之后打开会直接连接，无需额外操作。',
      recovery: '若长时间未连接，请退出后重新打开 Nootify，应用会自动重试。',
      footnote: '关闭此窗口后，可随时从托盘菜单重新打开。退出桌面应用不会停止服务。',
      polling: '每 3 秒自动检查连接',
    },
  };
  const valid = state => state && ['system', 'zh-CN', 'en'].includes(state.preference)
    && ['zh-CN', 'en'].includes(state.locale);
  const browserLocale = () => {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const language of languages) {
      if (/^zh(?:-|_|$)/i.test(language)) return 'zh-CN';
      if (/^en(?:-|_|$)/i.test(language)) return 'en';
    }
    return 'en';
  };
  let locale = valid(window.__NOOTIFY_LANGUAGE__) ? window.__NOOTIFY_LANGUAGE__.locale : browserLocale();
  const render = () => {
    if (!document.documentElement) return;
    document.documentElement.lang = locale;
    document.title = copy[locale].title;
    for (const node of document.querySelectorAll('[data-offline-copy]')) {
      const text = copy[locale][node.dataset.offlineCopy];
      if (text !== undefined) node.textContent = text;
    }
  };
  render();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
  window.addEventListener('nootify-language', event => {
    if (!valid(event.detail)) return;
    locale = event.detail.locale;
    render();
  });
  window.addEventListener('languagechange', () => {
    if (valid(window.__NOOTIFY_LANGUAGE__)) return;
    locale = browserLocale();
    render();
  });
})();
