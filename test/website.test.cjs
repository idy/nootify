"use strict";

const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const site = join(__dirname, "../site");
const html = readFileSync(join(site, "index.html"), "utf8");
const repo = "https://github.com/idy/nootify";

function release({ prerelease = false, assets } = {}) {
  const tag = prerelease ? "v2.0.0-preview.1" : "v2.0.0";
  const makeAsset = name => ({ name, state: "uploaded", size: 45989596, browser_download_url: `${repo}/releases/download/${tag}/${name}` });
  return { tag_name: tag, prerelease, draft: false, published_at: "2026-11-04T00:00:00Z", html_url: `${repo}/releases/tag/${tag}`,
    assets: assets || [makeAsset("Nootify_2.0.0_x86_64.dmg"), makeAsset("Nootify_aarch64.app.tar.gz"), makeAsset("Nootify_2.0.0_aarch64.dmg")] };
}
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

async function render(fetcher, platform = "MacIntel") {
  const fields = {};
  for (const name of ["download", "download-other", "release-link", "release-stage", "release-version", "release-file", "release-status"]) {
    fields[`[data-${name}]`] = Array.from({ length: name === "download" ? 2 : 1 }, () => ({ href: `${repo}/releases`, textContent: "", hidden: false }));
  }
  const textNodes = [];
  const htmlNodes = [];
  for (const match of html.matchAll(/<([a-z0-9]+)\b[^>]*\bdata-i18n(-html)?="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const node = { dataset: {}, textContent: match[4].replace(/<[^>]*>/g, ""), innerHTML: match[4] };
    node.dataset[match[2] ? "i18nHtml" : "i18n"] = match[3];
    (match[2] ? htmlNodes : textNodes).push(node);
  }
  fields["[data-i18n]"] = textNodes;
  fields["[data-i18n-html]"] = htmlNodes;
  fields["[data-i18n-aria-label]"] = Array.from(html.matchAll(/<[^>]+\baria-label="([^"]+)"[^>]+\bdata-i18n-aria-label="([^"]+)"/g), match => {
    const attributes = { "aria-label": match[1], "data-i18n-aria-label": match[2] };
    return { getAttribute: name => attributes[name], setAttribute: (name, value) => { attributes[name] = value; } };
  });
  const listeners = new Map();
  const events = {};
  const context = {
    document: {
      documentElement: { dataset: {}, style: {} },
      querySelector: () => null,
      querySelectorAll: selector => fields[selector] || [],
      addEventListener(type, callback) { listeners.set(type, [...(listeners.get(type) || []), callback]); },
      dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); },
    },
    navigator: { languages: ["en-US"], platform },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener: (type, callback) => { events[type] = callback; },
    CustomEvent: class { constructor(type) { this.type = type; } },
    AbortController, setTimeout, clearTimeout, fetch: fetcher,
  };
  context.window = context;
  context.document.defaultView = context;
  vm.createContext(context);
  for (const file of ["shared/sdk/idy-site.min.js", "translations.js"]) vm.runInContext(readFileSync(join(site, file), "utf8"), context);
  await vm.runInContext(readFileSync(join(site, "script.js"), "utf8"), context);
  return { context, fields, node: name => fields[`[data-${name}]`][0], language(value) { events.storage({ key: "idy-language", newValue: value }); } };
}

test("uses the release's Apple Silicon DMG rather than Intel or updater archives", async () => {
  const selected = release();
  const page = await render(async url => {
    assert.equal(url, "https://api.github.com/repos/idy/nootify/releases/latest");
    return response(selected);
  });
  for (const link of page.fields["[data-download]"]) assert.equal(link.href, selected.assets[2].browser_download_url);
  assert.equal(page.node("release-version").textContent, selected.tag_name);
  assert.equal(page.node("release-link").href, selected.html_url);
  assert.match(page.node("release-file").textContent, /aarch64\.dmg \(46\.0 MB\)/);
});

test("supports preview-only releases and preserves their label and URL", async () => {
  const selected = release({ prerelease: true });
  const page = await render(async url => url.endsWith("/latest") ? response({}, 404) : response([selected]));
  assert.equal(page.node("release-stage").textContent, "Preview release");
  assert.equal(page.node("download").href, selected.assets[2].browser_download_url);
});

test("missing or incomplete ARM installers keep a truthful release-page fallback", async () => {
  for (const assets of [[], [release().assets[0]], [{ ...release().assets[2], state: "new" }], [{ ...release().assets[2], browser_download_url: "https://example.com/wrong.dmg" }]]) {
    const selected = release({ assets });
    const page = await render(async () => response(selected));
    assert.equal(page.node("download").href, selected.html_url);
    assert.equal(page.node("download").textContent, "Browse releases");
    assert.equal(page.node("release-file").hidden, true);
    assert.match(page.node("release-status").textContent, /no Apple Silicon DMG/);
  }
});

test("network errors and rate limits keep usable links and no claimed version", async () => {
  for (const fetcher of [async () => response({}, 403), async () => { throw new Error("offline"); }]) {
    const page = await render(fetcher);
    assert.equal(page.node("download").href, `${repo}/releases`);
    assert.equal(page.node("release-version").hidden, true);
    assert.match(page.node("release-status").textContent, /unavailable/);
    page.language("zh");
    assert.match(page.node("release-status").textContent, /暂时无法获取/);
  }
});

