import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { encodeMessageRef } from '../dist/src/providers.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const work = process.env.NOOTIFY_INTEGRATION_ROOT;
const coreBinary = process.env.NOOTIFY_INTEGRATION_CORE_BIN;
const upstreamBinary = process.env.NOOTIFY_INTEGRATION_UPSTREAM_BIN;
if (![work, coreBinary, upstreamBinary].every(value => value && isAbsolute(value))) {
  throw new Error('Run npm run test:integration to create an isolated headless workspace');
}
const runtimeEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LANG|LC_[A-Z_]+|TZ)$/i.test(key)));
runtimeEnv.TEMP = work; runtimeEnv.TMP = work;
const cliCommands = new Set(['thread-open', 'thread-send', 'thread-receive', 'thread-ack', 'thread-delete', 'message-ack', 'message-reply']);
const owned = new Set();

async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(read, predicate, description) {
  const deadline = Date.now() + 10_000;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(last)}`);
}
function launch(file, args, env, kind) {
  const child = spawn(file, args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  const append = text => { diagnostics = (diagnostics + text).slice(-65536); };
  child.stderr.setEncoding('utf8'); child.stderr.on('data', append);
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => reject(new Error(`${kind} exited before ready: ${diagnostics}`)));
    lines.on('line', line => {
      append(line + '\n');
      try { const value = JSON.parse(line); if (value.kind === kind) resolve(value); } catch { /* Test engine also prints PASS on shutdown. */ }
    });
  });
  let shutdown;
  const instance = { child, closed, diagnostics: () => diagnostics,
    ready: bounded(ready, 15_000, `${kind} startup timed out`),
    stop: () => shutdown ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      try { return await bounded(closed, 10_000, `${kind} did not close on EOF`); }
      catch (error) {
        child.kill('SIGTERM');
        try { await bounded(closed, 3000, `${kind} did not terminate`); }
        catch { child.kill('SIGKILL'); await bounded(closed, 3000, `${kind} could not be killed`); }
        throw error;
      } finally { lines.close(); owned.delete(instance); }
    })(),
  };
  child.stdin.on('error', () => {});
  owned.add(instance);
  return instance;
}
async function cleanup() {
  const results = await Promise.allSettled([...owned].reverse().map(instance => instance.stop()));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
const interrupted = () => { void cleanup().finally(() => process.exit(1)); };
process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);

async function request(url, token, method = 'GET', body) {
  const response = await fetch(url, { method, signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-nootify-ui': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.equal(response.ok, true, `${method} ${new URL(url).pathname}: ${JSON.stringify(data)}`);
  return data;
}
async function startService(name) {
  const stateDir = join(work, name);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const process = launch(globalThis.process.execPath, [join(root, 'dist/test/helpers/headless-service.js'), '--state-dir', stateDir],
    { ...runtimeEnv, NOOTIFY_CORE_BIN: coreBinary, NOOTIFY_HEADLESS_WORKSPACE: work }, 'service-ready');
  const ready = await process.ready;
  assert.equal(ready.headless, true);
  assert.notEqual(ready.port, 9417);
  return { ...ready, stateDir, process,
    page: () => request(`${ready.url}/ui/api/providers`, ready.token),
    inbox: session => request(`${ready.url}/v1/sessions/${session}/inbox`, ready.token, 'POST', { adapter: 'trae' }),
    state: async () => JSON.parse(await readFile(join(stateDir, 'provider-core/state.json'), 'utf8')),
  };
}
async function cli(service, command, args = []) {
  assert.ok(cliCommands.has(command), 'headless integration must never invoke platform service management');
  const { stdout } = await execute(process.execPath, [join(root, 'dist/src/cli.js'), command,
    '--state-dir', service.stateDir, '--port', String(service.port), ...args],
  { cwd: root, env: runtimeEnv, windowsHide: true, timeout: 10_000, maxBuffer: 1 << 20 });
  return JSON.parse(stdout);
}
async function configure(service, upstream) {
  await request(`${service.url}/ui/api/providers`, service.token, 'POST', { action: 'save', provider: {
    id: 'upstream', name: 'Synthetic upstream', type: 'remote', enabled: true,
    address: upstream.grpc_address, token: upstream.grpc_token, tls: false,
  } });
  await eventually(service.page, page => page.providers[0]?.status === 'connected', 'gRPC subscription');
}

test('headless: real CLI/HTTP/stdio/gRPC delivery, independent broadcast, reply and offline replay', { timeout: 100_000 }, async t => {
  t.after(async () => {
    await cleanup();
    process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted);
  });
  await t.test('test service refuses state outside its private workspace without modifying it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'nootify-headless-outside-'));
    try {
      await writeFile(join(outside, 'sentinel'), 'unchanged');
      await assert.rejects(execute(process.execPath, [join(root, 'dist/test/helpers/headless-service.js'), '--state-dir', outside],
        { cwd: root, env: { ...runtimeEnv, NOOTIFY_CORE_BIN: coreBinary, NOOTIFY_HEADLESS_WORKSPACE: work }, windowsHide: true, timeout: 5000 }),
      /refuses state or binaries outside/);
      assert.deepEqual(await readdir(outside), ['sentinel']);
      assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'unchanged');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  const upstreamDir = join(work, 'upstream');
  await mkdir(upstreamDir, { mode: 0o700 });
  const upstreamProcess = launch(upstreamBinary, ['-test.run=^TestHeadlessIntegrationUpstream$', '-test.timeout=100s'],
    { ...runtimeEnv, NOOTIFY_HEADLESS_UPSTREAM_STATE_DIR: upstreamDir }, 'upstream-ready');
  const upstream = await upstreamProcess.ready;
  const originState = () => request(`${upstream.control_url}/state`, upstream.control_token);
  const emit = body => request(`${upstream.control_url}/emit`, upstream.control_token, 'POST', body);
  const [first, initialSecond] = await Promise.all([startService('first'), startService('second')]);
  let second = initialSecond;
  assert.notEqual(first.node_id, second.node_id);
  await Promise.all([configure(first, upstream), configure(second, upstream)]);
  await eventually(originState, value => value.core.remote.peers.filter(peer => peer.connected).length === 2, 'two independent downstreams');
  const session = service => ({ node_id: service.node_id, adapter: 'trae', session_id: `conversation-${service.node_id}`, name: 'Headless integration' });
  const firstSession = session(first); const secondSession = session(second);

  await t.test('session creation and outgoing progress traverse the real remote provider', async () => {
    for (const [service, target] of [[first, firstSession], [second, secondSession]]) {
      const opened = await cli(service, 'thread-open', ['--adapter', 'trae', '--session-id', target.session_id, '--session-name', target.name]);
      assert.equal(opened.session_id, target.session_id);
    }
    await cli(first, 'thread-send', ['--adapter', 'trae', '--session-id', firstSession.session_id, '--text', 'headless progress', '--request-id', 'progress-once']);
    const state = await originState();
    assert.equal(state.bot.ensures, 2); assert.equal(state.bot.sends, 1);
    assert.equal(state.bot.last_send_text, 'headless progress');
  });

  let original;
  let inboxItem;
  await t.test('one source event reaches both downstreams but only its owning session is queued', async () => {
    original = await emit({ session: firstSession, event_id: 'headless-broadcast', message_id: 'source-message', content: { text: 'headless incoming question' } });
    const inbox = await eventually(() => first.inbox(firstSession.session_id), value => value.messages.length === 1, 'local cooperative delivery');
    inboxItem = inbox.messages[0]; assert.match(inboxItem.text, /headless incoming question/);
    const elsewhere = await second.inbox(secondSession.session_id); assert.equal(elsewhere.messages.length, 0);
    const origin = await eventually(originState, value => value.core.remote.peers.every(peer => peer.pending === 0 && peer.last_ack), 'independent confirmations');
    assert.equal(origin.core.remote.peers.length, 2);
    const [a, b] = await Promise.all([first.state(), second.state()]);
    assert.equal(a.events['headless-broadcast'].outcome, 'local');
    assert.equal(b.events['headless-broadcast'].outcome, 'broadcast');
    assert.equal(Object.values(a.deliveries).filter(value => value.event_id === 'headless-broadcast').length, 1);
    await emit({ session: firstSession, event_id: 'headless-broadcast', message_id: 'source-message', content: { text: 'headless incoming question' } });
    // Emit returning only proves upstream acceptance. A later event traverses the
    // same ordered subscription, then its persisted completion drains the async
    // Node delivery path before inspecting the original event's final inbox.
    const barrierId = 'headless-dedup-barrier';
    await emit({ session: firstSession, event_id: barrierId, message_id: 'dedup-barrier-message', content: { text: 'deduplication barrier' } });
    const settled = await eventually(first.state, value => {
      const deliveries = Object.values(value.deliveries).filter(item => ['headless-broadcast', barrierId].includes(item.event_id));
      return value.events[barrierId]?.outcome === 'local' && deliveries.some(item => item.event_id === barrierId)
        && deliveries.every(item => item.status === 'delivered');
    }, 'downstream delivery barrier and all preceding completions');
    await eventually(second.state, value => value.events[barrierId]?.outcome === 'broadcast', 'sibling subscription barrier');
    assert.equal(Object.values(settled.deliveries).filter(item => item.event_id === 'headless-broadcast').length, 1,
      'duplicate source events must not admit another local delivery');
    const afterDuplicate = await first.inbox(firstSession.session_id);
    assert.equal(afterDuplicate.messages.length, 2, 'only the original and barrier may reach the inbox');
    assert.equal(afterDuplicate.messages.filter(item => item.id === inboxItem.id).length, 1);
    const barrier = afterDuplicate.messages.find(item => item.id !== inboxItem.id);
    assert.match(barrier.text, /deduplication barrier/);
    await cli(first, 'thread-ack', ['--adapter', 'trae', '--session-id', firstSession.session_id, '--message-id', barrier.id]);
    assert.equal((await first.inbox(firstSession.session_id)).messages.length, 1, 'only the original remains after consuming the barrier');
  });

  await t.test('source acknowledgement and idempotent replies follow their full return reference', async () => {
    const ref = encodeMessageRef(original.message);
    assert.ok(inboxItem.text.includes(ref));
    const acknowledgement = await cli(first, 'message-ack', ['--message-ref', ref]);
    assert.equal(acknowledgement.status, 'session_acknowledged');
    const reply = await cli(first, 'message-reply', ['--message-ref', ref, '--text', 'headless answer']);
    const repeated = await cli(first, 'message-reply', ['--message-ref', ref, '--text', 'headless answer']);
    assert.equal(reply.reply_id, repeated.reply_id);
    const state = await originState();
    assert.equal(state.bot.acks, 1); assert.equal(state.bot.replies, 1);
    assert.deepEqual(state.bot.last_ack, original.message); assert.deepEqual(state.bot.last_reply, original.message);
    assert.equal(state.bot.last_reply_text, 'headless answer');
    await cli(first, 'thread-ack', ['--adapter', 'trae', '--session-id', firstSession.session_id, '--message-id', inboxItem.id]);
    assert.equal((await first.inbox(firstSession.session_id)).messages.length, 0);
  });

  await t.test('metadata works without an adapter and does not change the remote binding', async () => {
    const metadata = { test: 'headless', label: 'synthetic session' };
    await request(`${first.url}/v1/threads/${firstSession.session_id}/metadata`, first.token, 'PUT', { metadata });
    assert.deepEqual(await request(`${first.url}/v1/threads/${firstSession.session_id}/metadata`, first.token), metadata);
  });

  await t.test('a disconnected downstream replays its own durable event after a process restart', async () => {
    assert.equal((await second.process.stop()).code, 0);
    await eventually(originState, value => value.core.remote.peers.some(peer => peer.node_id === second.node_id && !peer.connected), 'downstream disconnect');
    await emit({ session: secondSession, event_id: 'headless-offline', message_id: 'offline-message', content: { text: 'queued while offline' } });
    await eventually(originState, value => value.core.remote.peers.find(peer => peer.node_id === second.node_id)?.pending === 1,
      'offline peer backlog');
    second = await startService('second');
    assert.equal(second.node_id, secondSession.node_id, 'node identity must survive restart');
    const inbox = await eventually(() => second.inbox(secondSession.session_id), value => value.messages.length === 1, 'durable reconnect replay');
    assert.match(inbox.messages[0].text, /queued while offline/);
    await eventually(originState, value => value.core.remote.peers.find(peer => peer.node_id === second.node_id)?.pending === 0, 'replayed event confirmation');
  });

  await t.test('notification-session deletion traverses the same path and suppresses later input', async () => {
    for (const [service, target] of [[first, firstSession], [second, secondSession]]) {
      await cli(service, 'thread-delete', ['--adapter', 'trae', '--session-id', target.session_id]);
    }
    assert.equal((await originState()).bot.deletes, 2);
    await emit({ session: firstSession, event_id: 'headless-deleted', message_id: 'deleted-message', content: { text: 'must not be forwarded' } });
    assert.equal((await first.inbox(firstSession.session_id)).messages.length, 0);
    assert.equal((await originState()).events.find(event => event.event_id === 'headless-deleted')?.outcome, 'deleted');
  });

  await t.test('every owned service exits on EOF without system service management', async () => {
    for (const instance of [second.process, first.process, upstreamProcess]) assert.equal((await instance.stop()).code, 0, instance.diagnostics());
    assert.equal(owned.size, 0);
  });
});
