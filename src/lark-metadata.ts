import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as sdk from '@larksuiteoapi/node-sdk';
import type { Settings } from './state.js';
import type { RemoteBinding } from './types.js';

export interface Credentials { appId: string; appSecret: string }
export type CredentialSource = 'environment' | 'settings' | 'mcp-config';
export interface LarkApi {
  appId: string;
  /** Last provider Date header extrapolated with monotonic elapsed time, when available. */
  serverTime?(): number | undefined;
  request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
}
const REQUEST_TIMEOUT_MS = 10_000;
/** Bound the whole operation as well as forwarding cancellation to the underlying HTTP transport. */
export async function requestLark<T>(api: LarkApi, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown,
  signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  deadline.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(deadline.reason);
    deadline.addEventListener('abort', abort, { once: true });
  });
  try {
    const pending = Promise.resolve().then(() => { deadline.throwIfAborted(); return api.request<T>(method, path, body, deadline); });
    const result = await Promise.race([pending, cancelled]);
    deadline.throwIfAborted();
    return result;
  } finally { deadline.removeEventListener('abort', abort); }
}
export function boundedLarkApi(delegate: LarkApi, timeoutMs = REQUEST_TIMEOUT_MS): LarkApi {
  return { appId: delegate.appId, ...(delegate.serverTime ? { serverTime: () => delegate.serverTime!() } : {}),
    request: <T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, signal?: AbortSignal) =>
      requestLark<T>(delegate, method, path, body, signal, timeoutMs) };
}
/** Capture activation in the provider's clock if the host is materially skewed. */
export function larkActivationTime(api: LarkApi, localStart: number, elapsed: number): number {
  const provider = api.serverTime?.();
  const providerStart = provider === undefined ? undefined : provider - elapsed;
  return providerStart !== undefined && Math.abs(providerStart - localStart) > REQUEST_TIMEOUT_MS ? Math.floor(providerStart) : localStart;
}
export const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
export interface LarkPermission { url?: string; scopes: string[] }
/** Keep only public permission names and an app-matching official console link. */
export function permissionDetails(value: unknown, appId: string): LarkPermission | undefined {
  if (!value || typeof value !== 'object') return;
  const body = value as { code?: number; msg?: string; console_url?: string; error?: { console_url?: string; helps?: { url?: string }[]; permission_violations?: { subject?: string; scope?: string }[] } };
  if (![99991672, 99991679, 99991668, 40004, 41050].includes(body.code ?? 0)) return;
  const message = typeof body.msg === 'string' ? body.msg : '';
  const scopes = new Set(message.match(/\bcontact:[a-z0-9_.]+(?::[a-z0-9_.]+)?\b/g) ?? []);
  for (const violation of Array.isArray(body.error?.permission_violations) ? body.error.permission_violations : []) {
    if (!violation || typeof violation !== 'object') continue;
    for (const name of [violation.scope, violation.subject]) if (typeof name === 'string' && /^contact:[a-z0-9_.]+(?::[a-z0-9_.]+)?$/.test(name)) scopes.add(name);
  }
  const helps = Array.isArray(body.error?.helps) ? body.error.helps.map(help => help && typeof help === 'object' ? help.url : undefined) : [];
  const candidates = [body.console_url, body.error?.console_url, ...helps, ...(message.match(/https:\/\/open\.feishu\.cn\/app\/[^\s<>"']+/g) ?? [])];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname === 'open.feishu.cn' && !url.username && !url.password && !url.port && url.pathname === `/app/${appId}/auth`) {
        return { url: candidate, scopes: [...scopes] };
      }
    } catch { /* Ignore provider text that is not a permission URL. */ }
  }
  return { scopes: [...scopes] };
}
export class ApiError extends Error {
  constructor(public code: number, message = 'request failed', readonly permission?: LarkPermission) { super(`Feishu API ${code}: ${message}`); }
}
export async function loadCredentials(env: NodeJS.ProcessEnv, mcpConfig?: string): Promise<Credentials | undefined> {
  if (env.LARK_APP_ID && env.LARK_APP_SECRET) return { appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET };
  if (env.LARK_APP_ID || env.LARK_APP_SECRET) throw new Error('Set both LARK_APP_ID and LARK_APP_SECRET');
  if (!mcpConfig) return;
  const config = JSON.parse(await readFile(mcpConfig, 'utf8')) as {
    mcpServers?: { lark?: { args?: string[]; env?: Record<string, string> } };
  };
  const server = config.mcpServers?.lark;
  if (!server) return;
  const args = server.args ?? [];
  const argument = (...flags: string[]) => {
    for (const flag of flags) { const index = args.indexOf(flag); if (index >= 0) return args[index + 1]; }
  };
  const appId = server?.env?.LARK_APP_ID ?? argument('-a', '--app-id');
  const appSecret = server?.env?.LARK_APP_SECRET ?? argument('-s', '--app-secret');
  if (!appId || !appSecret) throw new Error('Selected MCP config has no supported lark application credentials');
  return { appId, appSecret };
}
/** Environment variables name this one process; a saved choice then beats the MCP file picked at install time. */
export async function resolveCredentials(env: NodeJS.ProcessEnv, saved: Settings, mcpConfig?: string): Promise<{ credentials: Credentials; source: CredentialSource } | undefined> {
  if (env.LARK_APP_ID || env.LARK_APP_SECRET) {
    const credentials = await loadCredentials(env);
    return credentials && { credentials, source: 'environment' };
  }
  if (saved.lark_app_id && saved.lark_app_secret) return { credentials: { appId: saved.lark_app_id, appSecret: saved.lark_app_secret }, source: 'settings' };
  const credentials = await loadCredentials(env, mcpConfig);
  return credentials && { credentials, source: 'mcp-config' };
}
/** Asks Feishu for a tenant token, so a mistyped ID or secret is refused before it replaces a working bot. */
export async function verifyCredentials(credentials: Credentials): Promise<void> {
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }), signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as { code?: number; msg?: string };
  if (body.code !== 0) throw new ApiError(body.code ?? response.status, body.msg);
}
export function createLarkApi(credentials: Credentials, timeoutMs = REQUEST_TIMEOUT_MS): LarkApi {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Invalid Feishu request timeout');
  // A separate Axios instance bounds SDK token acquisition too, without changing global SDK defaults.
  const http = sdk.defaultHttpInstance.create({ timeout: timeoutMs, headers: { 'User-Agent': 'Nootify' } });
  let clock: { epoch: number; at: number } | undefined;
  http.interceptors.request.use(config => {
    const deadline = AbortSignal.timeout(timeoutMs);
    config.signal = config.signal ? AbortSignal.any([config.signal as AbortSignal, deadline]) : deadline;
    return config;
  }, undefined, { synchronous: true });
  http.interceptors.response.use(response => {
    const epoch = Date.parse(String(response.headers.date ?? ''));
    if (Number.isFinite(epoch)) clock = { epoch, at: performance.now() };
    // Match the SDK's response-body contract, including its optional header-return mode.
    return (response.config as { $return_headers?: boolean }).$return_headers ? { data: response.data, headers: response.headers } : response.data;
  });
  const client = new sdk.Client({ ...credentials, domain: sdk.Domain.Feishu, appType: sdk.AppType.SelfBuild, logger: quietLogger,
    // The response interceptor establishes the SDK's unwrapped-body transport contract.
    httpInstance: http as unknown as sdk.HttpInstance });
  return boundedLarkApi({ appId: credentials.appId,
    serverTime: () => clock && clock.epoch + Math.max(0, performance.now() - clock.at),
    async request<T>(method: 'GET' | 'POST' | 'PATCH', url: string, data?: unknown, signal?: AbortSignal): Promise<T> {
    let response: { code: number; msg?: string; data: T };
    try { response = await client.request({ method, url, data, signal }); }
    catch (error) {
      const body = (error as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
      if (typeof body?.code === 'number') throw new ApiError(body.code, body.msg, permissionDetails(body, credentials.appId));
      throw error;
    }
    if (response.code !== 0) throw new ApiError(response.code, response.msg, permissionDetails(response, credentials.appId));
    return response.data;
  } }, timeoutMs);
}
export function bindingToken(binding: Pick<RemoteBinding, 'host_id' | 'adapter' | 'session_id'>): string {
  for (const value of [binding.host_id, binding.adapter, binding.session_id]) {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error('Invalid binding identifier');
  }
  return `agent-session:v1:${binding.host_id}:${binding.adapter}:${binding.session_id}`;
}
export function bindingTokens(content: unknown): string[] {
  return [...new Set((JSON.stringify(content) ?? '').match(/agent-session:v1:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+/g) ?? [])];
}
export function assertMetadata(content: unknown, binding: RemoteBinding): void {
  const tokens = bindingTokens(content);
  if (tokens.length !== 1 || tokens[0] !== bindingToken(binding)) throw new Error('Remote metadata does not uniquely match the local session binding');
}
export interface AnnouncementRoute { session_id: string; adapter: string; host_id?: string }
export class InvalidAnnouncement extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function announcementText(value: unknown): string {
  if (typeof value === 'string') {
    try { return announcementText(JSON.parse(value)); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(announcementText).join('\n');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.elements)) return record.elements.map(announcementText).join('');
  if (record.text_run && typeof record.text_run === 'object') return String((record.text_run as { content?: string }).content ?? '');
  if (record.textRun && typeof record.textRun === 'object') return String((record.textRun as { text?: string }).text ?? '');
  return Object.values(record).map(announcementText).join('\n');
}
export function parseAnnouncement(content: unknown): AnnouncementRoute {
  const text = announcementText(content);
  const routes = new Map<string, AnnouncementRoute>();
  for (const match of text.matchAll(/agent-session:v1:([A-Za-z0-9._-]+):([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)/g)) {
    const route = { host_id: match[1], adapter: match[2], session_id: match[3] };
    routes.set(JSON.stringify(route), route);
  }
  // Existing session announcements often identify Desktop sessions by their full local_ ID.
  for (const match of text.matchAll(/\blocal_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi)) {
    if (![...routes.values()].some(route => route.session_id === match[0])) {
      const route = { adapter: 'claude-desktop', session_id: match[0] };
      routes.set(JSON.stringify(route), route);
    }
  }
  const labeled: [string, RegExp][] = [
    ['codex', /\bCodex\s*(?:thread|session|会话)?\s*[:：]?\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/gi],
    ['opencode', /\bOpen\s?Code\s*(?:thread|session|会话)?\s*[:：]?\s*(ses_[A-Za-z0-9]+)\b/gi],
  ];
  for (const [adapter, pattern] of labeled) for (const match of text.matchAll(pattern)) {
    if (![...routes.values()].some(route => route.session_id === match[1] && route.adapter === adapter)) {
      const route = { adapter, session_id: match[1] }; routes.set(JSON.stringify(route), route);
    }
  }
  if (routes.size !== 1) throw new InvalidAnnouncement(routes.size ? 'ambiguous_announcement' : 'missing_announcement');
  return [...routes.values()][0];
}
interface Announcement { kind: 'doc' | 'docx'; revision: string | number; content: unknown; path: string }
export async function readAnnouncement(api: LarkApi, chatId: string, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)): Promise<Announcement> {
  const path = `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/announcement`;
  try {
    const data = await requestLark<{ revision: string; content: unknown }>(api, 'GET', path, undefined, signal);
    return { kind: 'doc', revision: data.revision, content: data.content, path };
  } catch (error) { if (!(error instanceof ApiError) || error.code !== 232097) throw error; }
  const docxPath = `/open-apis/docx/v1/chats/${encodeURIComponent(chatId)}/announcement`;
  const metadata = await requestLark<{ revision_id: number }>(api, 'GET', docxPath, undefined, signal);
  const blocks: unknown[] = [];
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({ page_size: '500', revision_id: String(metadata.revision_id) });
    if (pageToken) query.set('page_token', pageToken);
    const page = await requestLark<{ items?: unknown[]; has_more?: boolean; page_token?: string }>(api, 'GET', `${docxPath}/blocks?${query}`, undefined, signal);
    blocks.push(...(page.items ?? []));
    if (page.has_more && (!page.page_token || tokens.has(page.page_token))) throw new Error('Invalid announcement page token');
    pageToken = page.has_more ? page.page_token : undefined;
    if (pageToken) tokens.add(pageToken);
  } while (pageToken);
  return { kind: 'docx', revision: metadata.revision_id, content: blocks, path: docxPath };
}
export async function ensureAnnouncement(api: LarkApi, binding: RemoteBinding, signal?: AbortSignal): Promise<void> {
  const announcement = await readAnnouncement(api, binding.chat_id, signal);
  const token = bindingToken(binding);
  if (bindingTokens(announcement.content).length) { assertMetadata(announcement.content, binding); return; }
  if (announcement.kind === 'doc') {
    const operation = { requestType: 'InsertBlocksRequestType', insertBlocksRequest: {
      payload: JSON.stringify({ blocks: [{ type: 'paragraph', paragraph: {
        elements: [{ type: 'textRun', textRun: { text: token, style: {} } }], style: {},
      } }] }), location: { zoneId: '0', index: 0, endOfZone: true },
    } };
    await requestLark(api, 'PATCH', announcement.path, { revision: String(announcement.revision), requests: [JSON.stringify(operation)] }, signal);
  } else {
    const query = new URLSearchParams({ revision_id: String(announcement.revision), client_token: randomUUID() });
    await requestLark(api, 'POST', `${announcement.path}/blocks/${encodeURIComponent(binding.chat_id)}/children?${query}`, {
      children: [{ block_type: 2, text: { elements: [{ text_run: { content: token } }] } }],
    }, signal);
  }
  assertMetadata((await readAnnouncement(api, binding.chat_id, signal)).content, binding);
}
export async function readRemoteBinding(api: LarkApi, binding: RemoteBinding): Promise<unknown> {
  if (!binding.registration_message_id) return (await readAnnouncement(api, binding.chat_id)).content;
  interface RemoteMessage { message_id: string; chat_id: string; msg_type: string; deleted?: boolean;
    sender: { sender_type: string; id: string }; body: { content: string } }
  const data = await api.request<{ items?: RemoteMessage[] }>('GET', `/open-apis/im/v1/messages/${encodeURIComponent(binding.registration_message_id)}`);
  const message = data.items?.find(item => item.message_id === binding.registration_message_id);
  if (!message || message.deleted || message.chat_id !== binding.chat_id || message.msg_type !== 'text' ||
      message.sender.sender_type !== 'app' || message.sender.id !== api.appId) throw new Error('Binding message is missing or has another author/chat');
  return (JSON.parse(message.body.content) as { text?: unknown }).text;
}
export async function ensureBindingMessage(api: LarkApi, binding: RemoteBinding): Promise<string> {
  if (binding.registration_message_id) { assertMetadata(await readRemoteBinding(api, binding), binding); return binding.registration_message_id; }
  const token = bindingToken(binding);
  const message = await api.request<{ message_id: string }>('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: binding.chat_id, msg_type: 'text',
    content: JSON.stringify({ text: `[${binding.session_name}] Session binding\n${token}\nReplies from the configured user are routed to this session while Nootify runs.` }),
    uuid: createHash('sha256').update(`${binding.chat_id}\n${token}`).digest('hex').slice(0, 32),
  });
  if (!message.message_id) throw new Error('Feishu returned no binding message ID');
  assertMetadata(await readRemoteBinding(api, { ...binding, registration_message_id: message.message_id }), binding);
  return message.message_id;
}
