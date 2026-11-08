import { hostname } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { State } from './state.js';
import type { SessionsService } from './sessions.js';
import { CoreError, ProviderCore, type CoreEvent, type CoreTransport } from './provider-core.js';
import { createLarkApi, type Credentials, type LarkApi } from './lark-metadata.js';
import { LarkReplies } from './lark-replies.js';
import { HttpError, RetryableDeliveryError, SessionUnavailable, identifier, isAdapter, object, text, type RouteRequest, type RouteResponse, type ServiceModule } from './types.js';
import { registerPolledSession } from './polled-sessions.js';
import type { TsnetClient } from './tsnet-client.js';
import { shellCommand, shellForClient, shellQuote } from './shell.js';
import { fileURLToPath } from 'node:url';
import type { ThreadDiscovery } from './lark-thread-sync.js';

export interface ProviderSummary {
  id: string; name: string; type: 'feishu' | 'remote'; enabled: boolean; status: string; error?: string;
  app_id?: string; recipient_open_id?: string; address?: string; tls?: boolean; server_name?: string;
  secret_set?: boolean; token_set?: boolean;
}
export interface RemoteSummary {
  enabled: boolean; listen: string; status: string; tls: boolean; token_set: boolean;
  tls_cert_file?: string; tls_key_file?: string;
  peers: { node_id: string; name?: string; connected_at: string; connected?: boolean; pending: number; last_ack?: string }[];
}
export interface ProviderPage { node_id: string; providers: ProviderSummary[]; default_provider_id?: string; remote: RemoteSummary }
export interface ProvidersSource {
  page(): Promise<ProviderPage>;
  action(body: Record<string, unknown>): Promise<ProviderPage>;
  remote(): Promise<RemoteSummary & { node_id: string }>;
  configureRemote(body: Record<string, unknown>): Promise<RemoteSummary & { node_id: string }>;
  remoteSecret(): Promise<{ token: string }>;
}
export interface ProviderMessageRef { origin_node_id: string; provider_id: string; message_id: string; [key: string]: unknown }
interface SessionRef { node_id?: string; adapter: string; session_id: string; name?: string; metadata?: Record<string, string> }
interface Delivery { delivery_id: string; session: SessionRef; message: ProviderMessageRef; content: unknown; text: string }
interface Binding { provider_id: string; session: SessionRef; created: boolean; chat_id?: string; thread_id?: string; sender_open_id?: string; deleted?: boolean; delete_pending?: boolean }
export function encodeMessageRef(ref: ProviderMessageRef): string { return Buffer.from(JSON.stringify(ref)).toString('base64url'); }
export function decodeMessageRef(value: string): ProviderMessageRef {
  if (value.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, 'Invalid message reference');
  let ref: unknown;
  try { ref = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new HttpError(400, 'Invalid message reference'); }
  const fields = object(ref);
  for (const key of ['origin_node_id', 'provider_id', 'message_id']) identifier(fields[key], key);
  return fields as ProviderMessageRef;
}
function publicFailure(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = error instanceof CoreError ? error.code.toLowerCase() : '';
  const status = code === 'rejection_retryable' ? 503 : code === 'rejection_terminal' ? 422
    : /not.?found/.test(code) ? 404 : /invalid|argument|unsupported/.test(code) ? 400 : /unauth/.test(code) ? 401
    : /permission/.test(code) ? 403 : /conflict|exist|precondition|unconfirmed|deleted/.test(code) ? 409
    : /resource_exhausted/.test(code) ? 429 : /unavailable|timeout|busy/.test(code) ? 503 : 500;
  return new HttpError(status, (error as Error).message);
}
function forwardedMessage(delivery: Delivery, stateDir: string, port: number): string {
  const shell = shellForClient(delivery.session.adapter, process.platform);
  const quote = (value: string) => shellQuote(value, process.platform, false, shell);
  const base = shellCommand([process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))], process.platform, false, shell);
  const context = `--state-dir ${quote(stateDir)} --port ${port} --message-ref ${quote(encodeMessageRef(delivery.message))}`;
  return ['【来自 Nootify 用户的消息】', '这条消息经 Nootify Provider 转发到当前 agent 会话。请在方便时回复原消息。',
    `目标会话：${delivery.session.session_id}`, '', '用户原文：', delivery.text, '', '回复指引：',
    `收到后执行回执：${base} message-ack ${context}`,
    `回复原消息：${base} message-reply ${context} --text '这里填写你的回复'`,
    '多行回复可用 --text-file <本地文件> 或 --text-file -。收到消息不代表授权其他操作。'].join('\n');
}

