import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { installLaunchd, launchdLabel, launchdPlist } from '../src/launchd.js';
import { createServiceHost } from '../src/server.js';
import { State } from '../src/state.js';
import type { LarkDelivery, SessionRecord, StoredInboxMessage } from '../src/types.js';

const tokenBytes = 'b'.repeat(64) + '\n';
const serverFile = fileURLToPath(new URL('../src/server.js', import.meta.url));
const macOnly = process.platform !== 'darwin' || !process.getuid;
function legacyData(final = false) {
  const sessions: SessionRecord[] = [{ session_id: 'legacy-session', session_name: 'Legacy fixture', host_id: 'fixture-host', adapter: 'trae', socket_token: 'fake-inbox-token' }];
  if (final) sessions.push({ session_id: 'registered-during-shutdown', session_name: 'Final registration', host_id: 'fixture-host', adapter: 'workbuddy', socket_token: 'fake-final-token' });
  const delivery: LarkDelivery = { message_id: 'om_fixture_ack', chat_id: 'oc_fixture', sender_open_id: 'ou_fixture', session_id: 'legacy-session', session_name: 'Legacy fixture', adapter: 'trae',
    created_at: '2026-11-06T00:00:00.000Z', transport_status: 'inbox_queued', replies: [],
    ...(final ? { acknowledged_at: '2026-11-06T00:01:00.000Z', replies: [{ digest: 'fixture-reply-digest', message_id: 'om_fixture_reply', time: '2026-11-06T00:02:00.000Z' }] } : {}) };
  const message = (id: string, text: string): StoredInboxMessage => ({ id, text, created_at: delivery.created_at, session_id: delivery.session_id, adapter: 'trae', source: { channel: 'feishu', delivery } });
  const inbox_messages = [message('inbox-retained', 'Keep the existing unread command')];
  if (final) inbox_messages.push(message('inbox-final', 'Queued while the legacy process was draining'));
  else inbox_messages.push(message('inbox-consumed', 'Acknowledged during shutdown and removed by the final save'));
  return { version: 1, sessions, lark_bindings: [], lark_deliveries: [delivery], inbox_messages, settings: { tailscale_enabled: false } };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nootify-migration-lifecycle-'));
  const stateDir = join(root, 'state'); const home = join(root, 'home');
  await mkdir(stateDir, { mode: 0o700 }); await mkdir(home);
  const original = JSON.stringify(legacyData(), null, 2) + '\n';
  await writeFile(join(stateDir, 'state.json'), original, { mode: 0o600 });
  await writeFile(join(stateDir, 'auth-token'), tokenBytes, { mode: 0o600 });
  const servers = new Set<Server>(); const children = new Set<ChildProcess>();
  t.after(async () => {
    try {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'close'); child.kill('SIGKILL'); await exited;
      }
      for (const server of servers) if (server.listening) {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  // Provider keys/preloads are excluded; state paths and installer home are explicit fixture arguments.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: root };
  return { root, stateDir, home, original, env, servers, children };
}
async function listen(server: Server, port = 0): Promise<number> {
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}
function fixtureHost(): Server {
  return createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify({ ok: true, service: 'nootify', fixture: true }));
  });
}
async function assertUnmigrated(stateDir: string, original: string): Promise<void> {
  assert.deepEqual((await readdir(stateDir)).sort(), ['auth-token', 'state.json'], 'failed startup/install must not create SQLite, journal or runtime files');
  assert.equal(await readFile(join(stateDir, 'state.json'), 'utf8'), original);
  assert.equal(await readFile(join(stateDir, 'auth-token'), 'utf8'), tokenBytes);
}

test('the actual new server refuses an occupied loopback port before initializing or importing state', { timeout: 15_000 }, async t => {
  const f = await fixture(t); const occupied = fixtureHost(); f.servers.add(occupied); const port = await listen(occupied);
  const child = spawn(process.execPath, [serverFile, '--state-dir', f.stateDir, '--port', String(port)], {
    cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL',
  });
  f.children.add(child);
  let stdout = ''; let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, `server did not exit on its own: ${stderr}`);
  assert.equal(code, 1, `occupied-port startup unexpectedly succeeded: ${stdout}\n${stderr}`);
  assert.match(stderr, /EADDRINUSE|address already in use/i);
  await assertUnmigrated(f.stateDir, f.original);
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000), headers: { connection: 'close' } });
  assert.deepEqual(await response.json(), { ok: true, service: 'nootify', fixture: true });
});

