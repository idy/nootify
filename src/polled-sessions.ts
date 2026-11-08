import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { State } from './state.js';
import { forwardedLarkMessage, type ForwardingOptions } from './forwarded-messages.js';
import { HttpError, SessionUnavailable, isPolledAdapter, type Adapter, type DeliveryResult, type InboxSource, type PolledAdapter, type SessionInbox, type SessionRecord, type StoredInboxMessage } from './types.js';

/** These clients run the notification CLI, but have no verified API for pushing into a selected existing conversation. */
export async function registerPolledSession(state: State, adapter: Adapter, id: string, name: string): Promise<void> {
  if (!isPolledAdapter(adapter)) return;
  let saved: SessionRecord | undefined; let session: SessionRecord | undefined;
  await state.save({
    apply() {
      saved = state.sessions.get(id);
      if (saved && saved.adapter !== adapter) throw new HttpError(409, 'This session ID belongs to another adapter');
      // Explicit reopening reconciles a renamed host while retaining the conversation's inbox and title.
      session = { session_id: id, host_id: hostname(), adapter, session_name: saved?.session_name ?? name };
      state.sessions.set(id, session);
    },
    rollback() { if (session && state.sessions.get(id) === session) { if (saved) state.sessions.set(id, saved); else state.sessions.delete(id); } },
  });
}

function registered(state: State, adapter: PolledAdapter, id: string): SessionRecord {
  const session = state.sessions.get(id);
  if (!session || session.adapter !== adapter || session.host_id !== hostname()) throw new SessionUnavailable('session_not_local');
  return session;
}

export async function queueSessionMessage(state: State, adapter: PolledAdapter, id: string, text: string, source?: InboxSource): Promise<DeliveryResult> {
  const message: StoredInboxMessage = { id: randomUUID(), adapter, session_id: id, text, created_at: new Date().toISOString(), ...(source ? { source } : {}) };
  await state.save({
    apply() {
      registered(state, adapter, id);
      if (Buffer.byteLength(text) > 64000) throw new HttpError(413, 'Inbox message exceeds 64,000 bytes');
      if (source && (source.delivery.adapter !== adapter || source.delivery.session_id !== id)) throw new HttpError(409, 'Inbox source belongs to another conversation');
      if (state.inboxMessages.size >= 1000 || [...state.inboxMessages.values()].filter(item => item.adapter === adapter && item.session_id === id).length >= 100) {
        throw new HttpError(429, 'Session inbox is full; receive and acknowledge pending messages first');
      }
      state.inboxMessages.set(message.id, message);
    },
    rollback() { state.inboxMessages.delete(message.id); },
  });
  return { status: 'inbox_queued' };
}

/** Reading is repeatable until the caller explicitly acknowledges; source commands use this installation's live configuration. */
export function sessionInbox(state: State, adapter: PolledAdapter, id: string, options: ForwardingOptions = {}): SessionInbox {
  const session = registered(state, adapter, id);
  const messages: SessionInbox['messages'] = [];
  let bytes = 0;
  for (const message of state.inboxMessages.values()) {
    if (message.adapter !== adapter || message.session_id !== id) continue;
    const source = message.source;
    const text = source ? `[Nootify: ${session.session_name}]\n` + forwardedLarkMessage(source.delivery, message.text, state.directory, options.port, options.command) : message.text;
    const size = Buffer.byteLength(text);
    if (messages.length && (bytes + size > 64000 || messages.length >= 20)) break;
    messages.push({ id: message.id, text, created_at: message.created_at }); bytes += size;
  }
  return { session_id: id, adapter, messages };
}

export async function acknowledgeInbox(state: State, adapter: PolledAdapter, id: string, messageId: string): Promise<{ status: 'inbox_acknowledged'; message_id: string }> {
  let before: Map<string, StoredInboxMessage> | undefined;
  await state.save({
    apply() {
      registered(state, adapter, id);
      const message = state.inboxMessages.get(messageId);
      if (message && (message.adapter !== adapter || message.session_id !== id)) throw new HttpError(404, 'No inbox message with this ID in this session');
      if (message) { before = new Map(state.inboxMessages); state.inboxMessages.delete(messageId); }
    },
    rollback() { if (before) { state.inboxMessages.clear(); for (const [key, value] of before) state.inboxMessages.set(key, value); } },
  });
  return { status: 'inbox_acknowledged', message_id: messageId };
}