test("Chinese switching translates the page while preserving live download details", async () => {
  const selected = release();
  const page = await render(async () => response(selected));
  page.language("zh");
  assert.equal(page.context.document.documentElement.lang, "zh-CN");
  assert.equal(page.node("download").textContent, "下载 Apple Silicon 版");
  assert.equal(page.node("download").href, selected.assets[2].browser_download_url);
  assert.equal(page.node("release-version").textContent, selected.tag_name);
  for (const node of [...page.fields["[data-i18n]"], ...page.fields["[data-i18n-html]"]]) {
    const key = node.dataset.i18n || node.dataset.i18nHtml;
    assert.notEqual(page.context.IdySite.t(key), key, `Missing translation: ${key}`);
  }
});

test("static links have no pinned release and all website assets exist", () => {
  assert.doesNotMatch(html, /github\.com\/idy\/nootify\/releases\/(?:tag|download)\//);
  assert.match(html, /ad-hoc signed and not notarized/);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const path = match[1];
    if (!path.includes(":") && !path.startsWith("#")) assert.ok(existsSync(join(site, path)), path);
  }
});

test("mobile navigation retains every desktop link without JavaScript", () => {
  const links = className => {
    const nav = html.match(new RegExp(`<nav class="${className}"[^>]*>([\\s\\S]*?)<\\/nav>`));
    assert.ok(nav, `${className} navigation`);
    return Array.from(nav[1].matchAll(/<a href="([^"]+)"(?: data-i18n="([^"]+)")?/g), match => [match[1], match[2] || null]);
  };
  assert.deepEqual(links("idy-mobile-panel"), links("idy-nav"));
  assert.match(html, /<details class="idy-mobile">\s*<summary aria-label="Main navigation"/);
  assert.match(html, /<select data-idy-language>/);
  assert.match(html, /<select data-idy-theme>/);
  assert.match(html, /class="idy-action" href="https:\/\/github\.com\/idy\/nootify"[^>]*target="_blank"[^>]*data-i18n-aria-label="starLabel"/);
});

test("header navigation and repository action have bilingual accessible labels", async () => {
  const page = await render(async () => response(release()));
  const labels = page.fields["[data-i18n-aria-label]"];
  const star = labels.find(node => node.getAttribute("data-i18n-aria-label") === "starLabel");
  const navigation = labels.filter(node => node.getAttribute("data-i18n-aria-label") === "navigation");
  assert.equal(star.getAttribute("aria-label"), "Star Nootify on GitHub (opens in a new tab)");
  assert.equal(navigation.length, 3);
  page.language("zh");
  assert.equal(star.getAttribute("aria-label"), "star — 在 GitHub 为 Nootify 点星（在新标签页打开）");
  assert.ok(navigation.every(node => node.getAttribute("aria-label") === "主导航"));
  page.language("en");
  assert.equal(star.getAttribute("aria-label"), "Star Nootify on GitHub (opens in a new tab)");
});

test("Windows selects the x64 installer, with Apple Silicon still directly available", async () => {
  const selected = release();
  const exe = { name: "Nootify_2.0.0_x64-setup.exe", state: "uploaded", size: 12000000,
    browser_download_url: `${repo}/releases/download/v2.0.0/Nootify_2.0.0_x64-setup.exe` };
  selected.assets.push({ ...exe, name: "Nootify_2.0.0_arm64-setup.exe" },
    { ...exe, name: "Nootify_2.0.0_x64-setup.exe.zip" }, exe);
  const page = await render(async () => response(selected), "Win32");
  assert.equal(page.node("download").href, exe.browser_download_url);
  assert.equal(page.node("download").textContent, "Download for Windows x64");
  assert.equal(page.node("download-other").href, selected.assets[2].browser_download_url);
  assert.match(page.node("release-file").textContent, /x64-setup\.exe \(12\.0 MB\)/);
  page.language("zh");
  assert.equal(page.node("download").textContent, "下载 Windows x64 版");
  assert.equal(page.node("download-other").textContent, "下载 Apple Silicon 版");
});

test("a missing Windows installer never silently downloads a Mac installer", async () => {
  const selected = release();
  const page = await render(async () => response(selected), "Win32");
  assert.equal(page.node("download").href, selected.html_url);
  assert.equal(page.node("download").textContent, "Browse releases");
  assert.match(page.node("release-status").textContent, /no Windows x64 installer/);
  assert.equal(page.node("release-file").hidden, true);
  assert.equal(page.node("download-other").href, selected.assets[2].browser_download_url);
});

test("Mac visitors can directly select a verified Windows installer", async () => {
  const selected = release();
  const exe = { name: "Nootify_2.0.0_x64-setup.exe", state: "uploaded", size: 12000000,
    browser_download_url: `${repo}/releases/download/v2.0.0/Nootify_2.0.0_x64-setup.exe` };
  selected.assets.push(exe);
  const page = await render(async () => response(selected));
  assert.equal(page.node("download").href, selected.assets[2].browser_download_url);
  assert.equal(page.node("download-other").href, exe.browser_download_url);
  assert.equal(page.node("download-other").textContent, "Download for Windows x64");
});