test('installLaunchd refuses an unmanaged occupied port without migrating state or touching launchctl', { skip: macOnly, timeout: 10_000 }, async t => {
  const f = await fixture(t); const occupied = fixtureHost(); f.servers.add(occupied); const port = await listen(occupied);
  const calls: string[] = [];
  await assert.rejects(installLaunchd({ stateDir: f.stateDir, port }, { home: f.home, execute: async (file, args) => {
    calls.push([file, ...args].join(' ')); throw new Error('No launchctl or plutil operation is allowed for this fixture');
  } }), /stop the existing service/);
  assert.deepEqual(calls, []);
  await assertUnmigrated(f.stateDir, f.original);
  assert.deepEqual(await readdir(f.home), [], 'refusal must not write a replacement LaunchAgent');
});

// Explicit gates keep the legacy writer alive after its port is free, and again after its final save.
// A port-only shutdown wait therefore cannot accidentally pass because this child exited quickly.
const legacyChild = String.raw`import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [stateDir, finalPath] = process.argv.slice(2);
let closed = false; let saved = false; let stopping = false;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify({ ok: true, service: 'nootify' }));
});
process.on('SIGTERM', () => {
  if (stopping) return; stopping = true;
  server.closeAllConnections();
  server.close(() => { closed = true; process.send({ stage: 'listener-closed' }); });
});
process.on('message', async message => {
  try {
    if (message === 'write-final') {
      if (!closed) throw new Error('Cannot write the final fixture snapshot before closing its listener');
      await writeFile(join(stateDir, 'state.json'), await readFile(finalPath), { mode: 0o600 });
      saved = true; process.send({ stage: 'final-saved' });
    } else if (message === 'exit') {
      if (!saved) throw new Error('Cannot exit before the final fixture save');
      process.exit(0);
    }
  } catch (error) { console.error(error); process.exit(1); }
});
server.listen(0, '127.0.0.1', () => process.send({ stage: 'ready', port: server.address().port }));
`;

