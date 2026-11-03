import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventLog } from './events.js';
import type { PullSnapshot, RepositoryEntry } from './github.js';
import { isAgent, type AgentId, type AgentPrompt } from './agents.js';
import { HttpError, type ServiceModule } from './types.js';

export interface PullsSource { snapshot(): PullSnapshot; refresh(): void; setChoice(repository: string, follow: boolean | null): Promise<RepositoryEntry> }
export interface AgentsSource { list(): Promise<AgentPrompt[]>; set(agent: AgentId, enabled: boolean): Promise<AgentPrompt> }
export interface ChannelSummary { name: 'feishu'; configured: boolean; recipient?: string; groups: number }
export interface UiContext {
  modules: ServiceModule[]; logs: EventLog; pulls?: PullsSource; tailnetUrl?: () => string | undefined;
  agents?: AgentsSource; channel?: () => ChannelSummary | undefined;
  /** Requests on the Tailscale listener can read everything but cannot change agent prompts. */
  via?: 'loopback' | 'tailnet';
}

const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const assets = new Map([
  ['/', { path: new URL('../../public/index.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  ['/ui/styles.css', { path: new URL('../../public/styles.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/ui/app.js', { path: new URL('./ui-app.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
]);
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function smallJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 4096) throw new HttpError(413, 'Request body is too large');
    chunks.push(data);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}
/** Read-only page data plus page actions: a background GitHub refresh, repository follow choices, and (on this Mac only) agent prompts. */
export async function serveUi(request: IncomingMessage, response: ServerResponse, path: string, context: UiContext): Promise<boolean> {
  if (request.method === 'POST' && path === '/ui/api/agents') {
    if (request.headers['x-nootify-ui'] !== '1') { request.resume(); json(response, 403, { error: 'Missing UI request header' }); }
    // A prompt edit changes what every future agent session does, so it is never accepted from another device.
    else if (context.via === 'tailnet') { request.resume(); json(response, 403, { error: 'Agent prompts can only be changed on this Mac' }); }
    else if (!context.agents) { request.resume(); json(response, 404, { error: 'Agents module is not enabled' }); }
    else {
      try {
        const body = await smallJson(request);
        if (!isAgent(body.agent) || typeof body.enabled !== 'boolean') throw new HttpError(400, 'Expected {"agent": "claude" | "codex" | "opencode", "enabled": boolean}');
        json(response, 200, await context.agents.set(body.agent, body.enabled));
      } catch (error) { json(response, error instanceof HttpError ? error.status : 500, { error: (error as Error).message }); }
    }
    return true;
  }
  if (request.method === 'POST' && (path === '/ui/api/pulls/refresh' || path === '/ui/api/repos')) {
    // A custom header forces a CORS preflight, which this server never grants to other origins.
    if (request.headers['x-nootify-ui'] !== '1') { request.resume(); json(response, 403, { error: 'Missing UI request header' }); }
    else if (!context.pulls) { request.resume(); json(response, 404, { error: 'PR module is not enabled' }); }
    else if (path === '/ui/api/pulls/refresh') { request.resume(); context.pulls.refresh(); json(response, 202, { accepted: true }); }
    else {
      try {
        const body = await smallJson(request);
        json(response, 200, await context.pulls.setChoice(String(body.repository), body.follow as boolean | null));
      } catch (error) { json(response, error instanceof HttpError ? error.status : 500, { error: (error as Error).message }); }
    }
    return true;
  }
  if (request.method !== 'GET') return false;
  const asset = assets.get(path);
  if (asset) {
    response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': policy });
    response.end(await readFile(asset.path));
    return true;
  }
  if (path === '/ui/api/agents') {
    if (!context.agents) json(response, 404, { error: 'Agents module is not enabled' });
    else json(response, 200, { agents: await context.agents.list(), editable: context.via !== 'tailnet', channel: context.channel?.() });
    return true;
  }
  if (path === '/ui/api/pulls') {
    if (context.pulls) json(response, 200, context.pulls.snapshot()); else json(response, 404, { error: 'PR module is not enabled' });
    return true;
  }
  if (path !== '/ui/api/snapshot') return false;
  const sessions = await context.modules.find(module => module.name === 'sessions')?.handle({ method: 'GET', path: '/v1/sessions', body: undefined });
  const pulls = context.pulls?.snapshot();
  const tailnet = context.tailnetUrl?.();
  json(response, 200, {
    time: new Date().toISOString(), modules: context.modules.map(module => ({ name: module.name, status: module.status() })),
    sessions: sessions?.body ?? [], logs: context.logs.recent(),
    ...(pulls ? { pulls: { internal: pulls.internal.length, upstream: pulls.upstream.length, running: pulls.refresh.running,
      followed: pulls.repositories.filter(entry => entry.followed).length,
      lastSuccessAt: pulls.refresh.lastSuccessAt, error: pulls.refresh.error } } : {}),
    access: tailnet ? { tailnet_url: tailnet } : {},
  });
  return true;
}
