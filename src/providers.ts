import { hostname } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { State } from './state.js';
import type { SessionsService } from './sessions.js';
import { CoreError, ProviderCore, coreErrorCode, provenCoreRejection, type CoreEvent, type CoreTransport } from './provider-core.js';
import { createLarkApi, type Credentials, type LarkApi } from './lark-metadata.js';
import { LarkReplies } from './lark-replies.js';
import { HttpError, RetryableDeliveryError, SessionUnavailable, identifier, isAdapter, isPolledAdapter, object, text, type RouteRequest, type RouteResponse, type ServiceModule } from './types.js';
import { discardCanceledInbox, registerPolledSession, type ProviderInboxSnapshot } from './polled-sessions.js';
import type { EmbeddedTailscaleTunnel, TsnetClient } from './tsnet-client.js';
import { forwardedProviderMessage } from './forwarded-messages.js';
import { decodeMessageRef, encodeMessageRef, parseMessageRef, type ProviderMessageRef } from './message-ref.js';
export { decodeMessageRef, encodeMessageRef, type ProviderMessageRef };
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
export interface ProviderPage {
  node_id: string; providers: ProviderSummary[]; default_provider_id?: string; remote: RemoteSummary;
  network?: { status: 'retrying' | 'unconfirmed'; error: string };
  compatibility?: { status: 'conflict'; error: string };
}
export interface ProvidersSource {
  page(): Promise<ProviderPage>;
  action(body: Record<string, unknown>): Promise<ProviderPage>;
  remote(): Promise<RemoteSummary & { node_id: string }>;
  configureRemote(body: Record<string, unknown>): Promise<RemoteSummary & { node_id: string }>;
  remoteSecret(): Promise<{ token: string }>;
}
export interface CompatibilityConfig { credentials?: Credentials; recipient?: string; provider_id?: string }
export type CompatibilityUpdate = (environment?: Credentials, recipient?: string) => Promise<CompatibilityConfig>;
export type CompatibilitySync = (update: CompatibilityUpdate, preview?: () => Promise<CompatibilityConfig>) => Promise<void>;
export type CompatibilityStartup = (reconcile: CompatibilityUpdate) => Promise<void>;
const environmentProviderId = (appId: string): string => `environment-feishu-${createHash('sha256').update(appId).digest('hex').slice(0, 16)}`;
interface SessionRef { node_id?: string; adapter: string; session_id: string; name?: string; metadata?: Record<string, unknown> }
interface Delivery { delivery_id: string; session: SessionRef; message: ProviderMessageRef; content: unknown; text: string }
interface Binding {
  provider_id: string; session: SessionRef; created: boolean; chat_id?: string; thread_id?: string; sender_open_id?: string;
  deleted?: boolean; delete_pending?: boolean; aliases?: Binding[];
}
function liveBindingResources(bindings: Binding[]): Binding[] {
  // Core aliases are leaves with independent trust and session metadata; parent deletion suppresses all of them.
  return bindings.flatMap(binding => binding.deleted ? [] : [binding, ...(binding.aliases ?? [])]
    .filter(resource => !resource.deleted && resource.chat_id));
}
function publicFailure(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = error instanceof CoreError ? error.code.toLowerCase() : '';
  const status = code === 'rejection_retryable' ? 503 : code === 'rejection_terminal' ? 422
    : /not.?found/.test(code) ? 404 : /invalid|argument|unsupported/.test(code) ? 400 : /unauth/.test(code) ? 401
    : /permission/.test(code) ? 403 : /conflict|exist|precondition|unconfirmed|committed_not_durable|deleted/.test(code) ? 409
    : /resource_exhausted/.test(code) ? 429 : /unavailable|timeout|busy/.test(code) ? 503 : 500;
  const failure = new HttpError(status, (error as Error).message); failure.cause = error; return failure;
}

