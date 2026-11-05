import type { TailnetAccess } from './tailnet.js';
import type { TailnetListener } from './tailnet-proxy.js';
import type { EmbeddedTailscaleClient } from './tsnet-client.js';
import type { State } from './state.js';
import { HttpError } from './types.js';

export interface TailscaleLogin { status: 'idle' | 'starting' | 'waiting' | 'failed'; url?: string; error?: string }
export interface TailscalePage {
  enabled: boolean;
  status: 'disabled' | 'needs-login' | 'starting' | 'needs-approval' | 'connected' | 'unavailable';
  deviceName: string; account?: string; address?: string; dnsName?: string; url?: string;
  sharing: 'off' | 'starting' | 'ready' | 'error'; error?: string;
  login: TailscaleLogin;
}
export function tailscaleLoginUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'login.tailscale.com' && !url.port && !url.username && !url.password
        && /^\/a\/[a-zA-Z0-9]+$/.test(url.pathname) && !url.search && !url.hash) return url.href;
  } catch { /* Only the official browser authorization flow is opened by the UI. */ }
}
interface Options {
  state: State; access: TailnetAccess; client: EmbeddedTailscaleClient; listen: () => Promise<TailnetListener>;
  report?: (record: Record<string, unknown>) => void;
}
/** Owns Nootify's independent tsnet device and its private backend. System Tailscale is never used. */
export class TailscaleService {
  private pageState: TailscalePage = { enabled: false, status: 'disabled', deviceName: 'nootify', sharing: 'off', login: { status: 'idle' } };
  private refreshPromise?: Promise<void>;
  private checked = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private node?: { listener: TailnetListener };
  private retryAt = 0;
  private statusFailures = 0;
  private lastOutcome = '';
  private reportOutcome(record: Record<string, unknown>): void {
    const outcome = JSON.stringify(record);
    if (outcome === this.lastOutcome) return;
    this.lastOutcome = outcome; this.options.report?.({ source: 'host', ...record });
  }
  constructor(private readonly options: Options) { this.pageState.enabled = options.state.settings.tailscale_enabled === true; }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(action); this.queue = result; return result;
  }
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, 5000).unref();
  }
  async page(): Promise<TailscalePage> {
    if (Date.now() - this.checked > 1500) await this.refresh();
    return { ...this.pageState, login: { ...this.pageState.login }, url: this.options.access.url() };
  }
  refresh(): Promise<void> {
    return this.refreshPromise ??= this.serialized(() => this.synchronize()).finally(() => { this.refreshPromise = undefined; });
  }
  private async synchronize(): Promise<void> {
    if (this.stopped) return;
    if (!this.pageState.enabled) { await this.disconnect(); this.reset(); this.checked = Date.now(); return; }
    if (!this.node && Date.now() < this.retryAt) return;
    try {
      if (!this.node) {
        this.pageState.status = 'starting'; this.pageState.sharing = 'starting';
        const run = { listener: await this.options.listen() };
        if (this.stopped) { await run.listener.close(); return; }
        this.node = run;
        await this.options.client.start(run.listener.target, error => {
          if (this.node !== run) return;
          this.node = undefined; this.options.access.publish(undefined, false);
          void run.listener.close();
          if (!this.stopped && this.pageState.enabled) this.failure(publicError(new Error(error ?? 'embedded_client_stopped')));
        });
        if (this.stopped || this.node !== run) { await this.options.client.stop(); return; }
      }
      const run = this.node;
      let raw: unknown;
      try { raw = await this.options.client.status(); }
      catch (error) {
        const transient = ['busy', 'timeout', 'status_failed', 'embedded_request_timeout', 'embedded_client_busy'].includes((error as Error)?.message);
        if (this.node === run && transient && ++this.statusFailures < 3) return;
        throw error;
      }
      this.statusFailures = 0;
      if (!run || this.node !== run || this.stopped) return;
      const data = raw as { BackendState?: string; AuthURL?: string; NootifyListening?: boolean; Self?: { HostName?: string } };
      const previous = this.options.access.url();
      const parsed = this.options.access.publish(raw, data?.NootifyListening === true);
      const statuses: Record<string, TailscalePage['status']> = { Running: 'connected', NeedsLogin: 'needs-login', Stopped: 'starting', Starting: 'starting', NeedsMachineAuth: 'needs-approval' };
      this.pageState.status = statuses[data?.BackendState ?? ''] ?? 'unavailable';
      this.pageState.account = parsed?.owner; this.pageState.address = parsed?.address;
      this.pageState.dnsName = parsed?.names.find(name => name.endsWith('.ts.net'));
      this.pageState.deviceName = this.pageState.dnsName?.split('.')[0] || data?.Self?.HostName || 'nootify';
      const ready = !!this.options.access.url();
      this.pageState.sharing = ready ? 'ready' : 'starting'; delete this.pageState.error;
      const url = data?.BackendState === 'NeedsLogin' && typeof data.AuthURL === 'string' ? tailscaleLoginUrl(data.AuthURL) : undefined;
      this.pageState.login = url ? { status: 'waiting', url } : { status: 'idle' };
      if (ready && previous !== this.options.access.url()) this.reportOutcome({ status: 'tailnet_listening', reason: this.options.access.url() });
    } catch (error) {
      await this.disconnect();
      if (!this.stopped) this.failure(publicError(error));
    } finally { this.checked = Date.now(); }
  }
  private failure(error: string): void {
    this.options.access.publish(undefined, false);
    this.pageState.status = 'unavailable'; this.pageState.sharing = 'error'; this.pageState.error = error;
    delete this.pageState.address; delete this.pageState.account; delete this.pageState.dnsName;
    this.pageState.login = { status: 'idle' }; this.retryAt = Date.now() + 30_000;
    this.reportOutcome({ status: 'tailnet_failed', error });
  }
  private reset(): void {
    this.lastOutcome = ''; this.statusFailures = 0;
    this.pageState = { enabled: false, status: 'disabled', deviceName: 'nootify', sharing: 'off', login: { status: 'idle' } };
  }
  private async persist(enabled: boolean): Promise<void> {
    const previous = this.options.state.settings.tailscale_enabled;
    this.options.state.settings.tailscale_enabled = enabled;
    try { await this.options.state.save(); }
    catch (error) { this.options.state.settings.tailscale_enabled = previous; throw error; }
    this.pageState.enabled = enabled;
  }
  async setEnabled(enabled: unknown): Promise<void> {
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'Expected a boolean enabled setting');
    await this.serialized(async () => {
      if (this.stopped) throw new HttpError(409, 'Tailscale settings are stopping');
      await this.persist(enabled); this.retryAt = 0;
      await this.synchronize();
    });
  }
  async startLogin(): Promise<TailscaleLogin> {
    return this.serialized(async () => {
      if (this.stopped) throw new HttpError(409, 'Tailscale settings are stopping');
      const wasEnabled = this.pageState.enabled;
      if (!wasEnabled) await this.persist(true);
      this.retryAt = 0;
      await this.synchronize();
      if (!this.node) return { ...this.pageState.login, status: 'failed', error: this.pageState.error };
      if (this.pageState.status === 'connected' || (!wasEnabled && this.pageState.login.url)) return { ...this.pageState.login };
      this.pageState.login = { status: 'starting' };
      try { await this.options.client.login(); await this.synchronize(); }
      catch (error) { this.pageState.login = { status: 'failed', error: publicError(error) }; }
      return { ...this.pageState.login };
    });
  }
  /** Canceling first-time enrollment takes only this independent node offline. */
  async cancelLogin(): Promise<void> { await this.setEnabled(false); }
  async logout(): Promise<void> {
    await this.serialized(async () => {
      if (this.stopped) throw new HttpError(409, 'Tailscale settings are stopping');
      if (!this.node) throw new HttpError(409, 'Enable the Nootify device before signing out');
      await this.options.client.logout();
      // Always take the signed-out node offline, even if saving the preference fails.
      try { await this.persist(false); }
      finally { this.pageState.enabled = false; await this.disconnect(); this.reset(); }
    });
  }
  private async disconnect(): Promise<void> {
    const run = this.node; this.node = undefined; this.statusFailures = 0;
    this.pageState.sharing = 'off';
    this.options.access.publish(undefined, false);
    if (run) await run.listener.close();
    await this.options.client.stop();
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.timer);
    // Interrupt pending RPCs first, then wait for serialized state work to settle.
    await this.disconnect(); await this.queue.catch(() => {}); await this.disconnect();
  }
}
function publicError(error: unknown): string {
  const code = (error as Error)?.message;
  return ['embedded_client_missing', 'embedded_client_stopped', 'embedded_protocol_error', 'embedded_request_timeout', 'state_locked', 'state_unavailable', 'listener_failed', 'startup_failed', 'client_unavailable', 'busy', 'timeout', 'status_failed'].includes(code)
    ? code : 'embedded_request_failed';
}
