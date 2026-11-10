import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { Dropdown } from '../src/dropdown.js';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) };
}

function fixture() {
  const { document, window } = parseHTML(`<html><body>
    <div id="ancestor"><button id="choice" value="beta"><span data-dropdown-label></span><svg id="chevron"></svg></button>
      <div id="choices"><button role="option" data-value="alpha"><span data-option-label>Alpha</span><svg><path></path></svg></button>
        <button role="option" data-value="alpine"><span data-option-label>Alpine</span></button>
        <button role="option" data-value="beta"><span data-option-label>Beta</span></button>
        <button role="option" data-value="gamma" disabled><span data-option-label>Gamma</span></button>
        <button role="option" data-value="delta"><span data-option-label>Delta</span></button>
      </div>
    </div><button id="outside">Outside</button><div id="unrelated"></div>
  </body></html>`);
  const button = document.getElementById('choice') as unknown as HTMLButtonElement;
  const menu = document.getElementById('choices') as unknown as HTMLElement;
  const ancestor = document.getElementById('ancestor') as unknown as HTMLElement;
  const outside = document.getElementById('outside') as unknown as HTMLButtonElement;
  // Linkedom does not reflect a button's value attribute into its value property.
  button.value = 'beta';
  let focusCount = 0;
  button.focus = () => { focusCount++; };
  button.getBoundingClientRect = () => rect(100, 100, 120, 30);
  menu.getBoundingClientRect = () => rect(100, 134, 180, 180);
  menu.scrollTop = 0;
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
  const options = [...menu.querySelectorAll<HTMLButtonElement>('button')];
  for (const [index, option] of options.entries()) option.getBoundingClientRect = () => rect(100, 134 + index * 30, 180, 30);
  const dropdown = new Dropdown(button, menu);
  const changes: string[] = [];
  document.body.addEventListener('change', event => changes.push((event.target as unknown as HTMLButtonElement).value));
  const option = (value: string) => options.find(candidate => candidate.dataset.value === value)!;
  const active = () => options.find(candidate => candidate.hasAttribute('data-active'))?.dataset.value;
  const key = (value: string, properties: Partial<KeyboardEvent> = {}, target: HTMLElement = button) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key: value, ...properties });
    target.dispatchEvent(event);
    return event;
  };
  const click = (element: Element) => element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  return { document, window, button, menu, ancestor, outside, options, option, active, key, click, dropdown, changes, get focusCount() { return focusCount; } };
}