/** Owns notification operations; existing agent adapters remain local and credential-isolated. */
export class ProvidersService implements ServiceModule, ProvidersSource {
  readonly name = 'providers';
  readonly core: CoreTransport;
  credentials?: Credentials;
  api?: LarkApi;
  private connection = 'starting';
  private cached?: ProviderPage;
  private bindingGroups?: number;
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly tunnels = new Map<string, EmbeddedTailscaleTunnel>();
  private readonly pendingTunnels = new Map<string, Promise<EmbeddedTailscaleTunnel>>();
  private remoteAddresses?: ReadonlySet<string>;
  private networkGeneration = 0;
  private published?: { port: number; target: string };
  private networkQueue: Promise<void> = Promise.resolve();
  private networkFailure?: ProviderPage['network'];
  private networkRetry?: NodeJS.Timeout;
  private draining = false;
  private stopping?: Promise<void>;
  private inboxTimer?: NodeJS.Timeout;
  private inboxReconciliation?: Promise<void>;
  private discoveryController?: AbortController;
  private discoveryTimer?: NodeJS.Timeout;
  private discovery?: Promise<void>;
  private compatibilitySync?: CompatibilitySync;
  private compatibilityStartup?: CompatibilityStartup;
  private compatibilityId = 'legacy-feishu';
  private compatibilityProblem?: string;
  private recipientSync?: (openId: string) => Promise<void>;
  constructor(readonly state: State, private readonly sessions: SessionsService,
    credentials: Credentials | undefined, private readonly report: (record: Record<string, unknown>) => void = () => {},
    private readonly port = 9417, private readonly tsnet?: TsnetClient, core?: CoreTransport, private readonly discover?: ThreadDiscovery) {
    this.credentials = credentials; this.api = credentials ? createLarkApi(credentials) : undefined;
    this.core = core ?? new ProviderCore(join(state.directory, 'provider-core'), event => this.event(event), undefined, undefined,
      () => { this.connection = 'failed'; this.report({ source: 'providers', status: 'core_stopped' }); });
  }
  status(): string { return this.connection === 'ready' && this.compatibilityProblem ? 'configuration-conflict' : this.connection; }
  compatibilityProviderId(): string { return this.compatibilityId; }
  channel(): { name: 'feishu'; configured: boolean; recipient?: string; groups: number } {
    const configured = this.cached?.providers.some(provider => provider.enabled) ?? false;
    return { name: 'feishu', configured, recipient: this.credentials ? this.state.settings.lark_recipient_open_id : undefined,
      groups: this.bindingGroups ?? this.state.bindings.size };
  }
  async start(): Promise<void> {
    try {
      await this.core.start();
      const saved = this.state.settings;
      const migrationCredentials = saved.lark_app_id && saved.lark_app_secret
        ? { appId: saved.lark_app_id, appSecret: saved.lark_app_secret } : this.credentials;
      if (migrationCredentials) {
        const bindings = [...this.state.bindings.values()].map(binding => {
          const registered = this.state.sessions.get(binding.session_id);
          const observed = [...this.state.sessionObservations.values()].filter(session => session.session_id === binding.session_id);
          const adapters = new Set(observed.map(session => session.adapter));
          const adapter = binding.adapter ?? registered?.adapter ?? (adapters.size === 1 ? observed[0].adapter : undefined);
          const appId = binding.app_id ?? migrationCredentials.appId;
          const cursor = [...this.state.larkPollCursors.values()].find(cursor => cursor.app_id === appId && cursor.chat_id === binding.chat_id
            && cursor.container_type === 'chat' && cursor.container_id === binding.chat_id);
          return { ...binding, ...(adapter ? { adapter } : {}), session_name: binding.session_name ?? registered?.session_name,
            ...(cursor ? { history_cursor: cursor.through } : {}) };
        });
        const senders = new Set(bindings.filter(binding => !binding.app_id || binding.app_id === migrationCredentials.appId).map(binding => binding.sender_open_id));
        const recipient = this.state.settings.lark_recipient_open_id ?? (migrationCredentials.appId === this.credentials?.appId ? process.env.LARK_NOTIFY_OPEN_ID : undefined)
          ?? (senders.size === 1 ? [...senders][0] : undefined);
        await this.rpc('migration.import', { app_id: migrationCredentials.appId, app_secret: migrationCredentials.appSecret,
          recipient_open_id: recipient, legacy_host: hostname(), bindings });
      }
      if (this.compatibilityStartup) {
        await this.compatibilityStartup((environment, recipient) => this.reconcileStartupCredentials(environment, recipient)).catch(error => {
          if (coreErrorCode(error) === 'committed_not_mirrored') return;
          if (!provenCoreRejection(error) && !(error instanceof HttpError && error.status === 409 && !coreErrorCode(error))) throw error;
          this.compatibilityProblem = 'Environment Feishu credentials could not be applied safely; select or create a provider for that App ID';
          this.report({ source: 'providers', status: 'environment_configuration_conflict', reason: this.compatibilityProblem });
        });
      } else if (this.compatibilitySync) {
        await this.compatibilitySync(() => this.compatibilityConfig()).catch(error => {
          if (coreErrorCode(error) !== 'committed_not_mirrored') throw error;
        });
      }
      await this.reconcileInbox().catch(error => this.report({ source: 'providers', status: 'inbox_reconciliation_pending', error: (error as Error).message }));
      this.inboxTimer = setInterval(() => { void this.reconcileInbox().catch(error => this.report({ source: 'providers', status: 'inbox_reconciliation_pending', error: (error as Error).message })); }, 30_000).unref();
      this.connection = 'ready'; await this.page();
      if (this.discover) {
        this.discoveryController = new AbortController();
        this.scheduleDiscovery();
        this.discoveryTimer = setInterval(() => this.scheduleDiscovery(), 60_000).unref();
      }
    } catch (error) { this.connection = 'failed'; this.report({ source: 'providers', status: 'core_failed', error: (error as Error).message }); }
  }
  stop(): Promise<void> { return this.stopping ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.draining = true; this.connection = 'stopped';
    clearInterval(this.discoveryTimer); clearInterval(this.inboxTimer); clearTimeout(this.networkRetry); this.discoveryController?.abort();
    await this.networkQueue.catch(() => {});
    if (this.discovery) await this.discovery;
    while (this.deliveries.size) await Promise.allSettled([...this.deliveries.values()]);
    await this.inboxReconciliation?.catch(() => {});
    await this.core.stop();
    await this.closeNetwork().catch(error => this.report({ source: 'providers', status: 'tailnet_cleanup_failed', error: (error as Error).message }));
  }
  consumeInbox(message: ProviderMessageRef): Promise<void> {
    const pending = [...this.state.inboxMessages.values()].some(item => item.source?.channel === 'provider'
      && item.source.delivery.message.origin_node_id === message.origin_node_id && item.source.delivery.message.provider_id === message.provider_id
      && item.source.delivery.message.message_id === message.message_id);
    return pending ? Promise.resolve() : this.rpc<void>('delivery.inbox.consume', { message });
  }
  reconcileInbox(): Promise<void> {
    if (this.inboxReconciliation) return this.inboxReconciliation;
    const task = (async () => {
      let before = 0; let pending: ProviderInboxSnapshot[] = [];
      // Capture a committed snapshot in the same queue as inbox enqueue/delete. The cutoff excludes later completions.
      await this.state.save({ apply: () => {
        before = Date.now(); pending = [...this.state.inboxMessages.values()].flatMap(item => item.source?.channel === 'provider'
          ? [{ inbox_id: item.id, message: item.source.delivery.message }] : []);
      }, rollback: () => {} });
      const result = await this.rpc<{ canceled?: ProviderMessageRef[] }>('delivery.inbox.reconcile', { pending, before });
      const canceled = Array.isArray(result?.canceled) ? result.canceled.map(parseMessageRef) : [];
      const removed = await discardCanceledInbox(this.state, pending, canceled);
      for (const message of removed) await this.consumeInbox(message).catch(error => this.report({
        source: 'providers', status: 'inbox_release_pending', message_id: message.message_id, error: (error as Error).message,
      }));
    })();
    this.inboxReconciliation = task;
    return task.finally(() => { if (this.inboxReconciliation === task) this.inboxReconciliation = undefined; });
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
  private async listBindings(): Promise<Binding[]> {
    const bindings = await this.rpc<Binding[]>('session.list');
    this.bindingGroups = liveBindingResources(bindings).length;
    return bindings;
  }
  async page(): Promise<ProviderPage> {
    const [page] = await Promise.all([this.rpc<ProviderPage>('status'), this.listBindings()]);
    this.cached = page;
    return { ...this.cached, ...(this.networkFailure ? { network: this.networkFailure } : {}),
      ...(this.compatibilityProblem ? { compatibility: { status: 'conflict' as const, error: this.compatibilityProblem } } : {}) };
  }
  private async commit(method: string, params: Record<string, unknown>): Promise<HttpError | undefined> {
    try { await this.rpc(method, params); }
    catch (error) { if (coreErrorCode(error) !== 'committed_not_durable') throw error; return error as HttpError; }
  }
  async action(body: Record<string, unknown>): Promise<ProviderPage> {
    let legacyChanged = false; let mutate: () => Promise<HttpError | undefined>; let warning: HttpError | undefined;
    let provider: Record<string, unknown> | undefined;
    if (body.action === 'save') {
      provider = object(body.provider);
      const config = provider;
      mutate = () => this.commit('provider.save', config); legacyChanged = provider.id === this.compatibilityId;
    } else if (body.action === 'delete' || body.action === 'default') {
      const id = identifier(body.id, 'id'); const method = `provider.${body.action}`;
      mutate = () => this.commit(method, { id }); legacyChanged = body.action === 'delete' && id === this.compatibilityId;
    } else throw new HttpError(400, 'Expected a provider action: save, delete or default');
    if (legacyChanged) {
      let previous: Record<string, unknown> | undefined;
      let candidate: Record<string, unknown> | undefined; let prepared = false;
      const prepare = async () => {
        if (!prepared) {
          previous = await this.compatibilityProviderConfig();
          candidate = provider ? { ...provider, enabled: provider.enabled ?? true,
            app_secret: typeof provider.app_secret === 'string' && provider.app_secret.trim() ? provider.app_secret : previous?.app_secret } : undefined;
          prepared = true;
        }
        return this.compatibilityFrom(candidate);
      };
      const update = async () => {
        await prepare();
        const unchanged = candidate ? previous && ['id', 'name', 'type', 'enabled', 'app_id', 'app_secret', 'recipient_open_id']
          .every(key => (candidate![key] ?? '') === (previous![key] ?? '')) : !previous;
        if (!unchanged) warning = await mutate();
        return this.compatibilityConfig();
      };
      if (this.compatibilitySync) await this.compatibilitySync(update, prepare);
      else this.refreshCompatibilityCredentials((await update()).credentials);
    } else warning = await mutate();
    await this.syncNetwork();
    if (warning) throw warning;
    return this.page();
  }
  /** Settings serializes legacy CRUD with account edits, persistence and directory invalidation. */
  setCompatibilitySync(sync: CompatibilitySync): void { this.compatibilitySync = sync; }
  setCompatibilityStartup(startup: CompatibilityStartup): void { this.compatibilityStartup = startup; }
  private async reconcileStartupCredentials(environment?: Credentials, recipient?: string): Promise<CompatibilityConfig> {
    const config = await this.exportConfig();
    const providers = config.providers as Record<string, unknown>[];
    const matches = (provider: Record<string, unknown>, appId?: string) => provider.type === 'feishu' && provider.app_id === appId;
    if (!environment) {
      const matching = providers.filter(provider => matches(provider, this.credentials?.appId));
      const selected = matching.find(provider => provider.enabled === true) ?? matching.find(provider => provider.id === this.compatibilityId)
        ?? matching[0] ?? providers.find(provider => provider.id === this.compatibilityId && provider.type === 'feishu');
      if (selected) this.compatibilityId = String(selected.id);
      return this.compatibilityFrom(selected);
    }
    const matching = providers.filter(provider => matches(provider, environment.appId));
    let selected = matching.find(provider => provider.enabled === true) ?? matching.find(provider => provider.id === this.compatibilityId) ?? matching[0];
    if (!selected) {
      const id = environmentProviderId(environment.appId);
      if (providers.some(provider => provider.id === id)) throw new HttpError(409, 'The environment provider ID belongs to another provider; create a provider for the environment App ID');
      selected = { id, type: 'feishu', name: 'Feishu (environment)', enabled: true, app_id: environment.appId };
    }
    const desired = { ...selected, app_secret: environment.appSecret,
      ...(recipient ? { recipient_open_id: recipient } : {}) };
    if (selected.app_secret !== environment.appSecret || recipient && selected.recipient_open_id !== recipient) {
      const warning = await this.commit('provider.save', desired);
      if (warning) this.report({ source: 'providers', status: 'environment_configuration_committed_not_durable' });
    }
    this.compatibilityId = String(selected.id);
    const priorApp = this.state.settings.lark_app_id;
    const managedDefault = !config.default_provider_id || config.default_provider_id === 'legacy-feishu'
      || priorApp && config.default_provider_id === environmentProviderId(priorApp);
    if (managedDefault && config.default_provider_id !== this.compatibilityId) {
      const warning = await this.commit('provider.default', { id: this.compatibilityId });
      if (warning) this.report({ source: 'providers', status: 'environment_default_committed_not_durable' });
    }
    this.compatibilityProblem = undefined;
    return this.compatibilityConfig();
  }
  private async compatibilityProviderConfig(): Promise<Record<string, unknown> | undefined> {
    // Public summaries omit secrets, and masked saves retain them inside the core.
    const config = await this.exportConfig();
    return (config.providers as Record<string, unknown>[]).find(provider => provider.id === this.compatibilityId && provider.type === 'feishu');
  }
  private compatibilityFrom(legacy?: Record<string, unknown>): CompatibilityConfig {
    return { credentials: legacy && legacy.type === 'feishu' ? { appId: String(legacy.app_id), appSecret: String(legacy.app_secret) } : undefined,
      recipient: typeof legacy?.recipient_open_id === 'string' ? legacy.recipient_open_id : undefined,
      provider_id: typeof legacy?.id === 'string' ? legacy.id : undefined };
  }
  private async compatibilityConfig(): Promise<CompatibilityConfig> { return this.compatibilityFrom(await this.compatibilityProviderConfig()); }
  async remote(): Promise<RemoteSummary & { node_id: string }> {
    const page = await this.page(); return { ...page.remote, node_id: page.node_id, ...(page.network ? { network: page.network } : {}) };
  }
  async configureRemote(body: Record<string, unknown>): Promise<RemoteSummary & { node_id: string }> {
    const warning = await this.commit('remote.configure', body); await this.syncNetwork(); if (warning) throw warning; return this.remote();
  }
  remoteSecret(): Promise<{ token: string }> { return this.rpc('remote.secret'); }
  exportConfig(): Promise<Record<string, unknown>> { return this.rpc('config.export'); }
  async importConfig(config: Record<string, unknown>): Promise<void> {
    const warning = await this.commit('config.import', config); await this.syncNetwork(); if (warning) throw warning;
  }
  /** Compatibility for old single-bot registration and import callers. New configuration uses provider instances. */
  async configure(credentials?: Credentials): Promise<void> {
    let warning: HttpError | undefined;
    if (credentials) warning = await this.commit('provider.save', { id: this.compatibilityId, type: 'feishu', name: 'Feishu', enabled: true,
      app_id: credentials.appId, app_secret: credentials.appSecret, recipient_open_id: this.state.settings.lark_recipient_open_id });
    else if ((await this.page()).providers.some(provider => provider.id === this.compatibilityId)) warning = await this.commit('provider.delete', { id: this.compatibilityId });
    this.refreshCompatibilityCredentials(credentials);
    if (warning) throw warning;
    await this.page().catch(error => this.report({ source: 'providers', status: 'configuration_status_unavailable', error: (error as Error).message }));
  }
  /** Refresh legacy HTTP/directory clients without changing imported provider instances. */
  refreshCompatibilityCredentials(credentials?: Credentials, providerId?: string): void {
    if (providerId) this.compatibilityId = providerId;
    if (this.credentials?.appId === credentials?.appId && this.credentials?.appSecret === credentials?.appSecret) return;
    this.credentials = credentials; this.api = credentials ? createLarkApi(credentials) : undefined;
  }
  setRecipientSync(sync: (openId: string) => Promise<void>): void { this.recipientSync = sync; }
  async setRecipient(open_id: string): Promise<void> {
    let page: ProviderPage;
    try { page = await this.page(); }
    catch { throw publicFailure(new CoreError('unavailable', 'Cannot inspect the Feishu provider before recipient submission')); }
    const legacy = page.providers.find(provider => provider.id === this.compatibilityId && provider.type === 'feishu');
    if (!legacy) throw new HttpError(404, 'No active compatibility Feishu provider; configure the recipient in Providers');
    let warning: unknown;
    try { await this.rpc('provider.save', { ...legacy, recipient_open_id: open_id }); }
    catch (error) { if (coreErrorCode(error) !== 'committed_not_durable') throw error; warning = error; }
    // The save response already confirms the change. A later status read cannot invalidate it.
    this.cached = { ...page, providers: page.providers.map(provider => provider.id === legacy.id ? { ...provider, recipient_open_id: open_id } : provider) };
    if (warning) throw warning;
  }
  networkDisconnected(): void {
    this.networkGeneration++;
    this.published = undefined; this.tunnels.clear(); this.pendingTunnels.clear();
    if (this.connection === 'ready') void this.rpc('transport.configure', { tailnet_enabled: false }).catch(() => {});
  }
  /** Called on embedded-network transitions, not by a message polling loop. */
  syncNetwork(): Promise<void> {
    const task = this.networkQueue.catch(() => {}).then(async () => {
      if (this.connection !== 'ready') return;
      const enabled = this.state.settings.tailscale_enabled === true;
      const page = await this.page();
      this.remoteAddresses = new Set(page.providers.filter(provider => provider.type === 'remote' && provider.enabled && provider.address).map(provider => provider.address!));
      await this.rpc('transport.configure', { tailnet_enabled: enabled });
      if (!enabled || !this.tsnet) { await this.closeNetwork(); return; }
      await this.retireTunnels(this.remoteAddresses);
      const remote = page.remote;
      if (!remote.enabled) { await this.unpublishCurrent(); return; }
      // The core validates host:port. Splitting the final colon also handles
      // bracketed IPv6 zone addresses, which are not valid WHATWG URL hosts.
      const separator = remote.listen.lastIndexOf(':');
      const port = Number(remote.listen.slice(separator + 1));
      // A wildcard listener is reachable through loopback too. The helper only accepts numeric loopback targets.
      const host = remote.listen.slice(0, separator).replace(/^\[|\]$/g, '');
      let loopback: string | undefined;
      if (host === 'localhost' || host === '0.0.0.0') loopback = '127.0.0.1';
      else if (isIP(host) === 4 && host.startsWith('127.')) loopback = host;
      else if (isIP(host) === 6 && !host.includes('%')) {
        const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
        if (canonical === '::1' || canonical === '::') loopback = '[::1]';
        else if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(canonical)) loopback = `[${canonical}]`;
      }
      if (!loopback) {
        await this.unpublishCurrent();
        throw new Error('Remote listener is not reachable through a supported loopback address');
      }
      const target = `${loopback}:${port}`;
      if (this.published?.port === port && this.published.target === target) return;
      await this.unpublishCurrent();
      await this.tsnet.publish(port, target); this.published = { port, target };
    });
    const settled = task.then(() => { this.networkFailure = undefined; clearTimeout(this.networkRetry); this.networkRetry = undefined; }, error => {
      const unconfirmed = Boolean(coreErrorCode(error)) && !provenCoreRejection(error);
      this.networkFailure = { status: unconfirmed ? 'unconfirmed' : 'retrying', error: (error as Error).message };
      this.report({ source: 'providers', status: 'network_reconciliation_failed', network_status: this.networkFailure.status, error: this.networkFailure.error });
      // Reconcile helper publication only after known outcomes; never resubmit an uncertain core command.
      if (!unconfirmed && !this.draining && !this.networkRetry) this.networkRetry = setTimeout(() => {
        this.networkRetry = undefined; void this.syncNetwork();
      }, 5000).unref();
    });
    this.networkQueue = settled;
    return settled;
  }
  private async unpublishCurrent(): Promise<void> {
    const publication = this.published;
    if (!publication || !this.tsnet) return;
    // Keep the handle if cleanup fails, so the next transition can retry it.
    await this.tsnet.unpublish(publication.port);
    this.published = undefined;
  }
  private async retireTunnels(addresses: ReadonlySet<string>): Promise<void> {
    for (const [address, tunnel] of this.tunnels) {
      if (!addresses.has(address)) await this.closeTunnel(address, tunnel);
    }
  }
  private async closeTunnel(address: string, tunnel: EmbeddedTailscaleTunnel): Promise<void> {
    await this.tsnet?.closeTunnel(tunnel.id);
    if (this.tunnels.get(address) === tunnel) this.tunnels.delete(address);
  }
  private async closeNetwork(): Promise<void> {
    await this.unpublishCurrent();
    await this.retireTunnels(new Set());
  }
  private async tunnel(address: string): Promise<EmbeddedTailscaleTunnel> {
    const network = this.tsnet;
    if (!network || !this.state.settings.tailscale_enabled || (this.remoteAddresses && !this.remoteAddresses.has(address))) throw new Error('Embedded provider transport is unavailable');
    const existing = this.tunnels.get(address);
    if (existing) return existing;
    const inFlight = this.pendingTunnels.get(address);
    if (inFlight) return inFlight;
    const generation = this.networkGeneration;
    const pending: Promise<EmbeddedTailscaleTunnel> = network.tunnel(address).then(async tunnel => {
      if (generation !== this.networkGeneration) throw new Error('Embedded helper was replaced');
      this.tunnels.set(address, tunnel);
      if (this.connection !== 'ready' || !this.state.settings.tailscale_enabled || (this.remoteAddresses && !this.remoteAddresses.has(address))) {
        // Track a failed close so configuration reconciliation can retry it.
        await this.closeTunnel(address, tunnel);
        throw new Error('Remote provider was removed before its tunnel opened');
      }
      return tunnel;
    }).finally(() => { if (this.pendingTunnels.get(address) === pending) this.pendingTunnels.delete(address); });
    this.pendingTunnels.set(address, pending);
    return pending;
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
      const tunnel = await this.tunnel(address);
      await this.rpc('dial.complete', { request_id, network: tunnel.network, address: tunnel.address, token: tunnel.token });
    } catch { await this.rpc('dial.complete', { request_id, error: 'Embedded Tailscale connection unavailable' }).catch(() => {}); }
  }
  private async deliver(delivery: Delivery): Promise<void> {
    let status = 'rejected'; let transport_status: string | undefined; let failure: string | undefined;
    try {
      if (this.draining) throw new RetryableDeliveryError('Notification service is stopping before agent submission');
      if (!isAdapter(delivery.session.adapter)) throw new SessionUnavailable('unsupported_adapter');
      if (this.deliveries.size >= 100) throw new RetryableDeliveryError('Agent delivery queue is full');
      const source = { channel: 'provider' as const, delivery: { adapter: delivery.session.adapter,
        session_id: delivery.session.session_id, message: parseMessageRef(delivery.message) } };
      const content = isPolledAdapter(delivery.session.adapter) ? delivery.text
        : forwardedProviderMessage(source.delivery, delivery.text, this.state.directory, this.port);
      const result = await this.sessions.send(delivery.session.session_id, content, delivery.session.adapter, { text: delivery.text, source });
      transport_status = result.status; status = 'delivered';
    } catch (error) {
      status = error instanceof RetryableDeliveryError ? 'retryable' : error instanceof SessionUnavailable
        || (error instanceof HttpError && [400, 404, 405, 409, 413, 415, 422].includes(error.status)) ? 'rejected' : 'unconfirmed';
      failure = (error as Error).message;
    }
    await this.rpc('delivery.complete', { delivery_id: delivery.delivery_id, status, transport_status, ...(failure ? { error: failure } : {}) });
    if (status === 'rejected' && isPolledAdapter(delivery.session.adapter)) await this.consumeInbox(delivery.message)
      .catch(error => this.report({ source: 'providers', status: 'inbox_release_pending', message_id: delivery.message.message_id, error: (error as Error).message }));
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
    if (request.path === '/v1/remote/identity' && request.method === 'GET') return { body: await this.rpc('remote.identity') };
    const peer = /^\/v1\/remote\/peers\/([^/]+)$/.exec(request.path);
    if (peer && request.method === 'PUT') return { body: await this.rpc('remote.peer.bind', {
      node_id: identifier(decodeURIComponent(peer[1]), 'node_id'), public_key: text(object(request.body).public_key, 'public_key'),
    }) };
    if (request.path === '/v1/providers') {
      if (request.method === 'GET') return { body: await this.page() };
      if (request.method === 'POST') return { body: await this.action(object(request.body)) };
    }
    if (request.path === '/v1/threads' && request.method === 'POST') {
      const body = object(request.body);
      if (body.channel !== undefined && body.channel !== 'feishu') throw new HttpError(400, 'Only Feishu notifications are supported');
      const session = await this.localSession(text(body.session_id, 'session_id'), body.adapter, body.session_name);
      await registerPolledSession(this.state, session.adapter as Parameters<typeof registerPolledSession>[1], session.session_id, session.name ?? session.session_id);
      const result = await this.rpc<Record<string, unknown>>('session.ensure', { session, ...(body.provider_id ? { provider_id: body.provider_id } : {}) });
      return { body: { ...result, channel: 'feishu', session_id: session.session_id, adapter: session.adapter, session_name: session.name } };
    }
    const thread = /^\/v1\/threads\/([^/]+)(?:\/(messages|metadata))?$/.exec(request.path);
    if (thread) {
      const body = request.body === undefined ? {} : object(request.body);
      if (body.channel !== undefined && body.channel !== 'feishu') throw new HttpError(400, 'Only Feishu notifications are supported');
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
      if (body.pin !== undefined && typeof body.pin !== 'boolean') throw new HttpError(400, 'Invalid pin flag');
      if (body.pin === true) throw new HttpError(400, 'Pinning binding messages is not supported by notification providers');
      // Older CLIs always send this default. The core preserves announcements and stores its route in the description.
      const value = body.metadata === 'announcement' ? undefined : body.metadata;
      if (typeof value === 'string') throw new HttpError(400, 'Legacy message metadata is not supported; providers store structured metadata in the group description');
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new HttpError(400, 'Invalid binding metadata; expected an object');
      const metadata = value as Record<string, unknown> | undefined;
      const chat_id = identifier(decodeURIComponent(bind[1]), 'chat_id');
      const sender_open_id = identifier(body.sender_open_id, 'sender_open_id');
      const session = await this.localSession(text(body.session_id, 'session_id'), body.adapter ?? 'claude-desktop', body.session_name);
      if (metadata) session.metadata = metadata;
      await registerPolledSession(this.state, session.adapter as Parameters<typeof registerPolledSession>[1], session.session_id, session.name ?? session.session_id);
      const result = await this.rpc<Record<string, unknown>>('session.bind', { session, chat_id, sender_open_id,
        ...(body.provider_id ? { provider_id: body.provider_id } : {}) });
      return { body: { ...result, session_id: session.session_id, adapter: session.adapter, session_name: session.name } };
    }
    if (request.path === '/v1/lark/bindings' && request.method === 'GET') {
      const bindings = await this.listBindings();
      return { body: liveBindingResources(bindings).map(binding => ({
        chat_id: binding.chat_id, thread_id: binding.thread_id, provider_id: binding.provider_id, node_id: binding.session.node_id,
        session_id: binding.session.session_id, adapter: binding.session.adapter, session_name: binding.session.name, sender_open_id: binding.sender_open_id,
        metadata: 'announcement', pin: false,
      })) };
    }
    if (request.path === '/v1/lark/recipient') {
      if (request.method === 'GET') return { body: { open_id: this.state.settings.lark_recipient_open_id } };
      if (request.method === 'PUT') {
        const open_id = text(object(request.body).open_id, 'open_id');
        if (!/^ou_[A-Za-z0-9]+$/.test(open_id)) throw new HttpError(400, 'Invalid recipient open_id');
        if (this.recipientSync) await this.recipientSync(open_id);
        else {
          const previous = this.state.settings.lark_recipient_open_id;
          const restore = () => { if (previous === undefined) delete this.state.settings.lark_recipient_open_id; else this.state.settings.lark_recipient_open_id = previous; };
          await this.state.save({ apply: () => { this.state.settings.lark_recipient_open_id = open_id; }, rollback: restore });
          try { await this.setRecipient(open_id); }
          catch (error) {
            if (provenCoreRejection(error) || error instanceof HttpError && error.status === 404) { restore(); await this.state.save(); }
            throw error;
          }
        }
        return { body: { open_id } };
      }
    }
    return;
  }
}
