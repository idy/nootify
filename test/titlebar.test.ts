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
  runInNewContext(script, { window, document, Element: window.Element, location });
  assert.equal(document.documentElement.getAttribute('data-nootify-desktop'), 'macos');
  const down = (selector: string, detail = 1, button = 0) => {
    const target = document.querySelector(selector);
    assert.ok(target, selector);
    const event = new window.Event('mousedown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { button: { value: button }, detail: { value: detail } });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  for (const selector of ['#logs-actions .search', '#logs-actions .search svg', '#search', '#pause', '#pause-icon', '#export', '#export svg', '#pull-actions .search', '#pull-actions .search svg', '#pull-search', '#pull-sort', '#pull-sort-icon', '#repo-actions .search', '#repo-search', '.search-toggle', '.search-toggle svg', '#refresh', '.brand']) {
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
