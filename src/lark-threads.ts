import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ensureAnnouncement, parseAnnouncement, readAnnouncement } from './lark-metadata.js';
import type { LarkApi } from './lark-metadata.js';
import type { State } from './state.js';
import { HttpError } from './types.js';
import type { Adapter, LarkBinding, RemoteBinding, ThreadInfo, ThreadMessage } from './types.js';

const labels: Record<Adapter, string> = { 'claude-desktop': 'Claude', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const MAX_TEXT = 48_000;
const MAX_CHAT_PAGES = 10;
export const shortSessionId = (id: string): string => id.replace(/^(local_|ses_)/, '').slice(0, 8);
/** Same convention as groups the agents created themselves: `<task> · <client> · <first 8 ID characters>`. */
export function threadName(sessionName: string, adapter: Adapter, sessionId: string): string {
  const suffix = ` · ${labels[adapter]} · ${shortSessionId(sessionId)}`;
  return [...sessionName.trim()].slice(0, Math.max(8, 60 - suffix.length)).join('') + suffix;
}

/** Feishu groups for agent sessions: found or created on first use, reused afterwards, routed by their announcement token. */
export class LarkThreads {
  private readonly opening = new Map<string, Promise<ThreadInfo>>();
  constructor(private readonly state: State, private readonly api: LarkApi,
    private readonly report: (record: Record<string, unknown>) => void = () => {}) {}

  /** The Feishu user invited to new groups and trusted as their sender. */
  recipient(): { open_id: string; source: 'setting' | 'environment' | 'bindings' } | undefined {
    if (this.state.settings.lark_recipient_open_id) return { open_id: this.state.settings.lark_recipient_open_id, source: 'setting' };
    const env = process.env.LARK_NOTIFY_OPEN_ID?.trim();
    if (env) return { open_id: env, source: 'environment' };
    const senders = new Set([...this.state.bindings.values()].map(binding => binding.sender_open_id));
    return senders.size === 1 ? { open_id: [...senders][0], source: 'bindings' } : undefined;
  }
  async setRecipient(openId: string): Promise<void> {
    if (!/^ou_[A-Za-z0-9]+$/.test(openId)) throw new HttpError(400, 'Expected a Feishu open_id (ou_…)');
    this.state.settings.lark_recipient_open_id = openId;
    await this.state.save();
  }
  binding(sessionId: string, adapter?: Adapter): LarkBinding | undefined {
    return [...this.state.bindings.values()].find(binding => binding.session_id === sessionId && (!adapter || !binding.adapter || binding.adapter === adapter));
  }
  /** Concurrent calls for one session share a single lookup, so a session never gets two groups from this process. */
  open(adapter: Adapter, sessionId: string, sessionName: string): Promise<ThreadInfo> {
    const key = `${adapter}:${sessionId}`;
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.ensure(adapter, sessionId, sessionName).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }
  private remote(binding: LarkBinding, adapter: Adapter): RemoteBinding {
    return { ...binding, adapter, host_id: hostname(), session_name: binding.session_name ?? binding.session_id };
  }
  private requireRecipient(): string {
    const recipient = this.recipient();
    if (!recipient) throw new HttpError(409, 'No Feishu recipient is configured; run lark-recipient --open-id <ou_…> once');
    return recipient.open_id;
  }
  private async ensure(adapter: Adapter, sessionId: string, sessionName: string): Promise<ThreadInfo> {
    let binding = this.binding(sessionId, adapter);
    let created = false;
    binding ??= await this.adopt(adapter, sessionId, sessionName);
    if (!binding) {
      const recipient = this.requireRecipient();
      const chat = await this.api.request<{ chat_id?: string }>('POST', '/open-apis/im/v1/chats?user_id_type=open_id', {
        name: threadName(sessionName, adapter, sessionId), chat_mode: 'group', chat_type: 'private', user_id_list: [recipient],
      });
      if (!chat.chat_id) throw new Error('Feishu returned no chat ID for the new group');
      binding = { chat_id: chat.chat_id, session_id: sessionId, adapter, session_name: sessionName, sender_open_id: recipient, metadata: 'announcement', pin: false };
      created = true;
      // Saved before the announcement write, so a failure there cannot lead to a second group on retry.
      this.state.bindings.set(binding.chat_id, binding); await this.state.save();
    }
    await ensureAnnouncement(this.api, this.remote(binding, adapter));
    if (this.state.bindings.get(binding.chat_id) !== binding) { this.state.bindings.set(binding.chat_id, binding); await this.state.save(); }
    const session_name = binding.session_name ?? sessionName;
    this.report({ source: 'lark', status: created ? 'thread_created' : 'thread_reused', chat_id: binding.chat_id, session_id: sessionId, session_name });
    return { channel: 'feishu', chat_id: binding.chat_id, session_id: sessionId, adapter, session_name, created };
  }
  /** Groups made before Nootify managed them carry the short ID in their name and the session in their announcement. */
  private async adopt(adapter: Adapter, sessionId: string, sessionName: string): Promise<LarkBinding | undefined> {
    const needle = shortSessionId(sessionId).toLowerCase();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_CHAT_PAGES; page++) {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.api.request<{ items?: { chat_id?: string; name?: string }[]; has_more?: boolean; page_token?: string }>('GET', `/open-apis/im/v1/chats?${query}`);
      for (const chat of data.items ?? []) {
        if (!chat.chat_id || !chat.name?.toLowerCase().includes(needle)) continue;
        let route;
        try { route = parseAnnouncement((await readAnnouncement(this.api, chat.chat_id)).content); } catch { continue; }
        if (route.session_id !== sessionId || (route.host_id && route.host_id !== hostname())) continue;
        return { chat_id: chat.chat_id, session_id: sessionId, adapter, session_name: sessionName, sender_open_id: this.requireRecipient(), metadata: 'announcement', pin: false };
      }
      if (!data.has_more || !data.page_token) return;
      pageToken = data.page_token;
    }
  }
  async send(sessionId: string, text: string, adapter?: Adapter): Promise<ThreadMessage> {
    const binding = this.binding(sessionId, adapter);
    if (!binding) throw new HttpError(404, 'This session has no Feishu group yet; run thread-open first');
    if (!text.trim()) throw new HttpError(400, 'Message text is empty');
    if (Buffer.byteLength(text) > MAX_TEXT) throw new HttpError(413, 'Message text is too large');
    const session_name = binding.session_name ?? sessionId;
    try {
      const result = await this.api.request<{ message_id?: string }>('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
        receive_id: binding.chat_id, msg_type: 'text', content: JSON.stringify({ text: `[${session_name}] ${text}` }), uuid: randomUUID(),
      });
      if (!result.message_id) throw new Error('Feishu returned no message ID');
      this.report({ source: 'lark', status: 'thread_message', chat_id: binding.chat_id, session_id: sessionId, session_name, reply_id: result.message_id, preview: text });
      return { channel: 'feishu', chat_id: binding.chat_id, message_id: result.message_id };
    } catch (error) {
      this.report({ source: 'lark', status: 'thread_failed', chat_id: binding.chat_id, session_id: sessionId, session_name, error: (error as Error).message });
      throw error;
    }
  }
}
