import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UiOwnerAuth } from '../src/ui-owner-auth.js';
import { main } from '../src/cli.js';
import type { ServiceAction, ServiceOptions } from '../src/service.js';

test('managed ui-url CLI owns a trusted asset gateway until stdin closes without exposing the private root', async t => {
  const state = await mkdtemp(join(tmpdir(), 'nootify-ui-url-cli-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const token = 'synthetic-test-owner-token';
  await writeFile(join(state, 'auth-token'), token, { mode: 0o600 });
  const auth = new UiOwnerAuth(token);
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined, 'the root bearer reached HTTP');
    void auth.handle(request, response, new URL(request.url!, `http://${request.headers.host}`), true).then(handled => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch(() => { response.writeHead(500); response.end(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as AddressInfo).port;
  for (const target of [undefined, '#/logs', '#/settings/about']) {
    const args = [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'ui-url', '--ui-managed', '--state-dir', state, '--port', String(port), ...(target ? ['--ui-route', target] : [])];
    assert.ok(!args.join(' ').includes(token));
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const exited = once(child, 'exit');
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
      const [line] = await once(lines, 'line') as [string];
      assert.ok(!line.includes(token));
      const result = JSON.parse(line) as { url: string };
      assert.notEqual(new URL(result.url).port, String(port));
      assert.equal(new URLSearchParams(new URL(result.url).hash.slice(1)).get('route'), target ?? '#/logs');
      const document = await fetch(new URL('/', result.url));
      assert.equal(document.status, 200); assert.equal(document.headers.get('set-cookie'), null); assert.match(await document.text(), /Nootify/);
      child.stdin.end();
      assert.deepEqual(await exited, [0, null]);
    } finally { clearTimeout(timer); lines.close(); }
  }
  await assert.rejects(main(['ui-url', '--state-dir', state, '--port', String(port), '--ui-route', 'https://example.com/']), /Invalid local UI route/);
});

test('service CLI forwards a validated owned drain receipt without reading auth state', async () => {
  const output: unknown[] = [];
  const original = console.log;
  const calls: [ServiceAction, ServiceOptions][] = [];
  console.log = value => { output.push(value); };
  try {
    const drain = { pid: 12345, started: 'Sat Nov  7 12:00:00 2026' };
    await main(['service-start', '--state-dir', '/synthetic/no-auth-file', '--service-drain', JSON.stringify(drain)], async (action, options) => {
      calls.push([action, options]); return { installed: true, status: 'started' };
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], 'start');
    assert.deepEqual(calls[0]![1].drain, drain);
    assert.deepEqual(output, ['{"installed":true,"status":"started"}']);
    for (const receipt of ['{}', '{"pid":0,"started":"x"}', '{"pid":1,"started":""}', '{"pid":1,"started":"x\\ny"}']) {
      await assert.rejects(main(['service-start', '--service-drain', receipt], async () => assert.fail('invalid drain reached management')), /Invalid service drain identity/);
    }
    await assert.rejects(main(['service-uninstall', '--service-drain', JSON.stringify(drain)], async () => assert.fail('recovery authorized an uninstall')), /requires service-start, service-restart or service-stop/);
  } finally { console.log = original; }
});
