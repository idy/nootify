/* Shared by the idy.dev sites. Keep this file and idy.css in sync. */
(() => {
  "use strict";

  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const read = (key, fallback) => {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  };
  const save = (key, value) => {
    try { localStorage.setItem(key, value); } catch { /* Preferences still work for this visit. */ }
  };
  let languagePreference = read("idy-language", "auto");
  let themePreference = read("idy-theme", "system");
  if (!["auto", "en", "zh"].includes(languagePreference)) languagePreference = "auto";
  if (!["system", "light", "dark"].includes(themePreference)) themePreference = "system";

  const dictionaries = {
    en: {
      language: "Language", theme: "Theme", automatic: "Auto", system: "System",
      light: "Light", dark: "Dark", source: "Source", releases: "Releases",
      allProjects: "All projects", footerNote: "Independent tools. Open source.",
      skipContent: "Skip to content", navigation: "Main navigation", projectLinks: "Project links",
      loadingRelease: "Checking the latest release…", releaseUnavailable: "Release information is unavailable. Browse GitHub Releases for downloads.",
      stableRelease: "Stable release", previewRelease: "Preview release", viewRelease: "View release",
    },
    zh: {
      language: "语言", theme: "主题", automatic: "自动", system: "跟随系统",
      light: "浅色", dark: "深色", source: "源代码", releases: "发布版本",
      allProjects: "所有项目", footerNote: "独立开发，开放源代码。",
      skipContent: "跳转到正文", navigation: "主导航", projectLinks: "项目链接",
      loadingRelease: "正在获取最新版本…", releaseUnavailable: "暂时无法获取版本信息，请前往 GitHub Releases 下载。",
      stableRelease: "稳定版", previewRelease: "预发布版", viewRelease: "查看发布版本",
    },
  };

  function browserLanguage() {
    for (const locale of navigator.languages || [navigator.language || "en"]) {
      const primary = locale.toLowerCase().split(/[-_]/)[0];
      if (primary === "zh" || primary === "en") return primary;
    }
    return "en";
  }

  let language = languagePreference === "auto" ? browserLanguage() : languagePreference;
  function applyTheme() {
    const theme = themePreference === "system" ? (media.matches ? "dark" : "light") : themePreference;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#142033" : "#f7f9fc");
  }
  function t(key) { return dictionaries[language][key] ?? dictionaries.en[key] ?? key; }
  function translate() {
    root.lang = language === "zh" ? "zh-CN" : "en";
    document.querySelectorAll("[data-i18n]").forEach(node => { node.textContent = t(node.dataset.i18n); });
    // Only authored, local translations use HTML; release data is never passed here.
    document.querySelectorAll("[data-i18n-html]").forEach(node => { node.innerHTML = t(node.dataset.i18nHtml); });
    for (const attribute of ["aria-label", "title", "alt"]) {
      document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(node => {
        node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
      });
    }
    if (dictionaries[language].pageTitle) document.title = t("pageTitle");
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) {
      if (dictionaries[language].pageDescription) document.querySelector(selector)?.setAttribute("content", t("pageDescription"));
    }
    if (dictionaries[language].pageTitle) document.querySelector('meta[property="og:title"]')?.setAttribute("content", t("pageTitle"));
    document.querySelectorAll("[data-idy-language]").forEach(select => { select.value = languagePreference; });
    document.querySelectorAll("[data-idy-theme]").forEach(select => { select.value = themePreference; });
    document.dispatchEvent(new CustomEvent("idy:languagechange", { detail: { language } }));
  }

  // Set preferences before the first stylesheet paints the page.
  root.lang = language === "zh" ? "zh-CN" : "en";
  applyTheme();
  media.addEventListener("change", applyTheme);
  window.addEventListener("languagechange", () => {
    if (languagePreference === "auto") { language = browserLanguage(); translate(); }
  });
  window.addEventListener("storage", event => {
    if (event.key === "idy-theme") {
      themePreference = ["light", "dark"].includes(event.newValue) ? event.newValue : "system";
      applyTheme(); translate();
    }
    if (event.key === "idy-language") {
      languagePreference = ["en", "zh"].includes(event.newValue) ? event.newValue : "auto";
      language = languagePreference === "auto" ? browserLanguage() : languagePreference;
      translate();
    }
  });

  async function loadRelease(repository) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const request = path => fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Accept: "application/vnd.github+json" }, credentials: "omit", signal: controller.signal,
    });
    const valid = release => release && !release.draft && typeof release.tag_name === "string" &&
      release.tag_name.length > 0 && Array.isArray(release.assets) &&
      typeof release.html_url === "string" && release.html_url.startsWith(`https://github.com/${repository}/releases/tag/`);
    try {
      let response = await request("releases/latest");
      if (response.status === 404) {
        response = await request("releases?per_page=100");
        if (!response.ok) throw new Error(`Releases: ${response.status}`);
        const releases = await response.json();
        if (!Array.isArray(releases)) throw new Error("Invalid release list");
        const published = releases.filter(valid).filter(release => Number.isFinite(Date.parse(release.published_at)))
          .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
        const release = published.find(item => !item.prerelease) || published[0];
        if (!release) throw new Error("No published releases");
        return release;
      }
      if (!response.ok) throw new Error(`Releases: ${response.status}`);
      const release = await response.json();
      if (!valid(release)) throw new Error("Invalid release");
      return release;
    } finally {
      clearTimeout(timeout);
    }
  }

  function asset(release, pattern) {
    const repositoryUrl = release.html_url?.split("/releases/")[0];
    if (!repositoryUrl?.startsWith("https://github.com/")) return undefined;
    const prefix = `${repositoryUrl}/releases/download/${encodeURIComponent(release.tag_name)}/`;
    return release.assets?.find(item => {
      pattern.lastIndex = 0;
      return item && item.state === "uploaded" && item.size > 0 && typeof item.name === "string" &&
        pattern.test(item.name) && item.browser_download_url === prefix + encodeURIComponent(item.name);
    });
  }

  window.IdySite = {
    get language() { return language; },
    t, loadRelease, asset,
    init(translations = {}) {
      for (const locale of ["en", "zh"]) Object.assign(dictionaries[locale], translations[locale]);
      translate();
    },
  };
  document.addEventListener("DOMContentLoaded", () => {
    for (const select of document.querySelectorAll("[data-idy-language]")) {
      select.addEventListener("change", () => {
        languagePreference = ["en", "zh"].includes(select.value) ? select.value : "auto";
        save("idy-language", languagePreference);
        language = languagePreference === "auto" ? browserLanguage() : languagePreference;
        translate();
      });
    }
    for (const select of document.querySelectorAll("[data-idy-theme]")) {
      select.addEventListener("change", () => {
        themePreference = ["light", "dark"].includes(select.value) ? select.value : "system";
        save("idy-theme", themePreference);
        applyTheme();
      });
    }
    applyTheme(); translate();
  });
})();