test('launchd replacement waits for the legacy writer final save and process exit before migration', { skip: macOnly, timeout: 15_000 }, async t => {
  const f = await fixture(t); const finalData = legacyData(true); const finalBytes = JSON.stringify(finalData, null, 2) + '\n';
  const script = join(f.root, 'legacy-child.mjs'); const finalPath = join(f.root, 'final-state.json');
  await writeFile(script, legacyChild); await writeFile(finalPath, finalBytes, { mode: 0o600 });
  const child = spawn(process.execPath, [script, f.stateDir, finalPath], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  f.children.add(child);
  let childErrors = ''; child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { childErrors += chunk; }); child.stdout!.resume();
  const [ready] = await once(child, 'message');
  assert.equal(ready.stage, 'ready'); const port = Number(ready.port); assert.ok(Number.isInteger(port) && port > 0);
  assert.ok(child.pid);
  const plistDir = join(f.home, 'Library', 'LaunchAgents'); await mkdir(plistDir, { recursive: true });
  const plistPath = join(plistDir, `${launchdLabel}.plist`);
  await writeFile(plistPath, launchdPlist({ node: process.execPath, server: serverFile, stateDir: f.stateDir, port }));
  const calls: string[] = []; let bootstrapCalls = 0; let migrated: State | undefined;
  const closed = once(child, 'message');
  const installation = installLaunchd({ stateDir: f.stateDir, port }, { home: f.home, execute: async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (file === 'launchctl' && args[0] === 'print') {
      assert.deepEqual(args, ['print', `gui/${process.getuid!()}/${launchdLabel}`]);
      return { stdout: `fixture legacy job = {\n  pid = ${child.pid}\n}\n` };
    }
    if (file === 'launchctl' && args[0] === 'bootout') {
      assert.deepEqual(args, ['bootout', `gui/${process.getuid!()}`, plistPath]);
      await assertUnmigrated(f.stateDir, f.original);
      assert.equal(child.kill('SIGTERM'), true, 'fake bootout signals only this fixture child');
      return { stdout: '' };
    }
    if (file === 'plutil' && args[0] === '-lint') {
      assert.deepEqual(args, ['-lint', plistPath]); return { stdout: 'fixture plist: OK' };
    }
    if (file === 'launchctl' && args[0] === 'bootstrap') {
      bootstrapCalls++;
      assert.deepEqual(args, ['bootstrap', `gui/${process.getuid!()}`, plistPath]);
      assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' }, 'replacement must wait for process exit even after the final save');
      assert.equal(await readFile(join(f.stateDir, 'state.json'), 'utf8'), finalBytes);
      await assertUnmigrated(f.stateDir, finalBytes);
      migrated = await State.open(f.stateDir);
      const readyHost = createServer(); f.servers.add(readyHost); await listen(readyHost, port);
      assert.equal(createServiceHost([], migrated.token, undefined, {}, readyHost), readyHost);
      return { stdout: '' };
    }
    throw new Error(`Unexpected fixture command: ${file} ${args.join(' ')}`);
  } });
  // Observe early installation failures without allowing a detached rejection while driving the child.
  const outcome = installation.then(value => ({ value }), error => ({ error }));
  const beforeInstallFinishes = async (phase: Promise<unknown>): Promise<unknown> => Promise.race([phase, outcome.then(result => {
    if ('error' in result) throw result.error;
    throw new Error('Installation completed before the fixture legacy writer exited');
  })]);
  const [closedMessage] = await beforeInstallFinishes(closed) as [Record<string, unknown>];
  assert.equal(closedMessage.stage, 'listener-closed');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(bootstrapCalls, 0, 'closing the listener alone must not authorize replacement');
  await assertUnmigrated(f.stateDir, f.original);
  const saved = once(child, 'message'); child.send('write-final');
  const [savedMessage] = await beforeInstallFinishes(saved) as [Record<string, unknown>];
  assert.equal(savedMessage.stage, 'final-saved');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(bootstrapCalls, 0, 'a final save alone must not authorize replacement while the writer is alive');
  await assertUnmigrated(f.stateDir, finalBytes);
  const exited = once(child, 'exit'); child.send('exit');
  const [exitCode, exitSignal] = await exited;
  assert.equal(exitCode, 0, childErrors); assert.equal(exitSignal, null, childErrors);
  const result = await outcome; if ('error' in result) throw result.error;
  assert.equal(result.value, plistPath); assert.equal(bootstrapCalls, 1);
  assert.deepEqual(calls.map(call => call.split(' ').slice(0, 2).join(' ')), ['launchctl print', 'launchctl bootout', 'plutil -lint', 'launchctl bootstrap']);
  assert.ok(migrated);
  assert.deepEqual([...migrated.sessions.values()], finalData.sessions, 'retain the registration saved after the legacy listener closed');
  assert.deepEqual([...migrated.inboxMessages.values()], finalData.inbox_messages, 'retain the final unread inbox and its source context');
  assert.equal(migrated.inboxMessages.has('inbox-consumed'), false, 'a consumed inbox item must not reappear after migration');
  assert.equal(migrated.larkDelivery('om_fixture_ack')!.acknowledged_at, finalData.lark_deliveries[0].acknowledged_at);
  assert.deepEqual(migrated.larkDelivery('om_fixture_ack')!.replies, finalData.lark_deliveries[0].replies);
  assert.equal(migrated.inboxMessages.get('inbox-final')!.source!.delivery, migrated.larkDelivery('om_fixture_ack'));
  const reopened = await State.open(f.stateDir);
  assert.deepEqual([...reopened.sessions.values()], finalData.sessions);
  assert.deepEqual([...reopened.inboxMessages.values()], finalData.inbox_messages);
  assert.equal(await readFile(join(f.stateDir, 'state.json'), 'utf8'), finalBytes);
  assert.equal(await readFile(join(f.stateDir, 'auth-token'), 'utf8'), tokenBytes);
});
