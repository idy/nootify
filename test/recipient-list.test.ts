import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { RecipientListRenderer, type RecipientListOptions } from '../src/recipient-list.js';
import type { LarkRecipient } from '../src/ui-types.js';
import { mergeRecipients } from '../src/lark-profile.js';

const one: LarkRecipient = { open_id: 'ou_one', name: 'One', avatar_url: 'https://image.feishucdn.com/one.png' };
const two: LarkRecipient = { open_id: 'ou_two', name: 'Two', avatar_url: 'https://image.feishucdn.com/two.png' };
function fixture() {
  const { document, Event } = parseHTML('<html><body><div id="scroll"><div id="list"></div></div></body></html>');
  const list = document.getElementById('list') as unknown as HTMLElement;
  const scroller = document.getElementById('scroll') as unknown as HTMLElement;
  scroller.scrollTop = 0;
  const selected: string[] = [];
  const renderer = new RecipientListRenderer(list, scroller, id => selected.push(id));
  const options: RecipientListOptions = { selected: '', active: '', locale: 'en', currentLabel: 'Current recipient', unknownLabel: 'Feishu user', failedAvatars: new Set(), retainIds: new Set([one.open_id, two.open_id]) };
  return { list, scroller, renderer, options, Event, selected };
}

test('polling and selection reuse the same contact and image elements', async () => {
  const f = fixture(); f.renderer.update([one], f.options);
  const row = f.list.firstElementChild!; const image = row.querySelector('img')!;
  image.dispatchEvent(new f.Event('load')); await Promise.resolve();
  for (let i = 0; i < 40; i++) f.renderer.update([{ ...one }], { ...f.options, selected: i % 2 ? one.open_id : '', active: one.open_id });
  assert.equal(f.list.firstElementChild, row);
  assert.equal(row.querySelector('img'), image);
  assert.equal(row.querySelectorAll('img').length, 1);
});

test('new streamed contacts append without replacing existing rows or photos', () => {
  const f = fixture(); f.renderer.update([one], f.options);
  const row = f.list.firstElementChild!; const image = row.querySelector('img');
  f.renderer.update([one, two], f.options);
  assert.equal(f.list.firstElementChild, row); assert.equal(row.querySelector('img'), image);
  assert.equal(f.list.children.length, 2);
});

test('search detaches and restores cached row/image objects instead of reconstructing them', () => {
  const f = fixture(); f.renderer.update([one, two], f.options);
  const row = f.list.firstElementChild!; const image = row.querySelector('img');
  f.renderer.update([two], f.options);
  assert.equal(f.list.children.length, 1);
  f.renderer.update([one, two], f.options);
  assert.equal(f.list.firstElementChild, row); assert.equal(row.querySelector('img'), image);
});

test('text/current-recipient updates leave the loaded avatar intact and callbacks keep exact IDs', () => {
  const f = fixture(); f.renderer.update([one], f.options);
  const row = f.list.firstElementChild!; const image = row.querySelector('img');
  f.renderer.update([{ ...one, name: 'Updated', nickname: 'Alias' }], { ...f.options, current: one.open_id, selected: one.open_id });
  assert.equal(row.querySelector('.recipient-person-name')?.textContent, 'Alias（Updated）');
  assert.equal(row.querySelector('img'), image); (row as HTMLElement).click();
  assert.deepEqual(f.selected, [one.open_id]); assert.equal(row.getAttribute('aria-selected'), 'true');
});

test('a replacement avatar keeps the old image visible until the new image has loaded', async () => {
  const f = fixture(); f.renderer.update([one], f.options);
  const row = f.list.firstElementChild!; const oldImage = row.querySelector('img')!;
  oldImage.dispatchEvent(new f.Event('load')); await Promise.resolve();
  f.renderer.update([{ ...one, avatar_url: 'https://image.feishucdn.com/new.png' }], f.options);
  const images = row.querySelectorAll('img'); assert.equal(images.length, 2);
  assert.equal(oldImage.hidden, false); assert.equal(images[1]!.hidden, true);
  images[1]!.dispatchEvent(new f.Event('load')); await Promise.resolve();
  assert.equal(row.querySelectorAll('img').length, 1); assert.notEqual(row.querySelector('img'), oldImage);
});

test('a failed displayed image reveals its initial fallback and can retry after refresh', async () => {
  const f = fixture(); f.renderer.update([one], f.options);
  const row = f.list.firstElementChild!; const image = row.querySelector('img')!;
  image.dispatchEvent(new f.Event('load')); await Promise.resolve();
  image.dispatchEvent(new f.Event('error'));
  assert.equal(row.querySelector('img'), null);
  assert.equal((row.querySelector('.recipient-avatar span') as HTMLElement).hidden, false);
  assert.equal(f.options.failedAvatars.has(one.avatar_url!), true);
  f.options.failedAvatars.clear(); f.renderer.update([one], f.options);
  assert.ok(row.querySelector('img'));
});

test('obsolete contacts are discarded only when no longer retained', () => {
  const f = fixture(); f.renderer.update([one, two], f.options);
  const old = f.list.firstElementChild!;
  f.renderer.update([two], { ...f.options, retainIds: new Set([two.open_id]) });
  f.renderer.update([one, two], f.options);
  assert.notEqual(f.list.firstElementChild, old);
  f.renderer.clear(); assert.equal(f.list.children.length, 0);
});

test('inserting contacts above the viewport keeps the visible anchor at the same position', () => {
  const f = fixture(); f.renderer.update([one, two], f.options);
  const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  f.scroller.getBoundingClientRect = () => box(0, 120);
  for (const child of [...f.list.children]) child.getBoundingClientRect = () => {
    const top = [...f.list.children].indexOf(child) * 60 - f.scroller.scrollTop; return box(top, top + 60);
  };
  f.scroller.scrollTop = 60;
  const anchor = f.list.children[1]!;
  const extra = { open_id: 'ou_extra', name: 'Extra' };
  f.renderer.update([extra, one, two], { ...f.options, retainIds: new Set([extra.open_id, one.open_id, two.open_id]) });
  assert.equal(f.list.children[2], anchor);
  assert.equal(anchor.getBoundingClientRect().top, 0);
  assert.equal(f.scroller.scrollTop, 120);
});

test('progress merges preserve cached order, unseen users and optional profile fields', () => {
  const updated: LarkRecipient = { open_id: one.open_id, name: 'New name' };
  const merged = mergeRecipients([one, two], [updated]);
  assert.deepEqual(merged.map(user => user.open_id), [one.open_id, two.open_id]);
  assert.equal(merged[0]?.name, 'New name'); assert.equal(merged[0]?.avatar_url, one.avatar_url);
});