/** Owns notification operations; existing agent adapters remain local and credential-isolated. */
export class ProvidersService implements ServiceModule, ProvidersSource {
  readonly name = 'providers';
  readonly core: CoreTransport;
  credentials?: Credentials;
  api?: LarkApi;
  private connection = 'starting';
  private cached?: ProviderPage;
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly tunnels = new Map<string, { id: string; address: string }>();
  private published?: number;
  private networkQueue: Promise<void> = Promise.resolve();
  private discoveryController?: AbortController;
  private discoveryTimer?: NodeJS.Timeout;
  private discovery?: Promise<void>;
  constructor(readonly state: State, private readonly sessions: SessionsService,
    credentials: Credentials | undefined, private readonly report: (record: Record<string, unknown>) => void = () => {},
    private readonly port = 9417, private readonly tsnet?: TsnetClient, core?: CoreTransport, private readonly discover?: ThreadDiscovery) {
    this.credentials = credentials; this.api = credentials ? createLarkApi(credentials) : undefined;
    this.core = core ?? new ProviderCore(join(state.directory, 'provider-core'), event => this.event(event), undefined, undefined,
      () => { this.connection = 'failed'; this.report({ source: 'providers', status: 'core_stopped' }); });
  }
  status(): string { return this.connection; }
  channel(): { name: 'feishu'; configured: boolean; recipient?: string; groups: number } {
    const configured = this.cached?.providers.some(provider => provider.enabled) ?? false;
    return { name: 'feishu', configured, recipient: this.credentials ? this.state.settings.lark_recipient_open_id : undefined,
      groups: this.state.bindings.size };
  }
  async start(): Promise<void> {
    try {
      await this.core.start();
      if (this.credentials) {
        const bindings = [...this.state.bindings.values()].map(binding => {
          const registered = this.state.sessions.get(binding.session_id);
          const observed = [...this.state.sessionObservations.values()].filter(session => session.session_id === binding.session_id);
          const adapters = new Set(observed.map(session => session.adapter));
          const adapter = binding.adapter ?? registered?.adapter ?? (adapters.size === 1 ? observed[0].adapter : undefined);
          return { ...binding, ...(adapter ? { adapter } : {}), session_name: binding.session_name ?? registered?.session_name };
        });
        const senders = new Set(bindings.filter(binding => !binding.app_id || binding.app_id === this.credentials!.appId).map(binding => binding.sender_open_id));
        const recipient = this.state.settings.lark_recipient_open_id ?? process.env.LARK_NOTIFY_OPEN_ID
          ?? (senders.size === 1 ? [...senders][0] : undefined);
        await this.rpc('migration.import', { app_id: this.credentials.appId, app_secret: this.credentials.appSecret,
          recipient_open_id: recipient, legacy_host: hostname(), bindings });
      }
      this.connection = 'ready'; await this.page();
      if (this.discover) {
        this.discoveryController = new AbortController();
        this.scheduleDiscovery();
        this.discoveryTimer = setInterval(() => this.scheduleDiscovery(), 60_000).unref();
      }
    } catch (error) { this.connection = 'failed'; this.report({ source: 'providers', status: 'core_failed', error: (error as Error).message }); }
  }
  async stop(): Promise<void> {
    this.connection = 'stopped';
    clearInterval(this.discoveryTimer); this.discoveryController?.abort();
    await this.networkQueue.catch(() => {});
    await this.core.stop();
    await this.closeNetwork().catch(error => this.report({ source: 'providers', status: 'tailnet_cleanup_failed', error: (error as Error).message }));
    await Promise.allSettled([...this.deliveries.values(), ...(this.discovery ? [this.discovery] : [])]);
  }
  private scheduleDiscovery(): void {
    if (this.discovery || !this.discover || !this.discoveryController || this.discoveryController.signal.aborted) return;
    const signal = this.discoveryController.signal;
    const task = (async () => {
      const page = await this.page();
      const selected = page.providers.find(provider => provider.id === page.default_provider_id && provider.enabled);
      if (!selected || (selected.type === 'feishu' && !selected.recipient_open_id)) return;
      const bindings = await this.rpc<Binding[]>('session.list');
      const existing = new Set(bindings.filter(binding => binding.session.node_id === page.node_id)
        .map(binding => `${binding.session.adapter}:${binding.session.session_id}`));
      const needsSession = (candidate: { adapter: string; session_id: string }) => !existing.has(`${candidate.adapter}:${candidate.session_id}`);
      for await (const candidate of this.discover!(signal, needsSession)) {
        if (signal.aborted || this.cached?.default_provider_id !== page.default_provider_id) return;
        try {
          if (!needsSession(candidate)) continue;
          await this.rpc('session.ensure', { automatic: true, session: {
            node_id: page.node_id, adapter: candidate.adapter, session_id: candidate.session_id, name: candidate.session_name,
          } });
        } catch (error) {
          if (!signal.aborted) this.report({ source: 'providers', status: 'session_enrollment_failed', session_id: candidate.session_id, error: (error as Error).message });
        }
      }
    })().catch(error => { if (!signal.aborted) this.report({ source: 'providers', status: 'session_discovery_failed', error: (error as Error).message }); });
    this.discovery = task;
    void task.finally(() => { if (this.discovery === task) this.discovery = undefined; });
  }
  private async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try { return await this.core.request<T>(method, params); } catch (error) { throw publicFailure(error); }
  }
  async page(): Promise<ProviderPage> {
    this.cached = await this.rpc<ProviderPage>('status'); return this.cached;
  }
  async action(body: Record<string, unknown>): Promise<ProviderPage> {
    if (body.action === 'save') await this.rpc('provider.save', object(body.provider));
    else if (body.action === 'delete') await this.rpc('provider.delete', { id: identifier(body.id, 'id') });
    else if (body.action === 'default') await this.rpc('provider.default', { id: identifier(body.id, 'id') });
    else throw new HttpError(400, 'Expected a provider action: save, delete or default');
    return this.page();
  }
  async remote(): Promise<RemoteSummary & { node_id: string }> { const page = await this.page(); return { ...page.remote, node_id: page.node_id }; }
  async configureRemote(body: Record<string, unknown>): Promise<RemoteSummary & { node_id: string }> {
    await this.rpc('remote.configure', body); await this.syncNetwork(); return this.remote();
  }
  remoteSecret(): Promise<{ token: string }> { return this.rpc('remote.secret'); }
  exportConfig(): Promise<Record<string, unknown>> { return this.rpc('config.export'); }
  async importConfig(config: Record<string, unknown>): Promise<void> { await this.rpc('config.import', config); await this.syncNetwork(); }
  /** Compatibility for old single-bot registration and import callers. New configuration uses provider instances. */
  async configure(credentials?: Credentials): Promise<void> {
    if (credentials) await this.rpc('provider.save', { id: 'legacy-feishu', type: 'feishu', name: 'Feishu', enabled: true,
      app_id: credentials.appId, app_secret: credentials.appSecret, recipient_open_id: this.state.settings.lark_recipient_open_id });
    else if ((await this.page()).providers.some(provider => provider.id === 'legacy-feishu')) await this.rpc('provider.delete', { id: 'legacy-feishu' });
    this.credentials = credentials; this.api = credentials ? createLarkApi(credentials) : undefined; await this.page();
  }
  async setRecipient(open_id: string): Promise<void> {
    const legacy = (await this.page()).providers.find(provider => provider.id === 'legacy-feishu' && provider.type === 'feishu');
    if (!legacy) throw new HttpError(404, 'No migrated Feishu provider; configure the recipient in Providers');
    await this.rpc('provider.save', { ...legacy, recipient_open_id: open_id });
    await this.page();
  }
  networkDisconnected(): void {
    this.published = undefined; this.tunnels.clear();
    if (this.connection === 'ready') void this.rpc('transport.configure', { tailnet_enabled: false }).catch(() => {});
  }
  /** Called on embedded-network transitions, not by a message polling loop. */
  syncNetwork(): Promise<void> {
    const task = this.networkQueue.catch(() => {}).then(async () => {
      if (this.connection !== 'ready') return;
      const enabled = this.state.settings.tailscale_enabled === true;
      await this.rpc('transport.configure', { tailnet_enabled: enabled });
      const remote = (await this.page()).remote;
      if (!enabled || !remote.enabled || !this.tsnet) { await this.closeNetwork(); return; }
      // The core validates host:port. Splitting the final colon also handles
      // bracketed IPv6 zone addresses, which are not valid WHATWG URL hosts.
      const separator = remote.listen.lastIndexOf(':');
      const port = Number(remote.listen.slice(separator + 1));
      // A wildcard listener is reachable through loopback too. The helper only accepts numeric loopback targets.
      const host = remote.listen.slice(0, separator).replace(/^\[|\]$/g, '');
      if (!['127.0.0.1', '0.0.0.0', 'localhost'].includes(host)) {
        await this.unpublishCurrent();
        this.report({ source: 'providers', status: 'tailnet_publish_skipped', reason: 'listener_not_loopback_reachable' }); return;
      }
      if (this.published === port) return;
      await this.unpublishCurrent();
      await this.tsnet.publish(port, `127.0.0.1:${port}`); this.published = port;
    });
    this.networkQueue = task;
    return task;
  }
  private async unpublishCurrent(): Promise<void> {
    const port = this.published;
    if (port === undefined || !this.tsnet) return;
    // Keep the handle if cleanup fails, so the next transition can retry it.
    await this.tsnet.unpublish(port);
    this.published = undefined;
  }
  private async closeNetwork(): Promise<void> {
    await this.unpublishCurrent();
    for (const tunnel of this.tunnels.values()) await this.tsnet?.closeTunnel(tunnel.id).catch(() => {});
    this.tunnels.clear();
  }
  private event(event: CoreEvent): void {
    if (event.event === 'log') { this.report({ source: 'providers', ...event.data }); return; }
    if (event.event === 'dial') { void this.dial(event.data); return; }
    if (event.event !== 'delivery') return;
    const delivery = event.data as unknown as Delivery;
    if (!delivery.delivery_id || this.deliveries.has(delivery.delivery_id)) return;
    const operation = this.deliver(delivery).catch(error => this.report({ source: 'providers', status: 'delivery_completion_failed', error: (error as Error).message }));
    this.deliveries.set(delivery.delivery_id, operation);
    void operation.finally(() => { this.deliveries.delete(delivery.delivery_id); });
  }
  private async dial(data: Record<string, unknown>): Promise<void> {
    const request_id = data.request_id;
    try {
      const address = text(data.address, 'address');
      if (!this.tsnet || !this.state.settings.tailscale_enabled) throw new Error('Embedded Tailscale is disabled');
      let tunnel = this.tunnels.get(address);
      if (!tunnel) { tunnel = await this.tsnet.tunnel(address); this.tunnels.set(address, tunnel); }
      await this.rpc('dial.complete', { request_id, address: tunnel.address });
    } catch { await this.rpc('dial.complete', { request_id, error: 'Embedded Tailscale connection unavailable' }).catch(() => {}); }
  }
  private async deliver(delivery: Delivery): Promise<void> {
    let status = 'rejected'; let transport_status: string | undefined; let failure: string | undefined;
    try {
      if (!isAdapter(delivery.session.adapter)) throw new SessionUnavailable('unsupported_adapter');
      if (this.deliveries.size >= 100) throw new RetryableDeliveryError('Agent delivery queue is full');
      const result = await this.sessions.send(delivery.session.session_id, forwardedMessage(delivery, this.state.directory, this.port), delivery.session.adapter);
      transport_status = result.status; status = 'delivered';
    } catch (error) {
      status = error instanceof RetryableDeliveryError ? 'retryable' : error instanceof SessionUnavailable
        || (error instanceof HttpError && [400, 404, 405, 409, 413, 415, 422].includes(error.status)) ? 'rejected' : 'unconfirmed';
      failure = (error as Error).message;
    }
    await this.rpc('delivery.complete', { delivery_id: delivery.delivery_id, status, transport_status, ...(failure ? { error: failure } : {}) });
    this.report({ source: 'providers', status: transport_status ?? status, session_id: delivery.session.session_id,
      message_id: delivery.message.message_id, provider_id: delivery.message.provider_id });
  }
  private async localSession(id: string, adapter: unknown, name?: unknown): Promise<SessionRef> {
    if (!isAdapter(adapter)) throw new HttpError(400, 'Unsupported session adapter');
    const session_id = identifier(id, 'session_id');
    const sessionName = typeof name === 'string' ? name.trim().slice(0, 80) : this.sessions.sessionName(session_id, adapter);
    const node_id = (await this.page()).node_id;
    return { node_id, adapter, session_id, name: sessionName };
  }
  private async threadSession(id: string, adapter: unknown, providerId: unknown): Promise<SessionRef> {
    if (adapter !== undefined) return this.localSession(id, adapter);
    const session_id = identifier(id, 'session_id');
    const { node_id } = await this.page();
    const bindings = await this.rpc<Binding[]>('session.list');
    const local = bindings.filter(binding => binding.session.node_id === node_id && binding.session.session_id === session_id);
    const scoped = typeof providerId === 'string' ? local.filter(binding => binding.provider_id === providerId) : local;
    const candidates = scoped.length ? scoped : local;
    const adapters = new Set(candidates.map(binding => binding.session.adapter));
    if (adapters.size > 1) throw new HttpError(409, 'This session ID has multiple adapter bindings; specify adapter');
    const resolved = candidates[0]?.session.adapter ?? this.state.sessions.get(session_id)?.adapter;
    if (!resolved) throw new HttpError(404, 'No notification session with this ID; specify adapter');
    return this.localSession(session_id, resolved);
  }
  async handle(request: RouteRequest): Promise<RouteResponse | undefined> {
    if (request.path === '/v1/providers') {
      if (request.method === 'GET') return { body: await this.page() };
      if (request.method === 'POST') return { body: await this.action(object(request.body)) };
    }
    if (request.path === '/v1/threads' && request.method === 'POST') {
      const body = object(request.body);
      const session = await this.localSession(text(body.session_id, 'session_id'), body.adapter, body.session_name);
      await registerPolledSession(this.state, session.adapter as Parameters<typeof registerPolledSession>[1], session.session_id, session.name ?? session.session_id);
      const result = await this.rpc<Record<string, unknown>>('session.ensure', { session, ...(body.provider_id ? { provider_id: body.provider_id } : {}) });
      return { body: { ...result, channel: 'feishu', session_id: session.session_id, adapter: session.adapter, session_name: session.name } };
    }
    const thread = /^\/v1\/threads\/([^/]+)(?:\/(messages|metadata))?$/.exec(request.path);
    if (thread) {
      const body = request.body === undefined ? {} : object(request.body);
      const session = await this.threadSession(decodeURIComponent(thread[1]), body.adapter, body.provider_id);
      const provider = body.provider_id ? { provider_id: body.provider_id } : {};
      if (request.method === 'DELETE' && !thread[2]) return { body: await this.rpc('session.delete', { session, ...provider }) };
      if (thread[2] === 'metadata' && ['GET', 'PUT'].includes(request.method)) return { body: await this.rpc(
        request.method === 'GET' ? 'session.metadata.get' : 'session.metadata.set', { session, ...provider, ...(request.method === 'PUT' ? { metadata: object(body.metadata) } : {}) }) };
      if (request.method === 'POST' && thread[2] === 'messages') {
        const content = body.content === undefined ? { text: text(body.text, 'text') } : object(body.content);
        return { body: { ...await this.rpc<Record<string, unknown>>('message.send', { session, ...provider, content,
          ...(typeof body.request_id === 'string' ? { request_id: body.request_id } : {}) }), channel: 'feishu' } };
      }
    }
    const callback = /^\/v1\/(?:lark\/messages|provider-messages)\/([^/]+)\/(ack|reply)$/.exec(request.path);
    if (callback && request.method === 'POST') {
      const body = object(request.body);
      const message = request.path.startsWith('/v1/provider-messages/')
        ? { message: decodeMessageRef(decodeURIComponent(callback[1])) } : { message_id: identifier(decodeURIComponent(callback[1]), 'message_id') };
      const content = callback[2] === 'reply' ? body.content ?? { text: text(body.text, 'text') } : undefined;
      const request_id = typeof body.request_id === 'string' ? body.request_id
        : createHash('sha256').update(JSON.stringify({ message, content })).digest('hex');
      try {
        const result = await this.rpc<Record<string, unknown>>(`message.${callback[2]}`, { ...message,
          ...(content ? { content, request_id } : {}) });
        return { body: callback[2] === 'reply' ? { ...result, status: 'replied', reply_id: result.message_id } : result };
      } catch (error) {
        // Messages forwarded before migration retain their old reply context and deduplication ledger.
        const id = 'message_id' in message ? message.message_id : undefined;
        if (!(error instanceof HttpError && error.status === 404 && id && this.api && this.state.larkDelivery(id))) throw error;
        const legacy = (await this.page()).providers.find(provider => provider.id === 'legacy-feishu');
        if (!legacy?.enabled || legacy.app_id !== this.api.appId) throw error;
        const replies = new LarkReplies(this.state, this.api, this.report);
        return { body: callback[2] === 'ack' ? await replies.acknowledge(id) : await replies.reply(id, text(body.text, 'text')) };
      }
    }
    const bind = /^\/v1\/lark\/bindings\/([^/]+)$/.exec(request.path);
    if (bind && request.method === 'PUT') {
      const body = object(request.body);
      const session = await this.localSession(text(body.session_id, 'session_id'), body.adapter ?? 'claude-desktop', body.session_name);
      await registerPolledSession(this.state, session.adapter as Parameters<typeof registerPolledSession>[1], session.session_id, session.name ?? session.session_id);
      const result = await this.rpc<Record<string, unknown>>('session.bind', { session, chat_id: identifier(decodeURIComponent(bind[1]), 'chat_id'),
        sender_open_id: identifier(body.sender_open_id, 'sender_open_id'), ...(body.provider_id ? { provider_id: body.provider_id } : {}) });
      return { body: { ...result, session_id: session.session_id, adapter: session.adapter, session_name: session.name } };
    }
    if (request.path === '/v1/lark/bindings' && request.method === 'GET') {
      const bindings = await this.rpc<Binding[]>('session.list');
      return { body: bindings.filter(binding => !binding.deleted && binding.chat_id).map(binding => ({
        chat_id: binding.chat_id, provider_id: binding.provider_id, session_id: binding.session.session_id,
        adapter: binding.session.adapter, session_name: binding.session.name, sender_open_id: binding.sender_open_id,
        metadata: 'announcement', pin: false,
      })) };
    }
    if (request.path === '/v1/lark/recipient') {
      if (request.method === 'GET') return { body: { open_id: this.state.settings.lark_recipient_open_id } };
      if (request.method === 'PUT') {
        const open_id = text(object(request.body).open_id, 'open_id');
        if (!/^ou_[A-Za-z0-9]+$/.test(open_id)) throw new HttpError(400, 'Invalid recipient open_id');
        await this.setRecipient(open_id);
        this.state.settings.lark_recipient_open_id = open_id; await this.state.save(); return { body: { open_id } };
      }
    }
    return;
  }
}
