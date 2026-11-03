import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventLog } from './events.js';
import type { PullSnapshot } from './github.js';
import type { ServiceModule } from './types.js';

export interface PullsSource { snapshot(): PullSnapshot; refresh(): void }
export interface UiContext { modules: ServiceModule[]; logs: EventLog; pulls?: PullsSource; tailnetUrl?: () => string | undefined }

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
/** Read-only page data plus one idempotent action: starting a coalesced background GitHub refresh. */
export async function serveUi(request: IncomingMessage, response: ServerResponse, path: string, context: UiContext): Promise<boolean> {
  if (request.method === 'POST' && path === '/ui/api/pulls/refresh') {
    request.resume();
    // A custom header forces a CORS preflight, which this server never grants to other origins.
    if (request.headers['x-nootify-ui'] !== '1') json(response, 403, { error: 'Missing UI request header' });
    else if (!context.pulls) json(response, 404, { error: 'PR module is not enabled' });
    else { context.pulls.refresh(); json(response, 202, { accepted: true }); }
    return true;
  }
  if (request.method !== 'GET') return false;
  const asset = assets.get(path);
  if (asset) {
    response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': policy });
    response.end(await readFile(asset.path));
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
      lastSuccessAt: pulls.refresh.lastSuccessAt, error: pulls.refresh.error } } : {}),
    access: tailnet ? { tailnet_url: tailnet } : {},
  });
  return true;
}
