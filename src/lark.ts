import { LarkPoller, type LarkPollingFactory, type LarkReceiver } from './lark-polling.js';
import type { State } from './state.js';
import { SessionsService, SessionUnavailable } from './sessions.js';
import { hostname } from 'node:os';
import type { Adapter, LarkBinding, LarkDelivery, RemoteBinding, RouteRequest, RouteResponse, ServiceModule } from './types.js';
import { HttpError, RetryableDeliveryError, identifier, object, isAdapter, text } from './types.js';
import { forwardedLarkMessage, LarkReplies } from './lark-replies.js';
import { LarkThreads } from './lark-threads.js';
import { LarkThreadSync, type ThreadDiscovery } from './lark-thread-sync.js';
import { registerPolledSession } from './polled-sessions.js';
import { createLarkApi, ensureAnnouncement, ensureBindingMessage, readAnnouncement, parseAnnouncement, InvalidAnnouncement, larkActivationTime, requestLark } from './lark-metadata.js';
import type { Credentials, LarkApi } from './lark-metadata.js';

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
  private receiver?: LarkReceiver;
  private threadSync?: LarkThreadSync;
  private receiverGeneration = 0;
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
    private readonly createReceiver: LarkPollingFactory = options => new LarkPoller(options),
    private readonly discoverThreads?: ThreadDiscovery) {
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
  private async stopReceiver(): Promise<void> {
    // Retire callbacks before cancellation; accepted deliveries still finish on their original API.
    this.receiverGeneration++;
    const receiver = this.receiver; this.receiver = undefined;
    const sync = this.threadSync; this.threadSync = undefined;
    await Promise.all([receiver?.stop(), sync?.stop()]);
  }
  /** Initial startup, settings changes and shutdown share one queue; accepted messages finish on the old API. */
  configure(credentials?: Credentials): Promise<void> {
    return this.serialized(async () => {
      await this.stopReceiver();
      this.connection = credentials ? 'connecting' : 'disabled';
      await this.queue;
      const previousApp = this.api?.appId;
      let migrated = false;
      if (previousApp && previousApp !== credentials?.appId) {
        for (const binding of this.state.bindings.values()) if (!binding.app_id) { binding.app_id = previousApp; migrated = true; }
      }
      this.use(credentials);
      await this.connect();
      if (migrated) await this.state.save();
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
    if (!this.credentials || this.receiver) return;
    if (!this.credentials.appId.trim() || !this.credentials.appSecret.trim()) {
      this.connection = 'failed';
      this.report({ status: 'lark_failed', error: 'Feishu App ID and App Secret are both required' });
      return;
    }
    const generation = ++this.receiverGeneration;
    const current = () => generation === this.receiverGeneration;
    this.connection = 'connecting';
    try {
      this.receiver = this.createReceiver({ state: this.state, api: this.api!,
        receive: async payload => {
          await this.queue;
          if (!current()) return false;
          return this.enqueue(payload);
        },
        status: status => {
          if (!current()) return;
          if (status === 'ready' && this.connection !== 'ready') this.report({ status: 'lark_ready' });
          this.connection = status;
        },
        report: record => { if (current()) this.report(record); },
      });
      await this.receiver.start();
      if (this.discoverThreads && this.threads) {
        this.threadSync = new LarkThreadSync({ state: this.state, threads: this.threads, discover: this.discoverThreads,
          report: record => { if (current()) this.report(record); } });
        this.threadSync.start();
      }
    } catch (error) {
      // Feishu failing must not prevent unrelated host modules from starting.
      if (current()) {
        await this.stopReceiver();
        this.connection = 'failed';
        this.report({ status: 'lark_failed', error: (error as Error).message });
      }
    }
  }
  stop(): Promise<void> {
    return this.serialized(async () => { await this.stopReceiver(); this.connection = 'stopped'; await this.queue; });
  }
  /** True means delivered or terminally handled; false means a proven-safe retry is required. */
  enqueue(payload: unknown): Promise<boolean> {
    const api = this.api;
    if (!api || !payload || typeof payload !== 'object') return Promise.resolve(true);
    const event = ((payload as { event?: unknown }).event ?? payload) as IncomingEvent;
    if (event.sender?.sender_type !== 'user' || !event.message?.chat_id || !event.message.message_id) return Promise.resolve(true);
    const chat_id = event.message.chat_id;
    const message_id = event.message.message_id;
    const context = { source: 'lark', chat_id, message_id };
    const sender = event.sender.sender_id?.open_id;
    const binding = this.state.bindings.get(chat_id);
    if (binding?.app_id && binding.app_id !== api.appId) {
      this.report({ ...context, status: 'ignored', reason: 'app_mismatch' }); return Promise.resolve(true);
    }
    const bindings = [...this.state.bindings.values()].filter(value => !value.app_id || value.app_id === api.appId);
    const allowed = new Set(bindings.map(value => value.sender_open_id));
    for (const id of (process.env.LARK_ALLOWED_OPEN_IDS ?? '').split(',').filter(Boolean)) allowed.add(id.trim());
    if (!sender || (binding ? sender !== binding.sender_open_id : !allowed.has(sender))) {
      this.report({ ...context, status: 'ignored', reason: 'sender_not_allowed' }); return Promise.resolve(true);
    }
    if (binding?.announcement_pending) return Promise.resolve(false);
    const previous = this.state.larkDelivery(message_id);
    const proof = (value?: LarkDelivery) => Boolean(value?.acknowledged_at || value?.replies.length);
    if (this.seen.has(message_id) || (previous && (proof(previous) || previous.transport_status !== 'delivery_failed' || previous.retryable !== true))) {
      this.report({ ...context, status: 'ignored', reason: 'duplicate' }); return Promise.resolve(true);
    }
    const selected = selectMessage(event, { chat_id, sender_open_id: sender, session_id: '' });
    if (!selected) {
      this.report({ ...context, status: 'ignored', reason: event.message.message_type !== 'text' ? 'unsupported_message' : 'invalid_content' }); return Promise.resolve(true);
    }
    if (this.pending >= 100) { this.report({ ...context, status: 'queue_full' }); return Promise.resolve(false); }
    this.report({ ...context, status: 'received', sender_open_id: sender, preview: selected.text });
    this.seen.add(message_id);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    this.pending++;
    const processing = this.queue.then(async () => {
      let session_id: string | undefined;
      let delivery = previous;
      let submitted = false; let delivered = false; let handled = false;
      try {
        const route = parseAnnouncement((await readAnnouncement(api, chat_id)).content);
        session_id = route.session_id;
        if (route.host_id && route.host_id !== hostname()) throw new SessionUnavailable('host_mismatch');
        if (!isAdapter(route.adapter)) throw new SessionUnavailable('unsupported_adapter');
        if (proof(previous)) { handled = true; return true; }
        delivery = { ...previous, message_id, chat_id, sender_open_id: sender, thread_id: event.message?.thread_id,
          session_id, session_name: this.sessions.sessionName(session_id, route.adapter), adapter: route.adapter,
          created_at: previous?.created_at ?? new Date().toISOString(), transport_status: 'pending', replies: previous?.replies ?? [] };
        delete delivery.retryable;
        this.state.deliveries.set(message_id, delivery);
        if (this.state.deliveries.size > 2000) this.state.deliveries.delete(this.state.deliveries.keys().next().value!);
        await this.state.save();
        submitted = true;
        const result = await this.sessions.send(route.session_id,
          forwardedLarkMessage(delivery, selected.text, this.state.directory, this.port), route.adapter,
          { text: selected.text, source: { channel: 'feishu', delivery } });
        delivered = true; handled = true;
        delivery.transport_status = result.status;
        delivery.session_name = this.sessions.sessionName(session_id, route.adapter);
        await this.state.save();
        this.report({ ...context, ...result, session_id, session_name: delivery.session_name });
      } catch (error) {
        const rejected = error instanceof HttpError && [400, 404, 405, 413, 415, 422].includes(error.status);
        const ignored = error instanceof SessionUnavailable || error instanceof InvalidAnnouncement || rejected;
        const receipt = proof(delivery);
        const retry = !delivered && !receipt && !ignored && (!submitted || error instanceof RetryableDeliveryError);
        const uncertain = !delivered && !receipt && !ignored && !retry;
        handled ||= delivered || receipt || ignored || uncertain;
        if (delivery && !delivered) {
          delivery.transport_status = ignored ? 'ignored' : uncertain || receipt ? 'delivery_unconfirmed' : 'delivery_failed';
          if (retry) delivery.retryable = true; else delete delivery.retryable;
          await this.state.save().catch(() => this.report({ ...context, status: 'state_write_failed' }));
        }
        if (receipt) { /* The existing acknowledgment/reply event is stronger than this transport error. */ }
        else if (delivered) this.report({ ...context, status: 'state_write_failed', session_id, error: (error as Error).message });
        else if (ignored) this.report({ ...context, status: 'ignored', session_id,
          reason: rejected ? 'input_rejected' : (error as SessionUnavailable | InvalidAnnouncement).reason, ...(rejected ? { error: (error as Error).message } : {}) });
        else this.report({ ...context, status: uncertain ? 'delivery_unconfirmed' : 'delivery_failed', session_id, error: (error as Error).message });
      } finally {
        this.pending--;
        if (!handled) this.seen.delete(message_id);
      }
      if (delivered) {
        try {
          await requestLark(api, 'POST', `/open-apis/im/v1/messages/${encodeURIComponent(message_id)}/reactions`, {
            reaction_type: { emoji_type: 'FINGERHEART' },
          });
        } catch (error) {
          this.report({ ...context, status: 'reaction_failed', session_id, error: (error as Error).message });
        }
      }
      return handled;
    });
    this.queue = processing.then(() => {}, () => {});
    return processing;
  }
  drain(): Promise<void> { return this.queue; }
  /** Channel summary for the Agents page; never includes credentials. */
  channel(): { name: 'feishu'; configured: boolean; recipient?: string; groups: number } {
    return { name: 'feishu', configured: Boolean(this.api), recipient: this.threads?.recipient()?.open_id, groups: [...this.state.bindings.values()].filter(binding => !binding.app_id || binding.app_id === this.api?.appId).length };
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
    const activation = Date.now(); const activationClock = performance.now();
    const binding: LarkBinding = { chat_id, app_id: this.api.appId, session_id, sender_open_id, metadata: body.metadata ?? 'announcement', pin: body.pin === true,
      activated_at: existing?.activated_at ?? activation,
      ...(isAdapter(body.adapter) ? { adapter: body.adapter } : {}), ...(typeof body.session_name === 'string' ? { session_name: body.session_name } : {}) };
    const remote = this.remote(binding);
    await registerPolledSession(this.state, remote.adapter, session_id, remote.session_name);
    await ensureAnnouncement(this.api, remote);
    if (binding.metadata === 'message') {
      binding.registration_message_id = existing?.registration_message_id;
      binding.registration_message_id = await ensureBindingMessage(this.api, this.remote(binding));
    }
    if (existing?.activated_at === undefined) binding.activated_at = larkActivationTime(this.api, activation, performance.now() - activationClock);
    this.state.bindings.set(chat_id, binding);
    await this.state.save();
    if (binding.pin && binding.registration_message_id) {
      try { await this.api.request('POST', '/open-apis/im/v1/pins', { message_id: binding.registration_message_id }); }
      catch (error) { this.report({ status: 'pin_failed', error: (error as Error).message }); }
    }
    return { body: binding };
  }
}
