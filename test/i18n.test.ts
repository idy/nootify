import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { english, isPreference, resolveLocale, translate } from '../src/ui-i18n.js';

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test('language preferences resolve supported system languages and fall back to English', () => {
  assert.equal(resolveLocale('system', ['zh-Hans-CN', 'en-US']), 'zh-CN');
  assert.equal(resolveLocale('system', ['en-GB', 'zh-CN']), 'en');
  assert.equal(resolveLocale('system', ['fr-FR', 'zh-TW']), 'zh-CN');
  assert.equal(resolveLocale('system', ['ZH_cn']), 'zh-CN');
  assert.equal(resolveLocale('system', ['fr-FR']), 'en');
  assert.equal(resolveLocale('system', []), 'en');
  assert.equal(resolveLocale('en', ['zh-CN']), 'en');
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale('system', ['zhang', 'enigma']), 'en');
  for (const value of ['system', 'en', 'zh-CN']) assert.equal(isPreference(value), true);
  for (const value of [null, undefined, '', 'fr', 'zh', {}, 'en<script>']) assert.equal(isPreference(value), false);
});

test('every English translation preserves all source interpolation parameters', () => {
  for (const [source, translation] of Object.entries(english)) {
    assert.ok(translation.trim().length > 0, `Empty translation: ${source}`);
    assert.deepEqual(placeholders(translation), placeholders(source), source);
  }
});

test('interpolation preserves user content without interpreting HTML, placeholders or replacement patterns', () => {
  const value = '<img src=x onerror=alert(1)> $& {p1} 中文 👋';
  assert.equal(translate('en', '关注 {p0}', { p0: value }), `Follow ${value}`);
  assert.equal(translate('zh-CN', '关注 {p0}', { p0: value }), `关注 ${value}`);
  assert.equal(translate('en', '{p0} 个 PR', { p0: 0 }), 'PRs: 0');
  assert.equal(translate('en', '关注 {p0}'), 'Follow {p0}');
  assert.equal(translate('en', '关注 {p0}', Object.create({ p0: 'inherited' }) as Record<string, unknown>), 'Follow {p0}');
});

test('all marked static UI messages and dynamic translation keys have a catalog entry', async () => {
  const page = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  for (const match of page.matchAll(/data-i18n(?:-title|-aria-label|-placeholder|-alt)?="([^"]+)"/g)) {
    const key = match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    assert.ok(Object.hasOwn(english, key), `Missing static translation: ${key}`);
  }
  const script = await readFile(new URL('../../src/ui-app.ts', import.meta.url), 'utf8');
  for (const match of script.matchAll(/\bt\('([^']+)'/g)) assert.ok(Object.hasOwn(english, match[1]), `Missing dynamic translation: ${match[1]}`);
  assert.match(page, /<select[^>]+id="language"/);
  assert.match(page, /data-view="settings-general"/);
});

test('saved preferences override browser defaults; native preferences override browser storage', async t => {
  const originals = new Map(['window', 'navigator', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  const saved = new Map([['nootify-language', 'zh-CN']]);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['en-US'], language: 'en-US' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => saved.get(key), setItem: (key: string, value: string) => saved.set(key, value) } });
  const browser = await import(new URL('../src/ui-i18n.js?stored', import.meta.url).href) as typeof import('../src/ui-i18n.js');
  assert.equal(browser.languagePreference(), 'zh-CN');
  assert.equal(browser.locale(), 'zh-CN');
  browser.setLanguage('en');
  assert.equal(saved.get('nootify-language'), 'en');
  assert.equal(browser.t('运行日志'), 'Logs');
  saved.set('nootify-language', 'zh-CN');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __NOOTIFY_LANGUAGE__: { preference: 'system', locale: 'en' } } });
  const native = await import(new URL('../src/ui-i18n.js?native', import.meta.url).href) as typeof import('../src/ui-i18n.js');
  assert.equal(native.languagePreference(), 'system');
  assert.equal(native.locale(), 'en');
  native.setLanguage('system', { preference: 'system', locale: 'zh-CN' });
  assert.equal(native.locale(), 'zh-CN');
});

test('blocked or invalid browser storage still permits language switching', async t => {
  const originals = new Map(['window', 'navigator', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['zh-CN'], language: 'zh-CN' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'invalid', setItem: () => { throw new Error('Storage blocked'); } } });
  const invalid = await import(new URL('../src/ui-i18n.js?invalid', import.meta.url).href) as typeof import('../src/ui-i18n.js');
  assert.equal(invalid.languagePreference(), 'system');
  assert.equal(invalid.locale(), 'zh-CN');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  const blocked = await import(new URL('../src/ui-i18n.js?blocked', import.meta.url).href) as typeof import('../src/ui-i18n.js');
  assert.equal(blocked.languagePreference(), 'system');
  blocked.setLanguage('en');
  assert.equal(blocked.locale(), 'en');
  assert.equal(blocked.t('运行日志'), 'Logs');
});
