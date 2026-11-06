import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventLog } from './events.js';
import type { PullSnapshot, RepositoryEntry } from './github.js';
import { isAgent, type AgentId, type AgentPrompt } from './agents.js';
import type { SettingsService } from './settings.js';
import { HttpError, type ServiceModule } from './types.js';
import { LarkPermissionRequiredError } from './lark-permissions.js';

export interface PullsSource { snapshot(): PullSnapshot; refresh(): void; setChoice(repository: string, follow: boolean | null): Promise<RepositoryEntry> }
export interface AgentsSource { list(): Promise<AgentPrompt[]>; set(agent: AgentId, enabled: boolean): Promise<AgentPrompt> }
export interface ChannelSummary { name: 'feishu' | 'slack' | 'telegram'; configured: boolean; recipient?: string; groups: number }
export type SettingsSource = Pick<SettingsService, 'page' | 'github' | 'startGitHubLogin' | 'cancelGitHubLogin' | 'signOutGitHub' | 'saveLark' | 'clearLark' | 'larkSecret' | 'larkRecipients' | 'setRecipient' | 'exportConfig' | 'previewImport' | 'importConfig' | 'reveal' | 'tailscale' | 'setTailscaleEnabled' | 'startTailscaleLogin' | 'cancelTailscaleLogin' | 'logoutTailscale' | 'saveChat' | 'clearChat' | 'chatSecret' | 'chatDirectory' | 'setNotificationChannel'>;
export interface UiContext {
  modules: ServiceModule[]; logs: EventLog; pulls?: PullsSource; tailnetUrl?: () => string | undefined;
  agents?: AgentsSource; channel?: () => ChannelSummary | undefined; settings?: SettingsSource;
  /** Tailscale can read public page data, but cannot retrieve secrets or change prompts/settings. */
  via?: 'loopback' | 'tailnet';
}

