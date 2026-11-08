import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventLog } from '../src/events.js';
import { createServiceHost } from '../src/server.js';

const names = ['montserrat-latin.woff2', 'monda-latin.woff2', 'lato-regular-latin.woff2', 'lato-bold-latin.woff2'];
test('the UI serves the website font bytes locally through every declared font URL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-fonts-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const logs = await EventLog.open(directory); const server = createServiceHost([], 'font-fixture', logs);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const styles = await fetch(origin + '/ui/fonts.css'); assert.equal(styles.status, 200); assert.match(styles.headers.get('content-type')!, /text\/css/);
  const css = await styles.text(); const urls = [...css.matchAll(/url\("([^"]+\.woff2)"\)/g)].map(match => new URL(match[1], styles.url));
  assert.deepEqual(urls.map(url => url.pathname.split('/').at(-1)), names);
  for (const url of urls) {
    assert.equal(url.origin, origin, 'fonts must not depend on an external font service');
    const response = await fetch(url); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'font/woff2');
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
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
