import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const names = ['montserrat-latin.woff2', 'monda-latin.woff2', 'lato-regular-latin.woff2', 'lato-bold-latin.woff2'];
test('every declared UI font is a complete local asset identical to the website font', async () => {
  const stylesheet = new URL('../../public/ui/fonts.css', import.meta.url);
  const css = await readFile(stylesheet, 'utf8');
  const urls = [...css.matchAll(/url\("([^"]+\.woff2)"\)/g)].map(match => new URL(match[1], stylesheet));
  assert.deepEqual(urls.map(url => url.pathname.split('/').at(-1)), names);
  const directory = new URL('./fonts/', stylesheet).pathname;
  for (const url of urls) {
    assert.equal(url.protocol, 'file:', 'fonts must not depend on an external font service');
    assert.ok(url.pathname.startsWith(directory), 'fonts must remain in the bundled font directory');
    assert.equal(url.search, ''); assert.equal(url.hash, '');
    const bytes = await readFile(url);
    assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
    assert.equal(bytes.readUInt32BE(8), bytes.length, 'WOFF2 file length must match its header');
    assert.deepEqual(bytes, await readFile(new URL(`../../site/shared/${url.pathname.split('/').at(-1)}`, import.meta.url)));
  }
});
test('the offline bundle carries the same font bytes and OFL notices as the website', async () => {
  for (const name of [...names, 'Montserrat-OFL.txt', 'Monda-OFL.txt', 'Lato-OFL.txt']) {
    const bundled = await readFile(new URL(`../../desktop/fonts/${name}`, import.meta.url));
    assert.deepEqual(bundled, await readFile(new URL(`../../site/shared/${name}`, import.meta.url)));
    if (name.endsWith('.txt')) assert.match(bundled.toString(), /SIL OPEN FONT LICENSE/i);
  }
});
