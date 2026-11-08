import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { State } from './state.js';
import { SessionsService } from './sessions.js';
import { LarkService } from './lark.js';
import { resolveCredentials } from './lark-metadata.js';
import { HttpError, RetryableDeliveryError, UnconfirmedDeliveryError } from './types.js';
import type { ServiceModule } from './types.js';
import { EventLog } from './events.js';
import { serveUi } from './ui.js';
import type { PullsSource } from './ui.js';
import { PullRequestsService } from './github.js';
import { TailnetAccess } from './tailnet.js';
import { TailscaleService } from './tailscale.js';
import { TsnetClient } from './tsnet-client.js';
import { listenTailnetProxy } from './tailnet-proxy.js';
import { AgentPrompts } from './agents.js';
import { sessionThreadDiscovery } from './session-threads.js';
import { GitHubAuth } from './github-auth.js';
import { SettingsService } from './settings.js';
import type { AgentsSource, ChannelSummary, SettingsSource } from './ui.js';

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
  peerAddress?: (socket: Socket) => string | undefined;
  agents?: AgentsSource; channel?: () => ChannelSummary | undefined; settings?: SettingsSource;
}
const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolveListen(); });
  });
}
export function createServiceHost(modules: ServiceModule[], token: string, logs?: EventLog, options: HostOptions = {}, server: Server = createServer()): Server {
  server.on('request', async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      // Browsers cannot forge Host, which blocks DNS rebinding on both listeners.
      const host = (request.headers.host ?? '').toLowerCase();
      if (options.via === 'tailnet') {
        const rejected = options.tailnet ? await options.tailnet.authorize(host, options.peerAddress ? options.peerAddress(request.socket) : request.socket.remoteAddress) : 'Tailnet access is not configured';
        if (rejected) throw new HttpError(403, rejected);
      } else if (!loopback.test(host)) throw new HttpError(403, 'Only loopback hosts are accepted');
      const isPageNavigation = request.method === 'GET' && request.url === '/' && request.headers['sec-fetch-dest'] === 'document';
      if (!isPageNavigation && request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) throw new HttpError(403, 'Cross-site requests are not accepted');
      if (request.headers.origin && request.headers.origin !== `http://${host}`) throw new HttpError(403, 'Cross-origin requests are not accepted');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (logs && await serveUi(request, response, url.pathname, { modules, logs, pulls: options.pulls, tailnetUrl: () => options.tailnet?.url(),
        agents: options.agents, channel: options.channel, settings: options.settings, via: options.via ?? 'loopback' })) return;
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
      const status = error instanceof HttpError ? error.status : error instanceof UnconfirmedDeliveryError ? 409 : error instanceof RetryableDeliveryError ? 503 : 500;
      send(status, { error: (error as Error).message });
    }
  });
  return server;
}
export async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '9417' }, 'state-dir': { type: 'string' }, 'mcp-config': { type: 'string' },
  } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  // Reserve the service before State.open can establish SQLite as the authority over legacy JSON.
  const starting = (_request: IncomingMessage, response: import('node:http').ServerResponse) => {
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
    response.end(JSON.stringify({ service: 'nootify', status: 'starting' }));
  };
  const server = createServer(starting);
  await listen(server, port, '127.0.0.1');
  const closeServer = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  };
  let shutdown = closeServer;
  try {
    const state = await State.open(values['state-dir']);
    const logs = await EventLog.open(state.directory);
    const report = (record: Record<string, unknown>) => { logs.report(record); };
    const sessions = new SessionsService(state, undefined, report, undefined, { port });
    const resolved = await resolveCredentials(process.env, state.settings, values['mcp-config']);
    // Routine five-minute refreshes would push Feishu events out of the bounded log; record outcome changes only.
    let pullsOutcome: unknown;
    const pulls = new PullRequestsService(state.directory, record => {
      if (record.status === pullsOutcome) return;
      pullsOutcome = record.status;
      report({ source: 'pulls', ...record });
    }, undefined, undefined, () => state.settings.github_token);
    const tsnet = new TsnetClient(join(state.directory, 'tailscale'));
    const tailnet = new TailnetAccess(80, { users: process.env.NOOTIFY_TAILNET_USERS?.split(',').map(user => user.trim()).filter(Boolean), probe: tsnet });
    const peers = new WeakMap<Socket, string>();
    const tailscale = new TailscaleService({ state, access: tailnet, client: tsnet, report, listen: () => listenTailnetProxy(tailnetServer, peers) });
    const agents = new AgentPrompts({ stateDir: state.directory, port, tailnetAddress: () => { const url = tailnet.url(); return url ? new URL(url).hostname : undefined; } }, report);
    const lark = new LarkService(state, sessions, resolved?.credentials, report, undefined, port, undefined,
      sessionThreadDiscovery(agents, state, report));
    const modules: ServiceModule[] = [sessions, lark, pulls, agents];
    const github = new GitHubAuth(state, report, () => pulls.refreshSoon());
    const settings = new SettingsService({ state, lark, github, pulls, agents, tailscale, mcpConfig: values['mcp-config'], source: resolved?.source, report });
    const channel = (): ChannelSummary => lark.channel();
    const page = { pulls, tailnet, agents, channel, settings };
    const tailnetServer = createServiceHost(modules, state.token, logs, { ...page, via: 'tailnet', peerAddress: socket => peers.get(socket) });
    server.off('request', starting);
    createServiceHost(modules, state.token, logs, page, server);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await tailscale.stop();
      await settings.stop();
      for (const module of [...modules].reverse()) await module.stop?.();
      await logs.flush();
      await closeServer();
    };
    shutdown = stop;
    report({ status: 'ready', service: 'nootify', port });
    for (const module of modules) await module.start?.();
    // The embedded device owns tailnet port 80; its private backend preserves the original peer address.
    await tailscale.start();
    process.once('SIGTERM', () => { void stop(); });
    process.once('SIGINT', () => { void stop(); });
  } catch (error) {
    await shutdown().catch(() => {});
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ status: 'failed', error: (error as Error).message })); process.exitCode = 1; });
}
