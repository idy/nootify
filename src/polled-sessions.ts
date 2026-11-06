import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { State } from './state.js';
import { HttpError, SessionUnavailable, isPolledAdapter, type Adapter, type DeliveryResult, type PolledAdapter, type SessionInbox, type SessionRecord } from './types.js';

/** These clients run the notification CLI, but have no verified API for pushing into a selected existing conversation. */
export async function registerPolledSession(state: State, adapter: Adapter, id: string, name: string): Promise<void> {
  if (!isPolledAdapter(adapter)) return;
  const saved = state.sessions.get(id);
  if (saved && saved.adapter !== adapter) throw new HttpError(409, 'This session ID belongs to another adapter');
  const host_id = hostname();
  if (saved?.host_id === host_id) return;
  // Explicit local reopening reconciles a renamed host while retaining the conversation's inbox and title.
  const session: SessionRecord = { session_id: id, host_id, adapter, session_name: saved?.session_name ?? name };
  state.sessions.set(id, session);
  try { await state.save(); }
  catch (error) {
    if (state.sessions.get(id) === session) {
      if (saved) state.sessions.set(id, saved); else state.sessions.delete(id);
    }
    throw error;
  }
}

function registered(state: State, adapter: PolledAdapter, id: string): SessionRecord {
  const session = state.sessions.get(id);
  if (!session || session.adapter !== adapter || session.host_id !== hostname()) throw new SessionUnavailable('session_not_local');
  return session;
}

export async function queueSessionMessage(state: State, adapter: PolledAdapter, id: string, text: string): Promise<DeliveryResult> {
  registered(state, adapter, id);
  if (Buffer.byteLength(text) > 64000) throw new HttpError(413, 'Inbox message exceeds 64,000 bytes');
  if (state.inboxMessages.size >= 1000 || [...state.inboxMessages.values()].filter(message => message.adapter === adapter && message.session_id === id).length >= 100) {
    throw new HttpError(429, 'Session inbox is full; receive and acknowledge pending messages first');
  }
  const message = { id: randomUUID(), adapter, session_id: id, text, created_at: new Date().toISOString() };
  state.inboxMessages.set(message.id, message);
  try { await state.save(); }
  catch (error) { state.inboxMessages.delete(message.id); throw error; }
  return { status: 'inbox_queued' };
}

/** Reading is repeatable until the caller explicitly acknowledges; a failed CLI must not lose user input. */
export function sessionInbox(state: State, adapter: PolledAdapter, id: string): SessionInbox {
  registered(state, adapter, id);
  const messages: SessionInbox['messages'] = [];
  let bytes = 0;
  for (const message of state.inboxMessages.values()) {
    if (message.adapter !== adapter || message.session_id !== id) continue;
    const size = Buffer.byteLength(message.text);
    if (messages.length && (bytes + size > 64000 || messages.length >= 20)) break;
    messages.push({ id: message.id, text: message.text, created_at: message.created_at }); bytes += size;
  }
  return { session_id: id, adapter, messages };
}

export async function acknowledgeInbox(state: State, adapter: PolledAdapter, id: string, messageId: string): Promise<{ status: 'inbox_acknowledged'; message_id: string }> {
  registered(state, adapter, id);
  const message = state.inboxMessages.get(messageId);
  if (message && (message.adapter !== adapter || message.session_id !== id)) throw new HttpError(404, 'No inbox message with this ID in this session');
  if (message) {
    state.inboxMessages.delete(messageId);
    try { await state.save(); }
    catch (error) { state.inboxMessages.set(messageId, message); throw error; }
  }
  return { status: 'inbox_acknowledged', message_id: messageId };
}
