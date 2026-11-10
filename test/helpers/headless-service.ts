// Test-only process wiring. No desktop, discovery, updater, GitHub or platform
// service manager is instantiated; all state and listeners belong to the suite.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { isAbsolute, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { State } from '../../src/state.js';
import { EventLog } from '../../src/events.js';
import { SessionsService } from '../../src/sessions.js';
import { ProvidersService } from '../../src/providers.js';
import { createServiceHost } from '../../src/server.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'state-dir': { type: 'string' } } });
  const directory = values['state-dir'];
  const workspace = process.env.NOOTIFY_HEADLESS_WORKSPACE;
  if (!directory || !isAbsolute(directory) || !workspace || !isAbsolute(workspace)
    || !process.env.NOOTIFY_CORE_BIN || !isAbsolute(process.env.NOOTIFY_CORE_BIN)) {
    throw new Error('Headless fixture requires explicit absolute workspace, state and core paths');
  }
  const ownedRoot = await realpath(workspace);
  for (const path of [directory, process.env.NOOTIFY_CORE_BIN]) {
    const inside = relative(ownedRoot, await realpath(path));
    if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
      throw new Error('Headless fixture refuses state or binaries outside its private workspace');
    }
  }
  const state = await State.open(directory);
  const logs = await EventLog.open(directory);
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const report = (record: Record<string, unknown>) => logs.report(record);
  const sessions = new SessionsService(state, undefined, report, undefined, { port });
  const providers = new ProvidersService(state, sessions, undefined, report, port);
  createServiceHost([sessions, providers], state.token, logs, { providers }, server);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    server.closeAllConnections();
    await providers.stop();
    await sessions.stop();
    await logs.flush();
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.stdin.destroy();
  })();
  try {
    await providers.start();
    if (providers.status() !== 'ready') throw new Error('Headless provider core failed to start');
    const page = await providers.page();
    const shutdown = () => { void stop().catch(error => { console.error((error as Error).message); process.exitCode = 1; }); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    process.stdin.once('end', shutdown);
    process.stdin.resume();
    process.stdout.write(JSON.stringify({ kind: 'service-ready', headless: true, pid: process.pid,
      url: `http://127.0.0.1:${port}`, port, token: state.token, node_id: page.node_id }) + '\n');
  } catch (error) {
    await stop();
    throw error;
  }
}
void main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
