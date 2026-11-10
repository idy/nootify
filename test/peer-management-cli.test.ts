import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createServiceHost } from '../src/server.js';
import type { RouteRequest, ServiceModule } from '../src/types.js';

// Private CLI/HTTP fixture: no signing identity, native manager or live provider is used.
test('owner CLI exposes public peer identity, binding and basic legacy bind without inventing metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nootify-peer-cli-')); const token = 'synthetic-cli-owner';
  await writeFile(join(root, 'auth-token'), token, { mode: 0o600 });
  const calls: RouteRequest[] = [];
  const fixture: ServiceModule = { name: 'peer-cli-fixture', status: () => 'ready', async handle(request) {
    calls.push(request);
    if (request.path === '/v1/remote/identity') return { body: { node_id: 'peer-node', public_key: 'synthetic-public-key' } };
    if (request.path === '/v1/remote/peers/peer-node') return { body: { node_id: 'peer-node', identity_status: 'pinned' } };
    if (request.path === '/v1/lark/bindings/oc_owned') return { body: { chat_id: 'oc_owned' } };
    return undefined;
  } };
  const server = createServiceHost([fixture], token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const port = (server.address() as { port: number }).port; const execute = promisify(execFile);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = async (command: string, ...args: string[]) => JSON.parse((await execute(process.execPath,
    [cli, command, '--state-dir', root, '--port', String(port), ...args], { timeout: 15000, windowsHide: true })).stdout);
  assert.equal((await run('node-identity')).public_key, 'synthetic-public-key');
  assert.equal((await run('peer-bind', '--peer-node-id', 'peer-node', '--public-key', 'synthetic-public-key')).identity_status, 'pinned');
  assert.deepEqual(calls[1]!.body, { public_key: 'synthetic-public-key' });
  await run('lark-bind', '--chat-id', 'oc_owned', '--session-id', 'session-owned', '--sender-id', 'ou_owner', '--adapter', 'workbuddy');
  assert.equal(Object.hasOwn(calls[2]!.body as object, 'metadata'), false, 'omitted legacy flag must not force an unsupported announcement mode');
  await assert.rejects(run('peer-bind', '--peer-node-id', 'peer-node'), /Missing --public-key/);
});