test('initializes a body-portaled combobox with labeled, stable options', () => {
  const f = fixture();
  assert.equal(f.menu.parentElement, f.document.body);
  assert.equal(f.ancestor.querySelector('[role="listbox"]'), null);
  assert.equal(f.button.type, 'button');
  assert.equal(f.button.getAttribute('role'), 'combobox');
  assert.equal(f.button.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(f.button.getAttribute('aria-controls'), f.menu.id);
  assert.equal(f.button.getAttribute('aria-expanded'), 'false');
  assert.equal(f.menu.getAttribute('role'), 'listbox');
  assert.equal(f.menu.getAttribute('aria-labelledby'), f.button.id);
  assert.equal(f.menu.hidden, true);
  assert.equal(f.button.querySelector('[data-dropdown-label]')?.textContent, 'Beta');
  assert.ok(f.button.querySelector('#chevron'));
  assert.equal(f.option('beta').getAttribute('aria-selected'), 'true');
  assert.equal(f.option('alpha').getAttribute('aria-selected'), 'false');
  assert.equal(new Set(f.options.map(option => option.id)).size, f.options.length);
  for (const option of f.options) { assert.ok(option.id); assert.equal(option.tabIndex, -1); assert.equal(option.type, 'button'); }
  const ids = f.options.map(option => option.id);
  f.dropdown.refresh();
  assert.deepEqual(f.options.map(option => option.id), ids);
  assert.deepEqual(f.changes, []);
});

test('value reflects the DOM and refresh copies translated labels without replacing icons or options', () => {
  const f = fixture(), label = f.button.querySelector('[data-dropdown-label]'), chevron = f.button.querySelector('#chevron');
  f.dropdown.value = 'alpha';
  assert.equal(f.button.value, 'alpha');
  assert.equal(label?.textContent, 'Alpha');
  f.button.value = 'beta';
  assert.equal(f.dropdown.value, 'beta');
  f.option('beta').querySelector('[data-option-label]')!.textContent = '测试选项';
  f.button.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  assert.equal(label?.textContent, '测试选项');
  f.option('beta').querySelector('[data-option-label]')!.textContent = 'Translated Beta';
  f.dropdown.refresh();
  assert.equal(label?.textContent, 'Translated Beta');
  assert.equal(f.button.querySelector('#chevron'), chevron);
  assert.equal(f.button.querySelector('[data-dropdown-label]'), label);
  assert.equal(f.menu.querySelector('[data-value="beta"]'), f.option('beta'));
  assert.deepEqual(f.changes, ['beta']);
  f.dropdown.value = 'unavailable';
  assert.equal(f.dropdown.value, 'unavailable');
  assert.equal(label?.textContent, '');
  assert.equal(f.options.filter(option => option.getAttribute('aria-selected') === 'true').length, 0);
});

test('a nested option click commits once, bubbles change, closes and restores trigger focus', () => {
  const f = fixture();
  f.click(f.button);
  assert.equal(f.active(), 'beta');
  assert.equal(f.button.getAttribute('aria-activedescendant'), f.option('beta').id);
  f.click(f.option('alpha').querySelector('path')!);
  assert.equal(f.dropdown.value, 'alpha');
  assert.equal(f.button.querySelector('[data-dropdown-label]')?.textContent, 'Alpha');
  assert.deepEqual(f.changes, ['alpha']);
  assert.equal(f.menu.hidden, true);
  assert.equal(f.button.getAttribute('aria-expanded'), 'false');
  assert.equal(f.button.hasAttribute('aria-activedescendant'), false);
  assert.equal(f.active(), undefined);
  assert.equal(f.focusCount, 1);
  f.click(f.button); f.click(f.option('alpha'));
  assert.deepEqual(f.changes, ['alpha'], 'reselecting the saved option emits no change');
  f.click(f.option('beta'));
  assert.equal(f.dropdown.value, 'alpha', 'a hidden menu cannot commit programmatic clicks');
});

test('keyboard navigation skips disabled options, wraps, and commits only on Enter or Space', () => {
  const f = fixture();
  assert.equal(f.key('ArrowDown').defaultPrevented, true);
  assert.equal(f.active(), 'beta');
  f.key('ArrowDown'); assert.equal(f.active(), 'delta');
  f.key('ArrowDown'); assert.equal(f.active(), 'alpha');
  f.key('ArrowUp'); assert.equal(f.active(), 'delta');
  assert.equal(f.dropdown.value, 'beta'); assert.deepEqual(f.changes, []);
  f.key('Enter');
  assert.equal(f.dropdown.value, 'delta'); assert.deepEqual(f.changes, ['delta']);
  f.key(' '); assert.equal(f.menu.hidden, false);
  f.key('Home'); assert.equal(f.active(), 'alpha');
  f.key(' '); assert.equal(f.dropdown.value, 'alpha');
  f.key('End'); assert.equal(f.active(), 'delta');
  f.key('Escape'); assert.equal(f.dropdown.value, 'alpha');
  assert.deepEqual(f.changes, ['delta', 'alpha']);
});

test('Escape cancels the active preview and restores focus; Tab dismisses without trapping focus', () => {
  const f = fixture();
  f.key('Enter'); f.key('Home'); f.key('Escape');
  assert.equal(f.dropdown.value, 'beta'); assert.equal(f.menu.hidden, true); assert.equal(f.focusCount, 1);
  f.key('Enter'); f.key('End');
  assert.equal(f.key('Tab').defaultPrevented, false);
  assert.equal(f.menu.hidden, true); assert.equal(f.dropdown.value, 'beta'); assert.equal(f.focusCount, 1);
  f.click(f.button); f.dropdown.close(true);
  assert.equal(f.focusCount, 2);
  assert.deepEqual(f.changes, []);
});

test('typeahead previews prefixes and repeated letters cycle among enabled matches', t => {
  const f = fixture();
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  f.key('a'); assert.equal(f.active(), 'alpha');
  f.key('l'); f.key('p'); assert.equal(f.active(), 'alpha');
  f.key('i'); assert.equal(f.active(), 'alpine');
  assert.equal(f.dropdown.value, 'beta');
  now += 701;
  f.key('a'); assert.equal(f.active(), 'alpha');
  f.key('a'); assert.equal(f.active(), 'alpine');
  f.key('a'); assert.equal(f.active(), 'alpha');
  now += 701;
  f.key('g'); assert.equal(f.active(), 'alpha', 'disabled Gamma is excluded from matching');
  f.key('Escape');
  f.option('delta').querySelector('[data-option-label]')!.textContent = '中文';
  f.dropdown.refresh(); f.key('中'); assert.equal(f.active(), 'delta');
  f.key('Enter'); assert.equal(f.dropdown.value, 'delta');
});

test('handled keys never reach the global slash shortcut, while modifier shortcuts remain available', () => {
  const f = fixture(), received: string[] = [];
  f.document.addEventListener('keydown', event => received.push((event as unknown as KeyboardEvent).key));
  assert.equal(f.key('/').defaultPrevented, true);
  f.key('ArrowDown'); f.key('Home'); f.key('End'); f.key('Escape');
  assert.deepEqual(received, []);
  f.key('/', { ctrlKey: true }); f.key('F2'); f.key('a', { isComposing: true });
  assert.deepEqual(received, ['/', 'F2', 'a']);
});

test('disabled triggers and disabled or hidden options cannot be chosen', () => {
  const f = fixture();
  f.button.disabled = true;
  f.click(f.button); f.key('ArrowDown');
  assert.equal(f.menu.hidden, true);
  f.button.disabled = false; f.button.setAttribute('aria-disabled', 'true');
  f.click(f.button); assert.equal(f.menu.hidden, true);
  f.button.removeAttribute('aria-disabled');
  f.option('delta').setAttribute('aria-disabled', 'true');
  f.option('alpha').hidden = true;
  f.click(f.button); f.key('End');
  assert.equal(f.active(), 'beta');
  f.click(f.option('gamma')); f.click(f.option('delta')); f.click(f.option('alpha'));
  assert.equal(f.dropdown.value, 'beta'); assert.deepEqual(f.changes, []);
  f.button.disabled = true; f.dropdown.refresh();
  assert.equal(f.menu.hidden, true);
  f.button.disabled = false; f.click(f.button);
  for (const option of f.options) option.disabled = true;
  f.dropdown.refresh();
  assert.equal(f.menu.hidden, true, 'refresh dismisses a list with no enabled choices');
});

test('an empty or fully disabled list remains closed, and refresh discovers new options', () => {
  const f = fixture();
  for (const option of f.options) option.disabled = true;
  f.key('Enter'); assert.equal(f.menu.hidden, true);
  f.menu.replaceChildren(); f.dropdown.refresh(); f.key('End');
  assert.equal(f.menu.hidden, true);
  const added = f.document.createElement('button');
  added.setAttribute('role', 'option'); added.dataset.value = 'new'; added.textContent = 'New option';
  f.menu.append(added); f.dropdown.refresh(); f.key('Enter');
  assert.equal(f.button.getAttribute('aria-activedescendant'), added.id);
  f.key('Enter'); assert.equal(f.dropdown.value, 'new'); assert.deepEqual(f.changes, ['new']);
});

test('outside clicks and focus dismiss without committing or reclaiming focus', () => {
  const f = fixture();
  f.click(f.button); f.key('Home'); f.click(f.outside);
  assert.equal(f.menu.hidden, true); assert.equal(f.dropdown.value, 'beta'); assert.equal(f.focusCount, 0);
  f.click(f.button);
  f.outside.dispatchEvent(new f.window.Event('pointerdown', { bubbles: true }));
  assert.equal(f.menu.hidden, true);
  f.click(f.button);
  f.outside.dispatchEvent(new f.window.Event('focusin', { bubbles: true }));
  assert.equal(f.menu.hidden, true); assert.equal(f.focusCount, 0); assert.deepEqual(f.changes, []);
});

test('route changes and viewport resize dismiss an open popup', () => {
  const f = fixture();
  for (const name of ['hashchange', 'popstate', 'resize']) {
    f.click(f.button); assert.equal(f.menu.hidden, false);
    f.window.dispatchEvent(new f.window.Event(name));
    assert.equal(f.menu.hidden, true, name);
  }
  assert.equal(f.focusCount, 0); assert.deepEqual(f.changes, []);
});

test('ancestor scrolling dismisses while menu and unrelated internal scrolling remain usable', () => {
  const f = fixture(); f.click(f.button);
  f.menu.dispatchEvent(new f.window.Event('scroll', { bubbles: true }));
  assert.equal(f.menu.hidden, false);
  f.option('alpha').dispatchEvent(new f.window.Event('scroll', { bubbles: true }));
  assert.equal(f.menu.hidden, false);
  f.document.getElementById('unrelated')!.dispatchEvent(new f.window.Event('scroll', { bubbles: true }));
  assert.equal(f.menu.hidden, false);
  f.ancestor.dispatchEvent(new f.window.Event('scroll', { bubbles: true }));
  assert.equal(f.menu.hidden, true);
  f.click(f.button); f.window.dispatchEvent(new f.window.Event('scroll'));
  assert.equal(f.menu.hidden, true);
});

test('a second dropdown dismisses the first without losing the second click', () => {
  const f = fixture();
  const button = f.document.createElement('button'), menu = f.document.createElement('div');
  button.value = 'one'; button.innerHTML = '<span data-dropdown-label></span>';
  menu.innerHTML = '<button role="option" data-value="one"><span data-option-label>One</span></button>';
  f.document.body.append(button, menu);
  const second = new Dropdown(button as unknown as HTMLButtonElement, menu as unknown as HTMLElement);
  f.click(f.button); f.click(button);
  assert.equal(f.menu.hidden, true); assert.equal(menu.hidden, false);
  assert.equal(second.value, 'one');
  assert.notEqual(button.id, f.button.id); assert.notEqual(menu.id, f.menu.id);
});

test('positions below the trigger with a matching minimum width using CSSOM geometry', () => {
  const f = fixture(); f.click(f.button);
  assert.equal(f.menu.style.position, 'fixed');
  assert.equal(f.menu.style.boxSizing, 'border-box');
  assert.equal(f.menu.style.left, '100px'); assert.equal(f.menu.style.top, '134px');
  assert.equal(f.menu.style.minWidth, '120px'); assert.equal(f.menu.style.maxWidth, '1008px');
  assert.equal(f.menu.style.maxHeight, '626px');
  assert.equal(f.menu.querySelector('style, script'), null);
});

test('flips above near the bottom and clamps to the viewport right edge', () => {
  const f = fixture();
  Object.defineProperty(f.window, 'innerWidth', { value: 320, configurable: true });
  Object.defineProperty(f.window, 'innerHeight', { value: 240, configurable: true });
  f.button.getBoundingClientRect = () => rect(270, 160, 80, 30);
  f.menu.getBoundingClientRect = () => rect(0, 0, 180, 140);
  f.click(f.button);
  assert.equal(f.menu.style.left, '132px'); assert.equal(f.menu.style.top, '16px');
  assert.equal(f.menu.style.maxHeight, '148px'); assert.equal(f.menu.style.maxWidth, '304px');
});

test('oversized menus and triggers stay bounded, with keyboard movement scrolling the list', () => {
  const f = fixture();
  Object.defineProperty(f.window, 'innerWidth', { value: 320, configurable: true });
  Object.defineProperty(f.window, 'innerHeight', { value: 300, configurable: true });
  f.button.getBoundingClientRect = () => rect(-10, 180, 700, 30);
  f.menu.getBoundingClientRect = () => rect(8, 8, 500, 168);
  Object.defineProperty(f.menu, 'scrollHeight', { value: 1000 });
  f.option('beta').getBoundingClientRect = () => rect(8, 250, 300, 30);
  f.click(f.button);
  assert.equal(f.menu.style.left, '8px'); assert.equal(f.menu.style.top, '8px');
  assert.equal(f.menu.style.minWidth, '304px'); assert.equal(f.menu.style.maxWidth, '304px');
  assert.equal(f.menu.style.maxHeight, '168px'); assert.ok(f.menu.scrollTop > 0);
  f.menu.dispatchEvent(new f.window.Event('scroll', { bubbles: true }));
  assert.equal(f.menu.hidden, false);
});
