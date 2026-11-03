import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as sdk from '@larksuiteoapi/node-sdk';
import type { RemoteBinding } from './types.js';

export interface Credentials { appId: string; appSecret: string }
export interface LarkApi {
  appId: string;
  request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T>;
}
export const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
export class ApiError extends Error {
  constructor(public code: number, message = 'request failed') { super(`Feishu API ${code}: ${message}`); }
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
export function createLarkApi(credentials: Credentials): LarkApi {
  const client = new sdk.Client({ ...credentials, domain: sdk.Domain.Feishu, appType: sdk.AppType.SelfBuild, logger: quietLogger });
  return { appId: credentials.appId, async request<T>(method: 'GET' | 'POST' | 'PATCH', url: string, data?: unknown): Promise<T> {
    let response: { code: number; msg?: string; data: T };
    try { response = await client.request({ method, url, data }); }
    catch (error) {
      const body = (error as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
      if (typeof body?.code === 'number') throw new ApiError(body.code, body.msg);
      throw error;
    }
    if (response.code !== 0) throw new ApiError(response.code, response.msg);
    return response.data;
  } };
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
export async function readAnnouncement(api: LarkApi, chatId: string): Promise<Announcement> {
  const path = `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/announcement`;
  try {
    const data = await api.request<{ revision: string; content: unknown }>('GET', path);
    return { kind: 'doc', revision: data.revision, content: data.content, path };
  } catch (error) { if (!(error instanceof ApiError) || error.code !== 232097) throw error; }
  const docxPath = `/open-apis/docx/v1/chats/${encodeURIComponent(chatId)}/announcement`;
  const metadata = await api.request<{ revision_id: number }>('GET', docxPath);
  const blocks: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({ page_size: '500', revision_id: String(metadata.revision_id) });
    if (pageToken) query.set('page_token', pageToken);
    const page = await api.request<{ items?: unknown[]; has_more?: boolean; page_token?: string }>('GET', `${docxPath}/blocks?${query}`);
    blocks.push(...(page.items ?? []));
    if (page.has_more && !page.page_token) throw new Error('Missing announcement page token');
    pageToken = page.has_more ? page.page_token : undefined;
  } while (pageToken);
  return { kind: 'docx', revision: metadata.revision_id, content: blocks, path: docxPath };
}
export async function ensureAnnouncement(api: LarkApi, binding: RemoteBinding): Promise<void> {
  const announcement = await readAnnouncement(api, binding.chat_id);
  const token = bindingToken(binding);
  if (bindingTokens(announcement.content).length) { assertMetadata(announcement.content, binding); return; }
  if (announcement.kind === 'doc') {
    const operation = { requestType: 'InsertBlocksRequestType', insertBlocksRequest: {
      payload: JSON.stringify({ blocks: [{ type: 'paragraph', paragraph: {
        elements: [{ type: 'textRun', textRun: { text: token, style: {} } }], style: {},
      } }] }), location: { zoneId: '0', index: 0, endOfZone: true },
    } };
    await api.request('PATCH', announcement.path, { revision: String(announcement.revision), requests: [JSON.stringify(operation)] });
  } else {
    const query = new URLSearchParams({ revision_id: String(announcement.revision), client_token: randomUUID() });
    await api.request('POST', `${announcement.path}/blocks/${encodeURIComponent(binding.chat_id)}/children?${query}`, {
      children: [{ block_type: 2, text: { elements: [{ text_run: { content: token } }] } }],
    });
  }
  assertMetadata((await readAnnouncement(api, binding.chat_id)).content, binding);
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
