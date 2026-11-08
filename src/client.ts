import type { Adapter, BackendConnection, BindingRequest, DeliveryResult, Health, LarkBinding, LarkReceipt, LarkReply, ModuleStatus, PublicSession, SessionRegistration, ThreadInfo, ThreadMessage, ThreadRequest } from './types.js';
import type { AgentId, AgentPrompt } from './agents.js';
import type { NotificationChannel } from './types.js';
export type { NotificationChannel } from './types.js';
export type { Adapter, BackendConnection, BindingRequest, DeliveryResult, Health, LarkBinding, LarkReceipt, LarkReply, ModuleStatus, PublicSession, SessionRegistration, ThreadInfo, ThreadMessage, ThreadRequest } from './types.js';
export type { AgentId, AgentPrompt } from './agents.js';

import type { SessionInbox, PolledAdapter } from './types.js';
export type { SessionInbox, InboxMessage, PolledAdapter } from './types.js';

export class NootifyClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl?: string; token: string }) {
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:9417';
  }
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method, headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(75000),
    });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  }
  health(): Promise<Health> { return this.request('GET', '/health'); }
  services(): Promise<ModuleStatus[]> { return this.request('GET', '/v1/services'); }
  listSessions(): Promise<PublicSession[]> { return this.request('GET', '/v1/sessions'); }
  registerSession(id: string, session: SessionRegistration): Promise<PublicSession> {
    return this.request('PUT', `/v1/sessions/${encodeURIComponent(id)}`, session);
  }
  sendMessage(id: string, text: string, adapter?: Adapter): Promise<DeliveryResult> {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(id)}/messages`, { text, adapter });
  }
  configureBackend(adapter: 'codex' | 'opencode', connection: BackendConnection): Promise<{ adapter: string; configured: boolean }> {
    return this.request('PUT', `/v1/backends/${adapter}`, connection);
  }
  acknowledgeLark(messageId: string): Promise<LarkReceipt> {
    return this.request('POST', `/v1/lark/messages/${encodeURIComponent(messageId)}/ack`, {});
  }
  replyLark(messageId: string, text: string): Promise<LarkReply> {
    return this.request('POST', `/v1/lark/messages/${encodeURIComponent(messageId)}/reply`, { text });
  }
  larkBindings(): Promise<LarkBinding[]> { return this.request('GET', '/v1/lark/bindings'); }
  /** Find or create the session's Feishu group. */
  openThread(request: ThreadRequest): Promise<ThreadInfo> { return this.request('POST', '/v1/threads', request); }
  sendThread(sessionId: string, text: string, adapter?: Adapter, channel?: NotificationChannel, providerId?: string, requestId?: string): Promise<ThreadMessage> {
    return this.request('POST', `/v1/threads/${encodeURIComponent(sessionId)}/messages`, { text, adapter, channel,
      ...(providerId ? { provider_id: providerId } : {}), ...(requestId ? { request_id: requestId } : {}) });
  }
  deleteThread(sessionId: string, adapter: Adapter, providerId?: string): Promise<unknown> {
    return this.request('DELETE', `/v1/threads/${encodeURIComponent(sessionId)}`, { adapter, ...(providerId ? { provider_id: providerId } : {}) });
  }
  acknowledgeMessage(messageRef: string): Promise<LarkReceipt> {
    return this.request('POST', `/v1/provider-messages/${encodeURIComponent(messageRef)}/ack`, {});
  }
  replyMessage(messageRef: string, text: string): Promise<LarkReply> {
    return this.request('POST', `/v1/provider-messages/${encodeURIComponent(messageRef)}/reply`, { text });
  }
  receiveThread(sessionId: string, adapter: PolledAdapter): Promise<SessionInbox> {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/inbox`, { adapter });
  }
  acknowledgeThread(sessionId: string, adapter: PolledAdapter, messageId: string): Promise<{ status: 'inbox_acknowledged'; message_id: string }> {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(messageId)}/ack`, { adapter });
  }
  larkRecipient(): Promise<{ open_id?: string; source?: string }> { return this.request('GET', '/v1/lark/recipient'); }
  setLarkRecipient(openId: string): Promise<{ open_id?: string; source?: string }> { return this.request('PUT', '/v1/lark/recipient', { open_id: openId }); }
  agents(): Promise<AgentPrompt[]> { return this.request('GET', '/v1/agents'); }
  setAgent(agent: AgentId, enabled: boolean): Promise<AgentPrompt> { return this.request('PUT', `/v1/agents/${agent}`, { enabled }); }
  bindLark(chatId: string, binding: BindingRequest): Promise<LarkBinding> {
    return this.request('PUT', `/v1/lark/bindings/${encodeURIComponent(chatId)}`, binding);
  }
}
