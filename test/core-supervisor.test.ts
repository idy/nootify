import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreFailureSupervisor } from '../src/core-supervisor.js';
import { ProviderCore } from '../src/provider-core.js';
import { createServiceHost } from '../src/server.js';

test('unexpected core exit closes parent health before requesting nonzero process exit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nootify-core-supervisor-'));
  const script = join(root, 'core.cjs');
  await writeFile(script, `process.stdout.write(JSON.stringify({id:0,result:{ready:true}})+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='crash')process.exit(23);process.stdout.write(JSON.stringify({id:r.id,result:{}})+'\\n');});`);
  const server = createServiceHost([], 'synthetic-token'); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const exits: number[] = [];
  let core!: ProviderCore;
  const supervisor = new CoreFailureSupervisor(async () => { await core.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }, code => { exits.push(code); });
  core = new ProviderCore(join(root, 'state'), () => {}, { file: process.execPath, args: [script] }, 2000,
    () => supervisor.observe({ source: 'providers', status: 'core_stopped' }));
  t.after(async () => { await core.stop(); server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  await core.start(); assert.equal((await fetch(base + '/health')).status, 200);
  await assert.rejects(core.request('crash'));
  await supervisor.completion;
  assert.equal(supervisor.failed, true); assert.deepEqual(exits, [1]);
  await assert.rejects(fetch(base + '/health'));
  supervisor.observe({ source: 'providers', status: 'core_stopped' }); assert.deepEqual(exits, [1]);
});

test('intentional shutdown and unrelated log events do not trigger core recovery', () => {
  const exits: number[] = [];
  const supervisor = new CoreFailureSupervisor(async () => {}, code => { exits.push(code); });
  supervisor.observe({ source: 'providers', status: 'delivery_failed' });
  supervisor.observe({ source: 'other', status: 'core_stopped' });
  supervisor.beginShutdown(); supervisor.observe({ source: 'providers', status: 'core_stopped' });
  assert.equal(supervisor.failed, false); assert.deepEqual(exits, []);
});

test('broken cleanup cannot keep the parent alive or request multiple exits', async () => {
  const exits: number[] = []; const failures: unknown[] = [];
  const supervisor = new CoreFailureSupervisor(async () => { throw new Error('synthetic cleanup failure'); }, code => { exits.push(code); }, error => { failures.push(error); });
  supervisor.observe({ source: 'providers', status: 'core_stopped' }); await supervisor.completion;
  assert.equal(failures.length, 1); assert.deepEqual(exits, [1]);
  const timed = new CoreFailureSupervisor(() => new Promise(() => {}), code => { exits.push(code); }, () => {}, 10);
  timed.observe({ source: 'providers', status: 'core_stopped' });
  await new Promise(resolve => setTimeout(resolve, 25)); await timed.completion;
  assert.deepEqual(exits, [1, 1]);
});
