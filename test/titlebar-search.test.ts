import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

test('collapsed titlebar searches handle macOS blur before toggle click and preserve dismissal paths', async t => {
  const { window, document } = parseHTML(await readFile(new URL('../../public/index.html', import.meta.url), 'utf8'));
  let focused: HTMLElement | null = null;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  t.mock.method(window.HTMLElement.prototype, 'focus', function (this: HTMLElement) { focused = this; });
  const globals: Record<string, unknown> = {
    window, document, Element: window.Element,
    navigator: { languages: ['en-US'], language: 'en-US' },
    location: new URL('http://127.0.0.1:9417/#/logs'),
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false }),
    getComputedStyle: (element: HTMLElement) => ({ display: element.matches('.search-toggle') ? 'grid' : 'block' }),
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  t.mock.method(globalThis, 'setInterval', (() => 0) as unknown as typeof globalThis.setInterval);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://127.0.0.1:9417').pathname;
    if (path === '/ui/api/snapshot') return Response.json({ time: new Date().toISOString(), modules: [], sessions: [], logs: [] });
    if (path === '/ui/api/agents') return Response.json({ agents: [], editable: true });
    assert.fail(`Unexpected request: ${path}`);
  });
  await import('../src/ui-app.js');
  await nextTurn();

  const blurTo = (input: HTMLInputElement, relatedTarget: HTMLElement | null) => {
    focused = relatedTarget;
    const event = new window.Event('focusout', { bubbles: true });
    Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
    input.dispatchEvent(event);
  };
  for (const id of ['search', 'pull-search', 'repo-search']) {
    await t.test(id, () => {
      const input = document.getElementById(id)! as unknown as HTMLInputElement;
      const group = input.closest<HTMLElement>('.titlebar-search')!;
      const toggle = group.querySelector<HTMLButtonElement>('.search-toggle')!;
      input.value = 'synthetic retained query';
      toggle.click();
      assert.equal(focused, input);
      assert.equal(toggle.getAttribute('aria-expanded'), 'true');
      toggle.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      blurTo(input, null); // Safari does not focus buttons on pointer clicks.
      toggle.click();
      assert.equal(group.hasAttribute('data-open'), false, 'A second click must close, not reopen, the field');
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(input.value, 'synthetic retained query');

      toggle.click();
      blurTo(input, toggle);
      assert.equal(group.hasAttribute('data-open'), true, 'Keyboard focus within the group preserves the field');
      const outside = document.getElementById('refresh')! as unknown as HTMLElement;
      blurTo(input, outside);
      assert.equal(group.hasAttribute('data-open'), false, 'Tabbing to another control closes the field');
      toggle.click();
      outside.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      assert.equal(group.hasAttribute('data-open'), false, 'Outside pointer interaction still dismisses search');
      toggle.click();
      const escape = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(escape, 'key', { value: 'Escape' });
      input.dispatchEvent(escape);
      assert.equal(group.hasAttribute('data-open'), false);
      assert.equal(focused, toggle, 'Escape restores focus to the opener');
    });
  }
});
