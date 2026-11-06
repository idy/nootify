import * as sdk from '@larksuiteoapi/node-sdk';
import type { State } from './state.js';
import { SessionsService, SessionUnavailable } from './sessions.js';
import { hostname } from 'node:os';
import type { Adapter, LarkBinding, LarkDelivery, RemoteBinding, RouteRequest, RouteResponse, ServiceModule } from './types.js';
import { HttpError, identifier, object, isAdapter, text } from './types.js';
import { forwardedLarkMessage, LarkReplies } from './lark-replies.js';
import { LarkThreads } from './lark-threads.js';
import { createLarkApi, ensureAnnouncement, ensureBindingMessage, quietLogger, readAnnouncement, parseAnnouncement, InvalidAnnouncement } from './lark-metadata.js';
import type { Credentials, LarkApi } from './lark-metadata.js';

type LarkSocket = Pick<sdk.WSClient, 'start' | 'close'>;
export type LarkSocketFactory = (options: ConstructorParameters<typeof sdk.WSClient>[0]) => LarkSocket;

interface IncomingEvent {
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
  message?: { chat_id?: string; message_id?: string; thread_id?: string; message_type?: string; content?: string };
}
export function selectMessage(payload: unknown, binding: LarkBinding): { id: string; text: string } | undefined {
  if (!payload || typeof payload !== 'object') return;
  const raw = payload as { event?: unknown };
  const event = (raw.event ?? payload) as IncomingEvent;
  const { sender, message } = event;
  if (sender?.sender_type !== 'user' || sender.sender_id?.open_id !== binding.sender_open_id ||
      message?.chat_id !== binding.chat_id || message.message_type !== 'text' || !message.message_id || typeof message.content !== 'string') return;
  let parsed: { text?: unknown } | null;
  try { parsed = JSON.parse(message.content) as typeof parsed; } catch { return; }
  if (typeof parsed?.text !== 'string' || !parsed.text.trim()) return;
  return { id: message.message_id, text: parsed.text };
}
export class LarkService implements ServiceModule {
  readonly name = 'lark';
  private connection = 'disabled';
  private ws?: LarkSocket;
  private socketGeneration = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private seen = new Set<string>();
  credentials?: Credentials;
  api?: LarkApi;
  private replies?: LarkReplies;
  threads?: LarkThreads;
  constructor(readonly state: State, readonly sessions: SessionsService, credentials?: Credentials,
    private readonly report: (record: Record<string, unknown>) => void = () => {}, api?: LarkApi, private readonly port = 9417,
    private readonly createSocket: LarkSocketFactory = options => new sdk.WSClient(options)) {
    this.use(credentials, api);
  }
  private use(credentials?: Credentials, api?: LarkApi): void {
    this.credentials = credentials;
    this.api = api ?? (credentials?.appId.trim() && credentials.appSecret.trim() ? createLarkApi(credentials) : undefined);
    this.replies = this.api ? new LarkReplies(this.state, this.api, this.report) : undefined;
    this.threads = this.api ? new LarkThreads(this.state, this.api, this.report) : undefined;
  }
  private serialized(operation: () => Promise<void>): Promise<void> {
    const pending = this.lifecycle.catch(() => {}).then(operation);
    this.lifecycle = pending;
    return pending;
  }
  private closeSocket(): void {
    // Retire callbacks before close: it may itself deliver a final connection event.
    this.socketGeneration++;
    const socket = this.ws; this.ws = undefined;
    socket?.close({ force: true });
  }
  /** Initial startup, settings changes and shutdown share one queue; accepted messages finish on the old API. */
  configure(credentials?: Credentials): Promise<void> {
    return this.serialized(async () => {
      this.closeSocket();
      this.connection = credentials ? 'connecting' : 'disabled';
      await this.queue;
      this.use(credentials);
      await this.connect();
    });
  }
  status(): string { return this.connection; }
  private remote(binding: LarkBinding): RemoteBinding {
    const saved = this.state.sessions.get(binding.session_id);
    return { ...binding, host_id: hostname(), adapter: binding.adapter ?? saved?.adapter ?? (binding.session_id.startsWith('local_') ? 'claude-desktop' : 'claude-code'),
      session_name: binding.session_name ?? saved?.session_name ?? binding.session_id };
  }
  start(): Promise<void> { return this.serialized(() => this.connect()); }
  private async connect(): Promise<void> {
    if (!this.credentials || this.ws) return;
    if (!this.credentials.appId.trim() || !this.credentials.appSecret.trim()) {
      this.connection = 'failed';
      this.report({ status: 'lark_failed', error: 'Feishu App ID and App Secret are both required' });
      return;
    }
    const generation = ++this.socketGeneration;
    const current = () => generation === this.socketGeneration;
    this.connection = 'connecting';
    try {
      this.ws = this.createSocket({ ...this.credentials, domain: sdk.Domain.Feishu, logger: quietLogger,
        onReady: () => { if (current()) { this.connection = 'ready'; this.report({ status: 'lark_ready' }); } },
        onReconnecting: () => { if (current()) this.connection = 'reconnecting'; },
        onReconnected: () => { if (current()) this.connection = 'ready'; },
        onError: error => { if (current()) { this.connection = 'failed'; this.report({ status: 'lark_failed', error: error.message }); } },
      });
      // SDK start returns before network handshakes finish; every later callback must still belong to this client.
      await this.ws.start({ eventDispatcher: new sdk.EventDispatcher({ logger: quietLogger }).register({
        'im.message.receive_v1': async data => { if (current()) this.enqueue(data); },
      }) });
    } catch (error) {
      // Feishu failing must not reject the host's startup loop and prevent unrelated modules from starting.
      if (current()) {
        this.closeSocket();
        this.connection = 'failed';
        this.report({ status: 'lark_failed', error: (error as Error).message });
      }
    }
  }
  stop(): Promise<void> {
    return this.serialized(async () => { this.closeSocket(); this.connection = 'stopped'; await this.queue; });
  }
  enqueue(payload: unknown): boolean {
    if (!this.api || !payload || typeof payload !== 'object') return false;
    const event = ((payload as { event?: unknown }).event ?? payload) as IncomingEvent;
    if (event.sender?.sender_type !== 'user' || !event.message?.chat_id || !event.message.message_id) return false;
    const chat_id = event.message.chat_id;
    const message_id = event.message.message_id;
    const context = { source: 'lark', chat_id, message_id };
    const sender = event.sender.sender_id?.open_id;
    const boundSender = this.state.bindings.get(chat_id)?.sender_open_id;
    const allowed = new Set([...this.state.bindings.values()].map(binding => binding.sender_open_id));
    for (const id of (process.env.LARK_ALLOWED_OPEN_IDS ?? '').split(',').filter(Boolean)) allowed.add(id.trim());
    if (!sender || (boundSender ? sender !== boundSender : !allowed.has(sender))) {
      this.report({ ...context, status: 'ignored', reason: 'sender_not_allowed' }); return false;
    }
    if (this.seen.has(message_id) || this.state.deliveries.has(message_id)) { this.report({ ...context, status: 'ignored', reason: 'duplicate' }); return false; }
    const selected = selectMessage(event, { chat_id, sender_open_id: sender, session_id: '' });
    if (!selected) {
      this.report({ ...context, status: 'ignored', reason: event.message.message_type !== 'text' ? 'unsupported_message' : 'invalid_content' }); return false;
    }
    this.report({ ...context, status: 'received', sender_open_id: sender, preview: selected.text });
    if (this.pending >= 100) { this.report({ ...context, status: 'queue_full' }); return false; }
    this.seen.add(message_id);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    this.pending++;
    this.queue = this.queue.then(async () => {
      let session_id: string | undefined;
      let delivery: LarkDelivery | undefined;
      try {
        const route = parseAnnouncement((await readAnnouncement(this.api!, chat_id)).content);
        session_id = route.session_id;
        if (route.host_id && route.host_id !== hostname()) throw new SessionUnavailable('host_mismatch');
        if (!isAdapter(route.adapter)) throw new SessionUnavailable('unsupported_adapter');
        delivery = { message_id, chat_id, sender_open_id: sender, thread_id: event.message?.thread_id,
          session_id, session_name: this.sessions.sessionName(session_id, route.adapter), adapter: route.adapter,
          created_at: new Date().toISOString(), transport_status: 'pending', replies: [] };
        this.state.deliveries.set(message_id, delivery);
        if (this.state.deliveries.size > 2000) this.state.deliveries.delete(this.state.deliveries.keys().next().value!);
        await this.state.save();
        const result = await this.sessions.send(route.session_id,
          forwardedLarkMessage(delivery, selected.text, this.state.directory, this.port), route.adapter);
        delivery.transport_status = result.status;
        delivery.session_name = this.sessions.sessionName(session_id, route.adapter);
        await this.state.save();
        this.report({ ...context, ...result, session_id, session_name: delivery.session_name });
      } catch (error) {
        const ignored = error instanceof SessionUnavailable || error instanceof InvalidAnnouncement;
        if (delivery) {
          delivery.transport_status = ignored ? 'ignored' : 'delivery_failed';
          await this.state.save().catch(() => this.report({ ...context, status: 'delivery_failed', reason: 'state_write_failed' }));
        }
        if (ignored) this.report({ ...context, status: 'ignored', session_id, reason: error.reason });
        else this.report({ ...context, status: 'delivery_failed', session_id, error: (error as Error).message });
      } finally { this.pending--; }
    });
    return true;
  }
  drain(): Promise<void> { return this.queue; }
  /** Channel summary for the Agents page; never includes credentials. */
  channel(): { name: 'feishu'; configured: boolean; recipient?: string; groups: number } {
    return { name: 'feishu', configured: Boolean(this.api), recipient: this.threads?.recipient()?.open_id, groups: this.state.bindings.size };
  }
  private requireThreads(): LarkThreads {
    if (!this.threads) throw new HttpError(503, 'Feishu is not configured; other services remain available');
    return this.threads;
  }
  async handle(request: RouteRequest): Promise<RouteResponse | undefined> {
    if (request.path === '/v1/lark/bindings' && request.method === 'GET') return { body: [...this.state.bindings.values()] };
    if (request.path === '/v1/threads' && request.method === 'POST') {
      const body = object(request.body);
      if (!isAdapter(body.adapter)) throw new HttpError(400, 'Unsupported session adapter');
      const name = text(body.session_name, 'session_name').trim().slice(0, 80);
      return { body: await this.requireThreads().open(body.adapter, identifier(body.session_id, 'session_id'), name) };
    }
    const thread = /^\/v1\/threads\/([^/]+)\/messages$/.exec(request.path);
    if (thread && request.method === 'POST') {
      const body = object(request.body);
      if (body.adapter !== undefined && !isAdapter(body.adapter)) throw new HttpError(400, 'Unsupported session adapter');
      return { body: await this.requireThreads().send(identifier(decodeURIComponent(thread[1]), 'session_id'), text(body.text, 'text'), body.adapter as Adapter | undefined) };
    }
    if (request.path === '/v1/lark/recipient') {
      if (request.method === 'PUT') await this.requireThreads().setRecipient(text(object(request.body).open_id, 'open_id'));
      else if (request.method !== 'GET') return;
      return { body: this.requireThreads().recipient() ?? {} };
    }
    const callback = /^\/v1\/lark\/messages\/([^/]+)\/(ack|reply)$/.exec(request.path);
    if (callback && request.method === 'POST') {
      if (!this.replies) throw new HttpError(503, 'Feishu is not configured');
      const id = identifier(decodeURIComponent(callback[1]), 'message_id');
      if (callback[2] === 'ack') return { body: await this.replies.acknowledge(id) };
      const replyText = text(object(request.body).text, 'text');
      if (Buffer.byteLength(replyText) > 48000) throw new HttpError(413, 'Reply text is too large');
      return { body: await this.replies.reply(id, replyText) };
    }
    const match = /^\/v1\/lark\/bindings\/([^/]+)$/.exec(request.path);
    if (!match || request.method !== 'PUT') return;
    if (!this.api) throw new HttpError(503, 'Feishu is not configured; other services remain available');
    const body = object(request.body);
    const chat_id = identifier(decodeURIComponent(match[1]), 'chat_id');
    const session_id = identifier(body.session_id, 'session_id');
    if (body.adapter !== undefined && !isAdapter(body.adapter)) throw new HttpError(400, 'Unsupported session adapter');
    const sender_open_id = identifier(body.sender_open_id, 'sender_open_id');
    if (body.metadata !== undefined && body.metadata !== 'message' && body.metadata !== 'announcement') throw new HttpError(400, 'Invalid metadata mode');
    if (body.pin !== undefined && typeof body.pin !== 'boolean') throw new HttpError(400, 'Invalid pin flag');
    const existing = this.state.bindings.get(chat_id);
    if (existing && (existing.session_id !== session_id || existing.sender_open_id !== sender_open_id)) throw new HttpError(409, 'Group already has another local binding');
    const binding: LarkBinding = { chat_id, session_id, sender_open_id, metadata: body.metadata ?? 'announcement', pin: body.pin === true,
      ...(isAdapter(body.adapter) ? { adapter: body.adapter } : {}), ...(typeof body.session_name === 'string' ? { session_name: body.session_name } : {}) };
    await ensureAnnouncement(this.api, this.remote(binding));
    if (binding.metadata === 'message') {
      binding.registration_message_id = existing?.registration_message_id;
      binding.registration_message_id = await ensureBindingMessage(this.api, this.remote(binding));
    }
    this.state.bindings.set(chat_id, binding);
    await this.state.save();
    if (binding.pin && binding.registration_message_id) {
      try { await this.api.request('POST', '/open-apis/im/v1/pins', { message_id: binding.registration_message_id }); }
      catch (error) { this.report({ status: 'pin_failed', error: (error as Error).message }); }
    }
    return { body: binding };
  }
}
