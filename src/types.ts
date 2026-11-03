export type Adapter = 'claude-code' | 'claude-desktop' | 'codex' | 'opencode';
export const isAdapter = (value: unknown): value is Adapter => typeof value === 'string' && ['claude-code', 'claude-desktop', 'codex', 'opencode'].includes(value);
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
  registration_message_id?: string;
}
export interface RemoteBinding extends LarkBinding {
  adapter: Adapter;
  host_id: string;
  session_name: string;
  socket_path?: string;
}
export interface DeliveryResult { status: 'socket_written' | 'input_accepted' }
export interface LarkDelivery {
  message_id: string;
  chat_id: string;
  sender_open_id: string;
  thread_id?: string;
  session_id: string;
  session_name: string;
  adapter: Adapter;
  created_at: string;
  transport_status: 'pending' | 'socket_written' | 'input_accepted' | 'ignored' | 'delivery_failed';
  acknowledged_at?: string;
  replies: { digest: string; message_id: string; time: string }[];
}
/** One Feishu group per agent session; Slack and other channels will return the same shapes. */
export interface ThreadRequest { adapter: Adapter; session_id: string; session_name: string }
export interface ThreadInfo { channel: 'feishu'; chat_id: string; session_id: string; adapter: Adapter; session_name: string; created: boolean }
export interface ThreadMessage { channel: 'feishu'; chat_id: string; message_id: string }
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