const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.feishucdn.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const assets = new Map([
  ['/', { path: new URL('../../public/index.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  ['/ui/styles.css', { path: new URL('../../public/styles.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/ui/app.js', { path: new URL('./ui-app.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/ui/ui-i18n.js', { path: new URL('./ui-i18n.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/ui/lark-profile.js', { path: new URL('./lark-profile.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
]);
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function smallJson(request: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(data);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}
function settingsError(error: unknown): { status: number; error: string; permission?: LarkPermissionRequiredError['permission'] } {
  return { status: error instanceof HttpError ? error.status : 500, error: (error as Error).message,
    ...(error instanceof LarkPermissionRequiredError ? { permission: error.permission } : {}) };
}
/** Streams useful batches instead of holding the entire directory behind one spinner. */
async function streamRecipients(request: IncomingMessage, response: ServerResponse, settings: SettingsSource): Promise<void> {
  const body = await smallJson(request);
  const controller = new AbortController();
  const closed = () => controller.abort();
  response.once('close', closed); request.once('aborted', closed);
  response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.flushHeaders();
  const send = (event: unknown) => { if (!controller.signal.aborted && !response.destroyed && !response.writableEnded) response.write(JSON.stringify(event) + '\n'); };
  try {
    const directory = await settings.larkRecipients(directory => send({ type: 'progress', directory }), controller.signal, body.refresh === true);
    send({ type: 'complete', directory });
  } catch (error) { send({ type: 'error', ...settingsError(error) }); }
  finally { response.off('close', closed); request.off('aborted', closed); if (!response.destroyed) response.end(); }
}
/** Matches the limit on the pulls configuration file an import may restore. */
const IMPORT_LIMIT = 1024 * 1024;
async function settingsAction(request: IncomingMessage, path: string, settings: SettingsSource): Promise<unknown> {
  if (path === '/ui/api/settings/lark/recipients') { request.resume(); return settings.larkRecipients(); }
  if (path === '/ui/api/settings/lark/secret') { request.resume(); return settings.larkSecret(); }
  if (path === '/ui/api/settings/export') { request.resume(); return settings.exportConfig(); }
  if (path === '/ui/api/settings/reveal') { request.resume(); await settings.reveal(); return { accepted: true }; }
  const body = await smallJson(request, path === '/ui/api/settings/import' ? IMPORT_LIMIT : undefined);
  const chatAction = /^\/ui\/api\/settings\/(slack|telegram)\/(secret|recipients)$/.exec(path);
  if (chatAction) {
    const channel = chatAction[1] as 'slack' | 'telegram';
    return chatAction[2] === 'secret' ? settings.chatSecret(channel, body.field) : settings.chatDirectory(channel, body);
  }
  if (path === '/ui/api/settings/github/login') {
    if (body.action === 'start') return settings.startGitHubLogin();
    if (body.action === 'cancel') return settings.cancelGitHubLogin();
    if (body.action === 'sign-out') { await settings.signOutGitHub(); return { accepted: true }; }
    throw new HttpError(400, 'Expected {"action": "start" | "cancel" | "sign-out"}');
  }
  if (path === '/ui/api/settings/tailscale') {
    if (body.action === 'enable') { await settings.setTailscaleEnabled(body.enabled); return settings.tailscale(); }
    if (body.action === 'login') return settings.startTailscaleLogin();
    if (body.action === 'cancel') { await settings.cancelTailscaleLogin(); return { accepted: true }; }
    if (body.action === 'logout') { await settings.logoutTailscale(); return { accepted: true }; }
    throw new HttpError(400, 'Expected a Tailscale action: enable, login, cancel or logout');
  }
  if (path === '/ui/api/settings/slack' || path === '/ui/api/settings/telegram') {
    const channel = path.endsWith('/slack') ? 'slack' : 'telegram';
    if (body.clear === true) await settings.clearChat(channel); else await settings.saveChat(channel, body);
    return { accepted: true };
  }
  if (path === '/ui/api/settings/channel') { await settings.setNotificationChannel(body.channel); return { accepted: true }; }
  if (path === '/ui/api/settings/lark') {
    if (body.clear === true) await settings.clearLark(); else await settings.saveLark(body.app_id, body.app_secret);
    return { accepted: true };
  }
  if (path === '/ui/api/settings/recipient') { await settings.setRecipient(body.open_id, body.app_id); return { accepted: true }; }
  if (path === '/ui/api/settings/import') return body.apply === true ? settings.importConfig(body.document) : settings.previewImport(body.document);
  throw new HttpError(404, 'No such settings action');
}
/** Read-only page data plus page actions: a background GitHub refresh, repository follow choices, and (on this Mac only) agent prompts and settings. */
export async function serveUi(request: IncomingMessage, response: ServerResponse, path: string, context: UiContext): Promise<boolean> {
  if (request.method === 'POST' && path.startsWith('/ui/api/settings/')) {
    if (request.headers['x-nootify-ui'] !== '1') { request.resume(); json(response, 403, { error: 'Missing UI request header' }); }
    // Credentials and imports decide who can reach local sessions, so they are never accepted from another device.
    else if (context.via === 'tailnet') { request.resume(); json(response, 403, { error: 'Settings can only be changed on this Mac' }); }
    else if (!context.settings) { request.resume(); json(response, 404, { error: 'Settings are not enabled' }); }
    else {
      try {
        if (path === '/ui/api/settings/lark/recipients/stream') await streamRecipients(request, response, context.settings);
        else json(response, 200, await settingsAction(request, path, context.settings));
      } catch (error) { const failure = settingsError(error); json(response, failure.status, failure); }
    }
    return true;
  }
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
  if (path === '/ui/api/settings/tailscale') {
    if (!context.settings) json(response, 404, { error: 'Settings are not enabled' });
    else {
      const tailscale = await context.settings.tailscale();
      // An authorization URL can sign this Mac in; only the local UI may receive it.
      json(response, 200, { ...tailscale, ...(context.via === 'tailnet' ? { login: { status: tailscale.login.status } } : {}), editable: context.via !== 'tailnet' });
    }
    return true;
  }
  if (path === '/ui/api/settings' || path === '/ui/api/settings/github') {
    if (!context.settings) json(response, 404, { error: 'Settings are not enabled' });
    else if (path === '/ui/api/settings') json(response, 200, { ...await context.settings.page(), editable: context.via !== 'tailnet' });
    else {
      const github = await context.settings.github();
      // A device code signs this Mac's Nootify in, so it stays with whoever is sitting at it.
      json(response, 200, context.via === 'tailnet' ? { ...github, login: { status: github.login.status } } : github);
    }
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
      lastSuccessAt: pulls.refresh.lastSuccessAt, error: pulls.refresh.error, signedOut: pulls.refresh.signedOut } } : {}),
    access: tailnet ? { tailnet_url: tailnet } : {},
  });
  return true;
}
