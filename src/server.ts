import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { State } from './state.js';
import { SessionsService } from './sessions.js';
import { LarkService } from './lark.js';
import { loadCredentials } from './lark-metadata.js';
import { HttpError } from './types.js';
import type { ServiceModule } from './types.js';
import { EventLog } from './events.js';
import { serveUi } from './ui.js';
import type { PullsSource } from './ui.js';
import { PullRequestsService } from './github.js';
import { TailnetAccess } from './tailnet.js';
import { AgentPrompts } from './agents.js';
import type { AgentsSource, ChannelSummary } from './ui.js';

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 65536) throw new HttpError(413, 'Request body is too large');
    chunks.push(data);
  }
  if (!size) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
/** `via: 'tailnet'` marks the listener bound to this node's Tailscale address. */
export interface HostOptions {
  pulls?: PullsSource; tailnet?: TailnetAccess; via?: 'loopback' | 'tailnet';
  agents?: AgentsSource; channel?: () => ChannelSummary | undefined;
}
const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolveListen(); });
  });
}
export function createServiceHost(modules: ServiceModule[], token: string, logs?: EventLog, options: HostOptions = {}): Server {
  return createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      // Browsers cannot forge Host, which blocks DNS rebinding on both listeners.
      const host = (request.headers.host ?? '').toLowerCase();
      if (options.via === 'tailnet') {
        const rejected = options.tailnet ? await options.tailnet.authorize(host, request.socket.remoteAddress) : 'Tailnet access is not configured';
        if (rejected) throw new HttpError(403, rejected);
      } else if (!loopback.test(host)) throw new HttpError(403, 'Only loopback hosts are accepted');
      const isPageNavigation = request.method === 'GET' && request.url === '/' && request.headers['sec-fetch-dest'] === 'document';
      if (!isPageNavigation && request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) throw new HttpError(403, 'Cross-site requests are not accepted');
      if (request.headers.origin && request.headers.origin !== `http://${host}`) throw new HttpError(403, 'Cross-origin requests are not accepted');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (logs && await serveUi(request, response, url.pathname, { modules, logs, pulls: options.pulls, tailnetUrl: () => options.tailnet?.url(),
        agents: options.agents, channel: options.channel, via: options.via ?? 'loopback' })) return;
      if (request.headers.origin) throw new HttpError(403, 'Browser-origin requests are not accepted for control APIs');
      const statuses = () => modules.map(module => ({ name: module.name, status: module.status() }));
      if (request.method === 'GET' && url.pathname === '/health') { send(200, { ok: true, service: 'nootify', modules: statuses() }); return; }
      const actual = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'Unauthorized');
      if (request.method === 'GET' && url.pathname === '/v1/services') { send(200, statuses()); return; }
      const input = { method: request.method ?? 'GET', path: url.pathname, body: await readBody(request) };
      for (const module of modules) {
        const result = await module.handle(input);
        if (result) { send(result.status ?? 200, result.body); return; }
      }
      throw new HttpError(404, 'No such service endpoint');
    } catch (error) {
      send(error instanceof HttpError ? error.status : 500, { error: (error as Error).message });
    }
  });
}
export async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '9417' }, 'state-dir': { type: 'string' }, 'mcp-config': { type: 'string' },
  } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const state = await State.open(values['state-dir']);
  const logs = await EventLog.open(state.directory);
  const report = (record: Record<string, unknown>) => { logs.report(record); };
  const sessions = new SessionsService(state, undefined, report);
  const lark = new LarkService(state, sessions, await loadCredentials(process.env, values['mcp-config']), report, undefined, port);
  // Routine five-minute refreshes would push Feishu events out of the bounded log; record outcome changes only.
  let pullsOutcome: unknown;
  const pulls = new PullRequestsService(state.directory, record => {
    if (record.status === pullsOutcome) return;
    pullsOutcome = record.status;
    report({ source: 'pulls', ...record });
  });
  const tailnet = new TailnetAccess(port, { users: process.env.NOOTIFY_TAILNET_USERS?.split(',').map(user => user.trim()).filter(Boolean) });
  const agents = new AgentPrompts({ stateDir: state.directory, port, tailnetAddress: () => { const url = tailnet.url(); return url ? new URL(url).hostname : undefined; } }, report);
  const modules: ServiceModule[] = [sessions, lark, pulls, agents];
  const page = { pulls, tailnet, agents, channel: () => lark.channel() };
  const server = createServiceHost(modules, state.token, logs, page);
  await listen(server, port, '127.0.0.1');
  report({ status: 'ready', service: 'nootify', port });
  for (const module of modules) await module.start?.();

  // A second listener on this node's Tailscale IPv4 address serves the owner's other devices.
  // It follows the address if Tailscale restarts, and logs only changes in outcome.
  const tailnetServer = createServiceHost(modules, state.token, logs, { ...page, via: 'tailnet' });
  let bound: string | undefined;
  let lastNote: string | undefined;
  let binding: Promise<void> | undefined;
  const note = (record: Record<string, unknown>) => {
    const key = JSON.stringify(record);
    if (key !== lastNote) { lastNote = key; report({ source: 'host', ...record }); }
  };
  const unbind = async () => {
    if (!bound) return;
    tailnetServer.closeAllConnections();
    await new Promise(resolveClose => tailnetServer.close(resolveClose));
    bound = undefined; tailnet.setListening(undefined);
  };
  const bindTailnet = () => binding ??= (async () => {
    const address = (await tailnet.current())?.address;
    if (address === bound) return;
    await unbind();
    if (!address) { note({ status: 'tailnet_unavailable' }); return; }
    try {
      await listen(tailnetServer, port, address);
      bound = address; tailnet.setListening(address);
      note({ status: 'tailnet_listening', reason: tailnet.url() });
    } catch (error) { note({ status: 'tailnet_failed', error: (error as Error).message }); }
  })().finally(() => { binding = undefined; });
  await bindTailnet();
  const tailnetTimer = setInterval(() => { void bindTailnet(); }, 60_000);
  tailnetTimer.unref();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(tailnetTimer);
    await binding;
    await unbind();
    for (const module of [...modules].reverse()) await module.stop?.();
    await logs.flush();
    server.closeAllConnections();
    server.close();
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ status: 'failed', error: (error as Error).message })); process.exitCode = 1; });
}
