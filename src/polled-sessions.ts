import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { State } from './state.js';
import type { ProviderMessageRef } from './message-ref.js';
import { forwardedLarkMessage, forwardedProviderMessage, type ForwardingOptions } from './forwarded-messages.js';
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
    const text = source ? `[Nootify: ${session.session_name}]\n` + (source.channel === 'provider'
      ? forwardedProviderMessage(source.delivery, message.text, state.directory, options.port, options.command)
      : forwardedLarkMessage(source.delivery, message.text, state.directory, options.port, options.command)) : message.text;
    const size = Buffer.byteLength(text);
    if (messages.length && (bytes + size > 64000 || messages.length >= 20)) break;
    messages.push({ id: message.id, text, created_at: message.created_at }); bytes += size;
  }
  return { session_id: id, adapter, messages };
}

export interface ProviderInboxSnapshot { inbox_id: string; message: ProviderMessageRef }
const referenceKey = (message: ProviderMessageRef): string => JSON.stringify([message.origin_node_id, message.provider_id, message.message_id]);

/** Only a core cancellation proof for an entry in the committed snapshot can remove unread input. */
export async function discardCanceledInbox(state: State, snapshot: readonly ProviderInboxSnapshot[], canceled: readonly ProviderMessageRef[]): Promise<ProviderMessageRef[]> {
  const canceledKeys = new Set(canceled.map(referenceKey));
  const confirmed = new Map(snapshot.filter(item => canceledKeys.has(referenceKey(item.message))).map(item => [referenceKey(item.message), item.message]));
  if (!confirmed.size) return [];
  const removed = new Map<string, StoredInboxMessage>();
  await state.save({
    apply() {
      for (const { inbox_id, message } of snapshot) {
        const entry = state.inboxMessages.get(inbox_id);
        if (!confirmed.has(referenceKey(message)) || entry?.source?.channel !== 'provider'
          || referenceKey(entry.source.delivery.message) !== referenceKey(message)) continue;
        removed.set(inbox_id, entry); state.inboxMessages.delete(inbox_id);
      }
    },
    rollback() { for (const [id, entry] of removed) if (!state.inboxMessages.has(id)) state.inboxMessages.set(id, entry); },
  });
  return [...confirmed.values()];
}

export async function acknowledgeInbox(state: State, adapter: PolledAdapter, id: string, messageId: string,
  consumed?: (message: ProviderMessageRef) => Promise<void>): Promise<{ status: 'inbox_acknowledged'; message_id: string }> {
  let before: Map<string, StoredInboxMessage> | undefined; let source: ProviderMessageRef | undefined;
  await state.save({
    apply() {
      registered(state, adapter, id);
      const message = state.inboxMessages.get(messageId);
      if (message && (message.adapter !== adapter || message.session_id !== id)) throw new HttpError(404, 'No inbox message with this ID in this session');
      if (message) {
        before = new Map(state.inboxMessages); state.inboxMessages.delete(messageId);
        if (message.source?.channel === 'provider') source = message.source.delivery.message;
      }
    },
    rollback() { if (before) { state.inboxMessages.clear(); for (const [key, value] of before) state.inboxMessages.set(key, value); } },
  });
  // Deletion is already durable. Release is idempotent maintenance; startup reconciliation repairs any lost outcome.
  if (source && consumed) await consumed(source).catch(() => {});
  return { status: 'inbox_acknowledged', message_id: messageId };
}
