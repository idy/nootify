import type { Adapter, BackendConnection, BindingRequest, DeliveryResult, Health, LarkBinding, LarkReceipt, LarkReply, ModuleStatus, PublicSession, SessionRegistration } from './types.js';
export type { Adapter, BackendConnection, BindingRequest, DeliveryResult, Health, LarkBinding, LarkReceipt, LarkReply, ModuleStatus, PublicSession, SessionRegistration } from './types.js';

export class NootifyClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl?: string; token: string }) {
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:9417';
  }
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method, headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
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
  bindLark(chatId: string, binding: BindingRequest): Promise<LarkBinding> {
    return this.request('PUT', `/v1/lark/bindings/${encodeURIComponent(chatId)}`, binding);
  }
}
