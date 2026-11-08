/** Kept as a literal for existing thread clients; Feishu is the only notification transport. */
export type NotificationChannel = 'feishu';
export const isNotificationChannel = (value: unknown): value is NotificationChannel => value === 'feishu';

export type PolledAdapter = 'trae' | 'workbuddy';
export const isPolledAdapter = (value: unknown): value is PolledAdapter => value === 'trae' || value === 'workbuddy';
export type Adapter = 'claude-code' | 'claude-desktop' | 'codex' | 'opencode' | PolledAdapter;
export const isAdapter = (value: unknown): value is Adapter => typeof value === 'string' && ['claude-code', 'claude-desktop', 'codex', 'opencode', 'trae', 'workbuddy'].includes(value);
export interface BackendConnection {
  url: string;
  token?: string;
  username?: string;
  password?: string;
  directory?: string;
}

export interface SessionRegistration {
  adapter: Adapter;
  session_name: string;
  socket_path?: string;
  socket_token?: string;
}
export interface SessionRecord extends SessionRegistration { session_id: string; host_id: string }
export type PublicSession = Pick<SessionRecord, 'session_id' | 'host_id' | 'adapter' | 'session_name'> & {
  availability?: 'active' | 'archived' | 'offline' | 'unknown' | 'missing';
  last_seen?: string;
  last_result?: string;
};
export interface BindingRequest {
  session_id: string;
  adapter?: Adapter;
  session_name?: string;
  sender_open_id: string;
  pin?: boolean;
  metadata?: 'message' | 'announcement';
}
export interface LarkBinding extends BindingRequest {
  chat_id: string;
  /** Groups belong to one app; a replacement app must not reuse another bot's chat IDs. */
  app_id?: string;
  registration_message_id?: string;
  /** First activation, in milliseconds; later polling must not replay earlier commands. */
  activated_at?: number;
  /** Creation is saved before writing metadata; polling waits until that write succeeds. */
  announcement_pending?: boolean;
}
export interface RemoteBinding extends LarkBinding {
  adapter: Adapter;
  host_id: string;
  session_name: string;
  socket_path?: string;
}
/** Per-application history progress. Times are provider epoch milliseconds. */
export interface LarkPollCursor {
  app_id: string;
  chat_id: string;
  container_id: string;
  container_type: 'chat' | 'thread';
  root_message_id?: string;
  started_at: number;
  through: number;
  /** A pre-authentication local estimate can be calibrated before the first history request. */
  provisional_clock?: boolean;
  /** Legacy input only; current completed IDs live in keyed SQLite receipt rows. */
  recent?: [string, number][];
}
export const larkPollCursorKey = (cursor: Pick<LarkPollCursor, 'app_id' | 'container_type' | 'container_id'>): string =>
  `${cursor.app_id}:${cursor.container_type}:${cursor.container_id}`;
export interface LarkPollReceipt { readonly cursor_id: string; readonly message_id: string; readonly create_time: number }
export const larkPollReceiptKey = (cursorId: string, messageId: string): string => JSON.stringify([cursorId, messageId]);
export interface DeliveryResult { status: 'socket_written' | 'input_accepted' | 'inbox_queued' }
export interface InboxMessage { id: string; text: string; created_at: string }
export type InboxSource = { channel: 'feishu'; delivery: LarkDelivery };
export interface InboxOrigin { text: string; source: InboxSource }
export interface StoredInboxMessage extends InboxMessage { session_id: string; adapter: PolledAdapter; source?: InboxSource }
export interface SessionInbox { session_id: string; adapter: PolledAdapter; messages: InboxMessage[] }
export interface LarkDelivery {
  message_id: string;
  chat_id: string;
  sender_open_id: string;
  thread_id?: string;
  session_id: string;
  session_name: string;
  adapter: Adapter;
  created_at: string;
  transport_status: 'pending' | DeliveryResult['status'] | 'ignored' | 'delivery_failed' | 'delivery_unconfirmed';
  /** Only positively identified pre-submission failures may be automatically retried. */
  retryable?: boolean;
  acknowledged_at?: string;
  replies: { digest: string; message_id: string; time: string }[];
}
/** One Feishu group per local session. The optional literal channel supports existing clients. */
export interface ThreadRequest { adapter: Adapter; session_id: string; session_name: string; channel?: NotificationChannel }
export interface ThreadInfo { channel: NotificationChannel; chat_id: string; thread_id?: string; session_id: string; adapter: Adapter; session_name: string; created: boolean }
export interface ThreadMessage { channel: NotificationChannel; chat_id: string; thread_id?: string; message_id: string }
export interface LarkReceipt { status: 'session_acknowledged'; message_id: string; acknowledged_at: string }
export interface LarkReply { status: 'replied'; message_id: string; reply_id: string }
export interface ModuleStatus { name: string; status: string }
export interface Health { ok: true; service: 'nootify'; modules: ModuleStatus[] }
export interface RouteRequest { method: string; path: string; body: unknown }
export interface RouteResponse { status?: number; body: unknown }
export interface ServiceModule {
  name: string;
  status(): string;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  handle(request: RouteRequest): Promise<RouteResponse | undefined>;
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class SessionUnavailable extends HttpError {
  constructor(readonly reason: string) { super(409, reason); }
}
/** The operation failed before any user input could be accepted by its target. */
export class RetryableDeliveryError extends Error {
  constructor(message: string, readonly reason = 'backend_unavailable') { super(message); this.name = 'RetryableDeliveryError'; }
}
/** Input may already have been accepted; another submission would not be safe. */
export class UnconfirmedDeliveryError extends Error {
  constructor(message: string) { super(message); this.name = 'UnconfirmedDeliveryError'; }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `Invalid ${field}`);
  return value;
}
export function identifier(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[A-Za-z0-9._-]+$/.test(result)) throw new HttpError(400, `Invalid ${field}`);
  return result;
}
