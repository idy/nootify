import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';

test('native titlebar leaves page controls interactive and drags only non-interactive space', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../desktop/titlebar.js', import.meta.url), 'utf8'),
  ]);
  const { window, document } = parseHTML(html);
  const origin = 'http://127.0.0.1:9417/';
  const location = { href: origin };
  runInNewContext(script, { window: { __NOOTIFY_PLATFORM__: 'macos' }, document, Element: window.Element, location });
  assert.equal(document.documentElement.getAttribute('data-nootify-desktop'), 'macos');
  const down = (selector: string, detail = 1, button = 0) => {
    const target = document.querySelector(selector);
    assert.ok(target, selector);
    const event = new window.Event('mousedown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { button: { value: button }, detail: { value: detail } });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  for (const selector of ['#logs-view .logs-search', '#logs-view .logs-search svg', '#search', '#pause', '#pause-icon', '#export', '#export svg', '#refresh', '.brand']) {
    assert.equal(down(selector), false, selector);
    assert.equal(down(selector, 2), false, `${selector} double-click`);
    assert.equal(location.href, origin, `${selector} must not move the window`);
  }
  assert.equal(down('.titlebar', 1, 2), false);
  assert.equal(location.href, origin);
  assert.equal(down('.titlebar'), true);
  assert.equal(location.href, 'nootify://window/drag');
  assert.equal(down('.titlebar', 2), true);
  assert.equal(location.href, 'nootify://window/zoom');
});

test('window control spacing is marked only by an explicit native host', async t => {
  const script = await readFile(new URL('../../desktop/titlebar.js', import.meta.url), 'utf8');
  for (const platform of [undefined, 'macos', 'windows']) {
    await t.test(platform ?? 'desktop-layout browser preview', () => {
      const { window, document } = parseHTML('<html><body><header class="brand-row">Nootify</header></body></html>');
      // A preview can use desktop layout without native caption buttons.
      document.documentElement.setAttribute('data-nootify-desktop', 'macos');
      const location = { href: 'http://127.0.0.1:9417/' };
      runInNewContext(script, { window: { __NOOTIFY_PLATFORM__: platform }, document, Element: window.Element, location });
      assert.equal(document.documentElement.getAttribute('data-nootify-window-controls'), platform ?? null);
      if (platform) assert.equal(document.documentElement.getAttribute('data-nootify-desktop'), platform);
      const event = new window.Event('mousedown', { bubbles: true, cancelable: true });
      Object.defineProperties(event, { button: { value: 0 }, detail: { value: 1 } });
      document.querySelector('.brand-row')!.dispatchEvent(event);
      assert.equal(event.defaultPrevented, !!platform);
      assert.equal(location.href, platform ? 'nootify://window/drag' : 'http://127.0.0.1:9417/');
    });
  }
});
