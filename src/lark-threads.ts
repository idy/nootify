import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ensureAnnouncement, InvalidAnnouncement, parseAnnouncement, readAnnouncement, requestLark, larkActivationTime } from './lark-metadata.js';
import type { LarkApi } from './lark-metadata.js';
import type { State } from './state.js';
import { registerPolledSession } from './polled-sessions.js';
import { HttpError, isAdapter } from './types.js';
import type { Adapter, LarkBinding, RemoteBinding, ThreadInfo, ThreadMessage } from './types.js';

const labels: Record<Adapter, string> = { 'claude-desktop': 'Claude', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', trae: 'Trae', workbuddy: 'WorkBuddy' };
const MAX_TEXT = 48_000;
const MAX_CHAT_PAGES = 10;
export const isOpenId = (value: unknown): value is string => typeof value === 'string' && /^ou_[A-Za-z0-9]+$/.test(value);
export const shortSessionId = (id: string): string => id.replace(/^(local_|ses_)/, '').slice(0, 8);
/** Same convention as groups the agents created themselves: `<task> · <client> · <first 8 ID characters>`. */
export function threadName(sessionName: string, adapter: Adapter, sessionId: string): string {
  const suffix = ` · ${labels[adapter]} · ${shortSessionId(sessionId)}`;
  return [...sessionName.trim()].slice(0, Math.max(8, 60 - suffix.length)).join('') + suffix;
}

interface Opening {
  controller: AbortController;
  promise: Promise<ThreadInfo>;
  waiters: number;
  finished: boolean;
}
/** Feishu groups for agent sessions: found or created on first use, reused afterwards, routed by their announcement token. */
export class LarkThreads {
  private readonly opening = new Map<string, Opening>();
  constructor(private readonly state: State, private readonly api: LarkApi,
    private readonly report: (record: Record<string, unknown>) => void = () => {}) {}

  private bindings(): LarkBinding[] {
    return [...this.state.bindings.values()].filter(binding => !binding.app_id || binding.app_id === this.api.appId);
  }
  /** The Feishu user invited to new groups and trusted as their sender. */
  recipient(): { open_id: string; source: 'setting' | 'environment' | 'bindings' } | undefined {
    if (this.state.settings.lark_recipient_open_id) return { open_id: this.state.settings.lark_recipient_open_id, source: 'setting' };
    const env = process.env.LARK_NOTIFY_OPEN_ID?.trim();
    if (env) return { open_id: env, source: 'environment' };
    const senders = new Set(this.bindings().map(binding => binding.sender_open_id));
    return senders.size === 1 ? { open_id: [...senders][0], source: 'bindings' } : undefined;
  }
  async setRecipient(openId: string): Promise<void> {
    if (!isOpenId(openId)) throw new HttpError(400, 'Expected a Feishu open_id (ou_…)');
    this.state.settings.lark_recipient_open_id = openId;
    await this.state.save();
  }
  binding(sessionId: string, adapter?: Adapter): LarkBinding | undefined {
    return this.bindings().find(binding => binding.session_id === sessionId && (!adapter || !binding.adapter || binding.adapter === adapter));
  }
  /** Concurrent calls for one session share a single lookup, so a session never gets two groups from this process. */
  open(adapter: Adapter, sessionId: string, sessionName: string, signal?: AbortSignal): Promise<ThreadInfo> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = `${adapter}:${sessionId}`;
    let pending = this.opening.get(key);
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const current: Opening = { controller, waiters: 0, finished: false,
        promise: this.ensure(adapter, sessionId, sessionName, controller.signal).finally(() => {
          current.finished = true;
          if (this.opening.get(key) === current) this.opening.delete(key);
        }) };
      this.opening.set(key, current);
      pending = current;
    }
    return this.waitFor(pending, signal);
  }
  /** Cancelling one caller detaches it; only the final caller can cancel the shared API operation. */
  private waitFor(pending: Opening, signal?: AbortSignal): Promise<ThreadInfo> {
    pending.waiters++;
    return new Promise((resolve, reject) => {
      let waiting = true;
      const finish = (deliver: () => void) => {
        if (!waiting) return;
        waiting = false;
        signal?.removeEventListener('abort', abort);
        pending.waiters--;
        if (!pending.waiters && !pending.finished) pending.controller.abort();
        deliver();
      };
      const abort = () => finish(() => reject(signal!.reason));
      signal?.addEventListener('abort', abort, { once: true });
      pending.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      if (signal?.aborted) abort();
    });
  }
  private remote(binding: LarkBinding, adapter: Adapter): RemoteBinding {
    return { ...binding, adapter, host_id: hostname(), session_name: binding.session_name ?? binding.session_id };
  }
  private requireRecipient(): string {
    const recipient = this.recipient();
    if (!recipient) throw new HttpError(409, 'No Feishu recipient is configured; run lark-recipient --open-id <ou_…> once');
    return recipient.open_id;
  }
  private async ensure(adapter: Adapter, sessionId: string, sessionName: string, signal?: AbortSignal): Promise<ThreadInfo> {
    signal?.throwIfAborted();
    const activation = Date.now(); const activationClock = performance.now();
    await registerPolledSession(this.state, adapter, sessionId, sessionName);
    let binding = this.binding(sessionId, adapter);
    let created = false;
    binding ??= await this.adopt(adapter, sessionId, sessionName, signal);
    if (!binding) {
      const recipient = this.requireRecipient();
      // Deduplicate retries only for the same invitee, including when the response or SQLite save was lost.
      const uuid = createHash('sha256').update(`${hostname()}\n${this.api.appId}\n${adapter}\n${sessionId}\n${recipient}`).digest('hex').slice(0, 32);
      const chat = await requestLark<{ chat_id?: string }>(this.api, 'POST', `/open-apis/im/v1/chats?user_id_type=open_id&uuid=${uuid}`, {
        name: threadName(sessionName, adapter, sessionId), chat_mode: 'group', chat_type: 'private', user_id_list: [recipient],
      }, signal);
      if (!chat.chat_id) throw new Error('Feishu returned no chat ID for the new group');
      binding = { chat_id: chat.chat_id, app_id: this.api.appId, session_id: sessionId, adapter, session_name: sessionName, sender_open_id: recipient, metadata: 'announcement', pin: false,
        activated_at: larkActivationTime(this.api, activation, performance.now() - activationClock), announcement_pending: true };
      created = true;
      // Saved before the announcement write, so a failure there cannot lead to a second group on retry.
      const pending = binding;
      await this.state.save({ apply: () => { this.state.bindings.set(pending.chat_id, pending); },
        rollback: () => { if (this.state.bindings.get(pending.chat_id) === pending) this.state.bindings.delete(pending.chat_id); } });
    }
    const previous = this.state.bindings.get(binding.chat_id);
    if (!previous && binding.activated_at === undefined) binding.activated_at = larkActivationTime(this.api, activation, performance.now() - activationClock);
    await ensureAnnouncement(this.api, this.remote(binding, adapter), signal);
    if (previous !== binding || binding.announcement_pending) {
      const pending = binding.announcement_pending;
      const ready = binding;
      await this.state.save({ apply: () => { delete ready.announcement_pending; this.state.bindings.set(ready.chat_id, ready); }, rollback: () => {
        if (pending) ready.announcement_pending = true;
        if (previous) this.state.bindings.set(ready.chat_id, previous); else this.state.bindings.delete(ready.chat_id);
      } });
    }
    const session_name = binding.session_name ?? sessionName;
    this.report({ source: 'lark', status: created ? 'thread_created' : 'thread_reused', chat_id: binding.chat_id, session_id: sessionId, session_name });
    return { channel: 'feishu', chat_id: binding.chat_id, session_id: sessionId, adapter, session_name, created };
  }
  /** Groups made before Nootify managed them carry the short ID in their name and the session in their announcement. */
  private async adopt(adapter: Adapter, sessionId: string, sessionName: string, signal?: AbortSignal): Promise<LarkBinding | undefined> {
    const needle = shortSessionId(sessionId).toLowerCase();
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_CHAT_PAGES; page++) {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await requestLark<{ items?: { chat_id?: string; name?: string }[]; has_more?: boolean; page_token?: string }>(this.api, 'GET', `/open-apis/im/v1/chats?${query}`, undefined, signal);
      for (const chat of data.items ?? []) {
        if (!chat.chat_id || !chat.name?.toLowerCase().includes(needle)) continue;
        const owner = this.state.bindings.get(chat.chat_id)?.app_id;
        if (owner && owner !== this.api.appId) continue;
        // An unavailable announcement cannot establish that this is another session's group.
        // Let the read failure abort lookup rather than creating a duplicate on a transient error.
        const announcement = await readAnnouncement(this.api, chat.chat_id, signal);
        let route;
        try { route = parseAnnouncement(announcement.content); }
        catch (error) { if (error instanceof InvalidAnnouncement) continue; throw error; }
        if (route.session_id !== sessionId || route.adapter !== adapter || (route.host_id && route.host_id !== hostname())) continue;
        return { chat_id: chat.chat_id, app_id: this.api.appId, session_id: sessionId, adapter, session_name: sessionName, sender_open_id: this.requireRecipient(), metadata: 'announcement', pin: false };
      }
      if (!data.has_more) return;
      if (!data.page_token || tokens.has(data.page_token)) throw new Error('Feishu returned an invalid group-list page token; group creation was deferred');
      pageToken = data.page_token;
      tokens.add(pageToken);
    }
    throw new Error('Feishu group lookup is incomplete; group creation was deferred');
  }
  async send(sessionId: string, text: string, adapter?: Adapter): Promise<ThreadMessage> {
    const binding = this.binding(sessionId, adapter);
    if (!binding) throw new HttpError(404, 'This session has no Feishu group yet; run thread-open first');
    if (!text.trim()) throw new HttpError(400, 'Message text is empty');
    if (Buffer.byteLength(text) > MAX_TEXT) throw new HttpError(413, 'Message text is too large');
    const session_name = binding.session_name ?? sessionId;
    try {
      const route = parseAnnouncement((await readAnnouncement(this.api, binding.chat_id)).content);
      const expectedAdapter = adapter ?? binding.adapter;
      if (route.session_id !== sessionId || !isAdapter(route.adapter) || (expectedAdapter && route.adapter !== expectedAdapter)
        || (route.host_id && route.host_id !== hostname())) {
        throw new HttpError(409, 'The Feishu announcement now names another session; the progress message was not sent');
      }
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
