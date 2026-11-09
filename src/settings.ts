import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { AGENT_IDS, isAgent, type AgentId, type AgentPrompt } from './agents.js';
import { localEndpoint } from './codex-rpc.js';
import { parsePullConfig } from './github-api.js';
import type { GitHubAccount, GitHubAuth, GitHubLogin } from './github-auth.js';
import { parseGitHubRemote } from './github-model.js';
import { resolveCredentials, verifyCredentials, type CredentialSource, type Credentials } from './lark-metadata.js';
import { isOpenId } from './lark-threads.js';
import { isLarkConnectionType, type LarkConnectionType, type State } from './state.js';
import { HttpError, type BackendConnection, type LarkBinding } from './types.js';
import type { TailscaleService, TailscalePage, TailscaleLogin } from './tailscale.js';
import { larkDirectory, LarkDirectoryPermissionError, type LarkDirectory } from './lark-directory.js';
import { larkPermissionHelp, LarkPermissionRequiredError, type LarkPermissionHelp } from './lark-permissions.js';
import type { LarkApi } from './lark-metadata.js';
import { inspectLarkSetup, LarkRegistration, type LarkRegistrationOptions, type LarkRegistrationPage, type LarkRegistrationResult, type LarkSetup } from './lark-registration.js';
import { DIRECTORY_FRESH_MS, DIRECTORY_MAX_AGE_MS, LarkDirectoryCache } from './lark-directory-cache.js';
import { mergeRecipients } from './lark-profile.js';
import type { CompatibilityConfig, CompatibilitySync, ProvidersService } from './providers.js';
import { CoreError, coreErrorCode, provenCoreRejection } from './provider-core.js';

const FORMAT = 'nootify-config';
const EXPORTS_KEPT = 10;
const BACKEND_PROTOCOLS: Record<'codex' | 'opencode', string[]> = { codex: ['ws:', 'wss:'], opencode: ['http:', 'https:'] };
const packageFile = new URL('../../package.json', import.meta.url);
/** Reject malformed application IDs before verifying or saving credentials. */
const isAppId = (value: unknown): value is string => typeof value === 'string' && /^cli_[0-9a-fA-F]{16}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const rejected = (error: unknown): boolean => provenCoreRejection(error) || error instanceof HttpError && !coreErrorCode(error)
  && [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(error.status);

/** Public Settings data; secrets are retrieved separately by an explicit local-only action. */
export interface SettingsPage {
  version: string;
  exports_dir: string;
  last_export?: string;
  lark: { status: string; configured: boolean; connection_type: LarkConnectionType; source?: CredentialSource; app_id?: string; saved: boolean; recipient?: string; groups: number; mirror_status?: 'pending' };
}
export interface LarkRecipientsPage extends Omit<LarkDirectory, 'permission'> { permission?: LarkPermissionHelp; cached?: boolean; fetched_at?: number; refresh_after?: number; expires_at?: number }
export interface GitHubSettings { account?: GitHubAccount; login: GitHubLogin }
/** What a configuration file changes, in terms safe to show before and after importing it. */
export interface ImportSummary {
  exported_at?: string; app_id?: string; recipient?: string; pulls_config: boolean; follow?: number; backends: string[]; agents: AgentId[];
  warnings: string[];
  provider_count?: number;
}
/** The exported file. It holds secrets, so it is only ever written to disk, never returned over HTTP. */
interface ConfigFile {
  format: typeof FORMAT; version: 1; exported_at: string;
  lark?: { app_id?: string; app_secret?: string; recipient_open_id?: string; connection_type?: LarkConnectionType };
  pulls?: { config?: unknown; follow?: { repository: string; follow: boolean }[] };
  backends?: Partial<Record<'codex' | 'opencode', BackendConnection>>;
  agents?: AgentId[];
  providers?: Record<string, unknown>;
}
export interface LarkControl {
  credentials?: Credentials;
  api?: LarkApi;
  status(): string;
  channel(): { recipient?: string; groups: number };
  configure(credentials?: Credentials): Promise<void>;
  refreshCompatibilityCredentials?(credentials?: Credentials): void;
  setCompatibilitySync?(sync: CompatibilitySync): void;
  setRecipient?(openId: string): Promise<void>;
  setRecipientSync?(sync: (openId: string) => Promise<void>): void;
}
export interface PullPreferences {
  preferences(): Promise<{ config?: unknown; follow: { repository: string; follow: boolean }[] }>;
  restore(preferences: { config?: unknown; follow?: { repository: string; follow: boolean }[] }): Promise<void>;
}
export interface AgentControl { list(): Promise<AgentPrompt[]>; set(agent: AgentId, enabled: boolean): Promise<AgentPrompt> }
export interface SettingsOptions {
  state: State; lark: LarkControl; github: GitHubAuth; pulls: PullPreferences; agents: AgentControl;
  tailscale?: TailscaleService;
  providers?: Pick<ProvidersService, 'exportConfig' | 'importConfig' | 'syncNetwork'>;
  mcpConfig?: string; source?: CredentialSource; env?: NodeJS.ProcessEnv;
  verify?: (credentials: Credentials) => Promise<void>;
  registration?: LarkRegistrationOptions;
  reveal?: (path: string) => Promise<void>;
  report?: (record: Record<string, unknown>) => void;
}

function backend(value: unknown, adapter: 'codex' | 'opencode'): BackendConnection {
  if (!isObject(value) || typeof value.url !== 'string') throw new HttpError(400, `Invalid ${adapter} backend`);
  const connection: BackendConnection = { url: value.url };
  for (const field of ['token', 'username', 'password', 'directory'] as const) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'string') throw new HttpError(400, `Invalid ${adapter} backend ${field}`);
    connection[field] = value[field];
  }
  try { localEndpoint(connection, BACKEND_PROTOCOLS[adapter]); } catch (error) { throw new HttpError(400, `${adapter}: ${(error as Error).message}`); }
  return connection;
}
/** Every value is checked before anything is applied, so a bad file changes nothing. */
function parseConfig(value: unknown): ConfigFile {
  if (!isObject(value) || value.format !== FORMAT) throw new HttpError(400, 'Not a Nootify configuration file');
  if (value.version !== 1) throw new HttpError(400, 'This configuration file comes from a newer version of Nootify');
  const result: ConfigFile = { format: FORMAT, version: 1, exported_at: typeof value.exported_at === 'string' ? value.exported_at : '' };
  if (value.lark !== undefined) {
    if (!isObject(value.lark)) throw new HttpError(400, 'Invalid lark section');
    const { app_id, app_secret, recipient_open_id, connection_type } = value.lark;
    if ((app_id === undefined) !== (app_secret === undefined)) throw new HttpError(400, 'app_id and app_secret must appear together');
    if (app_id !== undefined && (!isAppId(app_id) || typeof app_secret !== 'string' || !app_secret)) throw new HttpError(400, 'Invalid Feishu app credentials');
    if (recipient_open_id !== undefined && !isOpenId(recipient_open_id)) throw new HttpError(400, 'Invalid Feishu recipient');
    if (connection_type !== undefined && (!isLarkConnectionType(connection_type) || app_id === undefined)) throw new HttpError(400, 'Invalid Feishu connection type or missing app credentials');
    result.lark = { ...(app_id !== undefined ? { app_id: app_id as string, app_secret: app_secret as string, ...(isLarkConnectionType(connection_type) ? { connection_type } : {}) } : {}), ...(recipient_open_id !== undefined ? { recipient_open_id } : {}) };
  }
  if (value.pulls !== undefined) {
    if (!isObject(value.pulls)) throw new HttpError(400, 'Invalid pulls section');
    result.pulls = {};
    if (value.pulls.config !== undefined) {
      try { parsePullConfig(value.pulls.config); } catch (error) { throw new HttpError(400, (error as Error).message); }
      result.pulls.config = value.pulls.config;
    }
    if (value.pulls.follow !== undefined) {
      const follow = value.pulls.follow;
      if (!Array.isArray(follow) || !follow.every(choice => isObject(choice) && typeof choice.repository === 'string' && parseGitHubRemote(`https://github.com/${choice.repository}`) === choice.repository && typeof choice.follow === 'boolean')) {
        throw new HttpError(400, 'Invalid repository follow choices');
      }
      result.pulls.follow = follow.map(({ repository, follow: followed }) => ({ repository, follow: followed }));
    }
  }
  if (value.backends !== undefined) {
    if (!isObject(value.backends)) throw new HttpError(400, 'Invalid backends section');
    result.backends = {};
    for (const adapter of ['codex', 'opencode'] as const) {
      if (value.backends[adapter] !== undefined) result.backends[adapter] = backend(value.backends[adapter], adapter);
    }
  }
  if (value.providers !== undefined) {
    const core = value.providers;
    if (!isObject(core) || core.version !== 1 || !Array.isArray(core.providers)
      || core.providers.some(provider => !isObject(provider) || !['feishu', 'remote'].includes(String(provider.type))
        || typeof provider.id !== 'string' || typeof provider.name !== 'string')
      || (core.remote !== undefined && !isObject(core.remote))) throw new HttpError(400, 'Invalid providers configuration');
    result.providers = core;
  }
  if (value.agents !== undefined) {
    if (!Array.isArray(value.agents) || !value.agents.every(isAgent)) throw new HttpError(400, 'Invalid agents section');
    result.agents = AGENT_IDS.filter(agent => (value.agents as AgentId[]).includes(agent));
  }
  return result;
}
function summarize(file: ConfigFile): ImportSummary {
  return { ...(file.exported_at ? { exported_at: file.exported_at } : {}), ...(file.lark?.app_id ? { app_id: file.lark.app_id } : {}),
    ...(file.lark?.recipient_open_id ? { recipient: file.lark.recipient_open_id } : {}), pulls_config: file.pulls?.config !== undefined,
    ...(file.pulls?.follow ? { follow: file.pulls.follow.length } : {}), backends: Object.keys(file.backends ?? {}), agents: file.agents ?? [], warnings: [],
    ...(file.providers ? { provider_count: (file.providers.providers as unknown[]).length } : {}) };
}

/** Owner settings behind the Settings pages. Page callers are limited to this Mac by the UI layer. */
export class SettingsService {
  private source?: CredentialSource;
  private lastExport?: string;
  private readonly directoryStore: LarkDirectoryCache;
  private directoryRefresh = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly env: NodeJS.ProcessEnv;
  private readonly report: (record: Record<string, unknown>) => void;
  private readonly registration: LarkRegistration;
  private mirrorPending = false;
  private mirrorRetry?: NodeJS.Timeout;
  private stopping = false;
  constructor(private readonly options: SettingsOptions) {
    this.source = options.source; this.env = options.env ?? process.env; this.report = options.report ?? (() => {});
    this.registration = new LarkRegistration((result, signal) => this.acceptLarkRegistration(result, signal), this.report, options.registration);
    this.directoryStore = new LarkDirectoryCache(options.state.directory);
    options.lark.setCompatibilitySync?.((update, preview) => this.syncProviderCompatibility(update, preview));
    options.lark.setRecipientSync?.(openId => this.setRecipient(openId));
  }
  /** Mirror the core's committed legacy provider without saving it again through the compatibility configure path. */
  private syncProviderCompatibility(update: () => Promise<CompatibilityConfig>, preview?: () => Promise<CompatibilityConfig>): Promise<void> {
    return this.serialized(async () => {
      const { lark, state } = this.options;
      const environment = await resolveCredentials(this.env, {});
      if (preview && environment?.source === 'environment') {
        const candidate = (await preview()).credentials;
        if (candidate?.appId !== environment.credentials.appId || candidate?.appSecret !== environment.credentials.appSecret) {
          throw new HttpError(409, 'Provider changes conflict with the active environment Feishu credentials');
        }
      }
      const current = lark.credentials;
      const { credentials, recipient } = await update();
      let failed = false;
      try {
        // The core already committed. Keep its mirror authoritative in memory even if this disk write fails.
        await state.save({ apply: () => {
          this.scopeLarkBindings(credentials?.appId);
          if (credentials) {
            if (state.settings.lark_app_id !== credentials.appId) state.settings.lark_connection_type = 'bot';
            state.settings.lark_app_id = credentials.appId; state.settings.lark_app_secret = credentials.appSecret;
          } else {
            delete state.settings.lark_app_id; delete state.settings.lark_app_secret; delete state.settings.lark_connection_type;
          }
          if (recipient) state.settings.lark_recipient_open_id = recipient; else delete state.settings.lark_recipient_open_id;
        }, rollback: () => {} });
        this.mirrorPending = false; clearTimeout(this.mirrorRetry); this.mirrorRetry = undefined;
      } catch { failed = true; this.mirrorPending = true; this.scheduleMirrorRetry(); }
      const fromEnvironment = environment?.source === 'environment' && environment.credentials.appId === credentials?.appId
        && environment.credentials.appSecret === credentials?.appSecret;
      this.source = credentials ? fromEnvironment ? 'environment' : 'settings' : undefined;
      lark.refreshCompatibilityCredentials?.(credentials);
      if (current?.appId !== credentials?.appId || current?.appSecret !== credentials?.appSecret) {
        this.directoryRefresh++; await this.directoryStore.clear();
      }
      if (failed) throw this.mirrorError();
    });
  }
  private mirrorError(): HttpError {
    const error = new HttpError(409, 'Provider change committed; saving its local compatibility mirror is pending');
    error.cause = new CoreError('committed_not_mirrored', error.message); return error;
  }
  private scheduleMirrorRetry(): void {
    this.report({ source: 'providers', status: 'compatibility_mirror_pending' });
    if (!this.stopping && !this.mirrorRetry) this.mirrorRetry = setTimeout(() => {
      this.mirrorRetry = undefined; void this.serialized(async () => {}).catch(() => {});
    }, 1000).unref();
  }
  private async repairMirror(): Promise<void> {
    if (!this.mirrorPending) return;
    try { await this.options.state.save(); }
    catch { this.scheduleMirrorRetry(); throw this.mirrorError(); }
    this.mirrorPending = false; clearTimeout(this.mirrorRetry); this.mirrorRetry = undefined;
  }
  private get exportsDir(): string { return join(this.options.state.directory, 'exports'); }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.catch(() => {}).then(async () => { await this.repairMirror(); return operation(); });
    this.writes = pending;
    return pending;
  }
  /** Apply local configuration only when its State write starts; failed writes cannot leak into another queued snapshot. */
  private async persistSettings(change: () => void): Promise<() => void> {
    const { state } = this.options;
    let before: typeof state.settings | undefined; let applied: typeof state.settings | undefined;
    let beforeBackends: typeof state.backends = new Map(); let appliedBackends: typeof state.backends = new Map();
    let owners: { binding: LarkBinding; before?: string; applied?: string }[] = [];
    const rollback = () => {
      if (!before || !applied) return;
      const keys = new Set([...Object.keys(before), ...Object.keys(applied)] as (keyof typeof state.settings)[]);
      for (const key of keys) {
        // Preserve an unrelated writer's newer value while reverting this transaction's changes.
        if (before[key] === applied[key] || state.settings[key] !== applied[key]) continue;
        if (before[key] === undefined) delete state.settings[key];
        else Object.assign(state.settings, { [key]: before[key] });
      }
      for (const adapter of new Set([...beforeBackends.keys(), ...appliedBackends.keys()])) {
        if (beforeBackends.get(adapter) === appliedBackends.get(adapter) || state.backends.get(adapter) !== appliedBackends.get(adapter)) continue;
        const previous = beforeBackends.get(adapter);
        if (previous) state.backends.set(adapter, previous); else state.backends.delete(adapter);
      }
      for (const owner of owners) {
        if (owner.before === owner.applied || owner.binding.app_id !== owner.applied) continue;
        if (owner.before === undefined) delete owner.binding.app_id; else owner.binding.app_id = owner.before;
      }
    };
    await state.save({
      apply: () => {
        before = { ...state.settings }; beforeBackends = new Map(state.backends);
        owners = [...state.bindings.values()].map(binding => ({ binding, before: binding.app_id }));
        try { change(); }
        finally {
          applied = { ...state.settings }; appliedBackends = new Map(state.backends);
          for (const owner of owners) owner.applied = owner.binding.app_id;
        }
      }, rollback,
    });
    return rollback;
  }
  private larkConnectionType(): LarkConnectionType {
    return this.source === 'settings' ? this.options.state.settings.lark_connection_type ?? 'bot' : 'bot';
  }
  async page(): Promise<SettingsPage> {
    const { lark, state } = this.options;
    const { version } = JSON.parse(await readFile(packageFile, 'utf8')) as { version: string };
    const channel = lark.channel();
    const configured = Boolean(lark.credentials?.appId.trim() && lark.credentials?.appSecret.trim());
    return { version, exports_dir: this.exportsDir, ...(this.lastExport ? { last_export: this.lastExport } : {}),
      lark: { status: configured ? lark.status() : 'disabled', configured, connection_type: this.larkConnectionType(), source: this.source, app_id: lark.credentials?.appId, saved: Boolean(state.settings.lark_app_id && state.settings.lark_app_secret),
        recipient: channel.recipient ?? state.settings.lark_recipient_open_id, groups: channel.groups, ...(this.mirrorPending ? { mirror_status: 'pending' as const } : {}) } };
  }
  /** Asking GitHub costs a network round trip, so polling during a login reads only the flow. */
  async github(): Promise<GitHubSettings> {
    const { github } = this.options;
    const login = github.login();
    if (login.status === 'starting' || login.status === 'waiting') return { login };
    return { account: await github.account(), login };
  }
  startGitHubLogin(): GitHubLogin { return this.options.github.start(); }
  cancelGitHubLogin(): GitHubLogin { return this.options.github.cancel(); }
  signOutGitHub(): Promise<void> { return this.options.github.signOut(); }
  async tailscale(): Promise<TailscalePage> {
    if (!this.options.tailscale) throw new HttpError(404, 'Tailscale settings are not enabled');
    return this.options.tailscale.page();
  }
  async setTailscaleEnabled(enabled: unknown): Promise<void> {
    if (!this.options.tailscale) throw new HttpError(404, 'Tailscale settings are not enabled');
    await this.options.tailscale.setEnabled(enabled);
    await this.options.providers?.syncNetwork();
  }
  startTailscaleLogin(): Promise<TailscaleLogin> {
    if (!this.options.tailscale) throw new HttpError(404, 'Tailscale settings are not enabled');
    return this.options.tailscale.startLogin().then(async result => { await this.options.providers?.syncNetwork(); return result; });
  }
  async cancelTailscaleLogin(): Promise<void> { await this.options.tailscale?.cancelLogin(); await this.options.providers?.syncNetwork(); }
  async logoutTailscale(): Promise<void> {
    if (!this.options.tailscale) throw new HttpError(404, 'Tailscale settings are not enabled');
    await this.options.tailscale.logout();
    await this.options.providers?.syncNetwork();
  }
  async stop(): Promise<void> {
    this.stopping = true; clearTimeout(this.mirrorRetry);
    await this.registration.stop(); await this.options.github.stop(); await this.writes.catch(() => {});
    await this.repairMirror().catch(() => {});
  }

  larkRegistration(): LarkRegistrationPage { return this.registration.page(); }
  startLarkRegistration(): LarkRegistrationPage {
    if (this.env.LARK_APP_ID || this.env.LARK_APP_SECRET) throw new HttpError(409, 'LARK_APP_ID and LARK_APP_SECRET are set for this process and take precedence');
    return this.registration.start();
  }
  cancelLarkRegistration(): LarkRegistrationPage { return this.registration.cancel(); }
  async larkSetup(appId?: unknown, signal?: AbortSignal): Promise<LarkSetup> {
    const { lark } = this.options; const api = lark.api;
    if (!api || api.appId !== lark.credentials?.appId) throw new HttpError(409, 'Configure the Feishu application first');
    if (appId !== undefined && appId !== api.appId) throw new HttpError(409, 'Feishu credentials changed; check permissions again');
    const setup = await inspectLarkSetup(api, signal);
    if (api !== lark.api) throw new HttpError(409, 'Feishu credentials changed; check permissions again');
    return setup;
  }
  /** Persist legacy group ownership in the same snapshot as an application change. */
  private scopeLarkBindings(nextAppId?: string): void {
    const previousApp = this.options.lark.credentials?.appId;
    if (!previousApp || previousApp === nextAppId) return;
    for (const binding of this.options.state.bindings.values()) if (!binding.app_id) binding.app_id = previousApp;
  }
  private acceptLarkRegistration(result: LarkRegistrationResult, signal: AbortSignal): Promise<LarkSetup> {
    return this.serialized(async () => {
      signal.throwIfAborted();
      if (this.env.LARK_APP_ID || this.env.LARK_APP_SECRET) throw new HttpError(409, 'Environment credentials take precedence');
      await (this.options.verify ?? verifyCredentials)(result.credentials);
      signal.throwIfAborted();
      const { state, lark } = this.options;
      const rollback = await this.persistSettings(() => {
        signal.throwIfAborted();
        // An open_id belongs to an app. Never carry an old app's trusted recipient into the new one.
        this.scopeLarkBindings(result.credentials.appId);
        if (lark.credentials?.appId !== result.credentials.appId) delete state.settings.lark_recipient_open_id;
        state.settings.lark_app_id = result.credentials.appId;
        state.settings.lark_app_secret = result.credentials.appSecret;
        state.settings.lark_connection_type = 'personal-app';
        if (result.recipient) state.settings.lark_recipient_open_id = result.recipient;
      });
      await this.reloadSettings(rollback, true);
      return this.larkSetup(result.credentials.appId, signal);
    });
  }

  private async reloadSettings(rollback: () => void, forceReconnect = false, recipient?: string): Promise<void> {
    const current = this.options.lark.credentials;
    try {
      await this.reload(forceReconnect);
      if (recipient && this.options.lark.credentials) await this.options.lark.setRecipient?.(recipient);
    } catch (error) {
      if (rejected(error)) await this.persistSettings(rollback);
      else if (coreErrorCode(error) === 'committed_not_durable') {
        const resolved = await resolveCredentials(this.env, this.options.state.settings, this.options.mcpConfig);
        this.options.lark.refreshCompatibilityCredentials?.(resolved?.credentials); this.source = resolved?.source;
        if (current?.appId !== resolved?.credentials.appId || current?.appSecret !== resolved?.credentials.appSecret) {
          this.directoryRefresh++; await this.directoryStore.clear();
        }
      }
      throw error;
    }
  }
  /** Re-derives the active bot from its sources and moves the connection only if that changed it. */
  private async reload(forceReconnect = false, preserveProviders = false): Promise<void> {
    const { lark, state, mcpConfig } = this.options;
    const resolved = await resolveCredentials(this.env, state.settings, mcpConfig);
    const current = lark.credentials;
    if (!forceReconnect && current?.appId === resolved?.credentials.appId && current?.appSecret === resolved?.credentials.appSecret) { this.source = resolved?.source; return; }
    if (preserveProviders && lark.refreshCompatibilityCredentials) lark.refreshCompatibilityCredentials(resolved?.credentials);
    else await lark.configure(resolved?.credentials);
    this.source = resolved?.source;
    if (current?.appId !== resolved?.credentials.appId || current?.appSecret !== resolved?.credentials.appSecret) { this.directoryRefresh++; await this.directoryStore.clear(); }
    this.report({ source: 'lark', status: 'lark_configured', reason: resolved ? resolved.credentials.appId : undefined });
  }
  /** Used only by the eye button's same-origin, loopback-only POST action. */
  larkSecret(): { app_id?: string; app_secret?: string } {
    const credentials = this.options.lark.credentials;
    if (!credentials?.appId.trim() || !credentials.appSecret.trim()) return {};
    return { app_id: credentials.appId, app_secret: credentials.appSecret };
  }
  saveLark(appId: unknown, appSecret: unknown, connectionType?: unknown): Promise<void> {
    this.registration.cancel();
    return this.serialized(async () => {
      if (this.env.LARK_APP_ID || this.env.LARK_APP_SECRET) throw new HttpError(409, 'LARK_APP_ID and LARK_APP_SECRET are set for this process and take precedence');
      if (connectionType !== undefined && !isLarkConnectionType(connectionType)) throw new HttpError(400, 'Expected bot or personal-app connection type');
      const { state, lark } = this.options;
      if (!isAppId(appId)) throw new HttpError(400, 'Expected a Feishu App ID (cli_ and 16 hexadecimal digits)');
      // A masked secret retains the active application's value, including credentials from the MCP file.
      const retained = appId === lark.credentials?.appId ? lark.credentials.appSecret
        : appId === state.settings.lark_app_id ? state.settings.lark_app_secret : undefined;
      const secret = appSecret === '' || appSecret === undefined ? retained : appSecret;
      if (typeof secret !== 'string' || !secret.trim()) throw new HttpError(400, 'Enter the App Secret');
      const credentials = { appId, appSecret: secret.trim() };
      try { await (this.options.verify ?? verifyCredentials)(credentials); }
      catch (error) { throw new HttpError(400, `Could not verify these credentials with Feishu: ${(error as Error).message}`); }
      const rollback = await this.persistSettings(() => {
        this.scopeLarkBindings(credentials.appId);
        if (lark.credentials?.appId !== credentials.appId) delete state.settings.lark_recipient_open_id;
        state.settings.lark_connection_type = connectionType ?? (state.settings.lark_app_id === credentials.appId ? state.settings.lark_connection_type ?? 'bot' : 'bot');
        state.settings.lark_app_id = credentials.appId; state.settings.lark_app_secret = credentials.appSecret;
      });
      await this.reloadSettings(rollback, true);
    });
  }
  /** Falls back to the MCP file, if any, and refuses rather than leaving saved credentials half removed if it is unreadable. */
  clearLark(): Promise<void> {
    this.registration.cancel();
    return this.serialized(async () => {
      const { state, mcpConfig } = this.options;
      const { lark_app_id: _id, lark_app_secret: _secret, ...rest } = state.settings;
      const fallback = await resolveCredentials(this.env, rest, mcpConfig);
      const rollback = await this.persistSettings(() => {
        this.scopeLarkBindings(fallback?.credentials.appId);
        if (fallback?.credentials.appId !== this.options.lark.credentials?.appId) delete state.settings.lark_recipient_open_id;
        delete state.settings.lark_app_id; delete state.settings.lark_app_secret; delete state.settings.lark_connection_type;
      });
      await this.reloadSettings(rollback);
    });
  }
  async larkRecipients(onProgress?: (page: LarkRecipientsPage) => void, signal?: AbortSignal, refresh = false): Promise<LarkRecipientsPage> {
    const { lark } = this.options;
    const api = lark.api; const credentials = lark.credentials;
    if (!api || !credentials?.appSecret || api.appId !== credentials.appId) throw new HttpError(409, 'Configure the Feishu application first');
    const current = () => api === lark.api && credentials === lark.credentials;
    if (signal?.aborted) throw new HttpError(499, 'Directory request cancelled');
    const cached = await this.directoryStore.read(credentials);
    const checkCurrent = () => {
      if (!current()) throw new HttpError(409, 'Feishu credentials changed; reload the directory');
      if (signal?.aborted) throw new HttpError(499, 'Directory request cancelled');
    };
    checkCurrent();
    let updates = Promise.resolve();
    const helps = new Map<string, Promise<LarkPermissionHelp>>();
    const decorate = async (directory: LarkDirectory): Promise<LarkRecipientsPage> => {
      const { permission, ...page } = directory;
      if (!permission && !directory.permission_limited) return page;
      const key = JSON.stringify(permission ?? null);
      let help = helps.get(key); if (!help) { help = larkPermissionHelp(api.appId, permission); helps.set(key, help); }
      return { ...page, permission: await help };
    };
    if (cached) {
      const page = { ...await decorate(cached.directory), cached: true, fetched_at: cached.at, refresh_after: cached.directory.truncated ? 0 : cached.at + DIRECTORY_FRESH_MS, expires_at: cached.at + DIRECTORY_MAX_AGE_MS }; checkCurrent();
      onProgress?.(page);
      if (!refresh && !cached.directory.truncated && Date.now() - cached.at < DIRECTORY_FRESH_MS) return page;
    }
    const fetchId = ++this.directoryRefresh;
    try {
      const directory = await larkDirectory(api, signal, onProgress ? page => {
        updates = updates.then(async () => {
          if (!current() || signal?.aborted) return;
          const next = await decorate(page);
          if (current() && !signal?.aborted) onProgress({ ...next, ...(cached ? { users: mergeRecipients(cached.directory.users, next.users), cached: true, fetched_at: cached.at, refresh_after: cached.directory.truncated ? 0 : cached.at + DIRECTORY_FRESH_MS, expires_at: cached.at + DIRECTORY_MAX_AGE_MS } : {}) });
        }).catch(() => {});
      } : undefined);
      await updates;
      if (!current()) throw new HttpError(409, 'Feishu credentials changed; reload the directory');
      if (signal?.aborted) throw new HttpError(499, 'Directory request cancelled');
      const keptCache = !!cached && directory.truncated && !directory.permission_limited;
      const snapshot = keptCache ? { ...directory, users: mergeRecipients(cached.directory.users, directory.users) } : directory;
      const at = keptCache ? cached.at : Date.now();
      const page = { ...await decorate(snapshot), cached: keptCache, fetched_at: at, refresh_after: snapshot.truncated ? 0 : at + DIRECTORY_FRESH_MS, expires_at: at + DIRECTORY_MAX_AGE_MS };
      checkCurrent();
      if (fetchId === this.directoryRefresh) await this.directoryStore.write(credentials, snapshot, at);
      checkCurrent();
      return page;
    } catch (error) {
      await updates;
      checkCurrent();
      if (error instanceof LarkDirectoryPermissionError) {
        if (fetchId === this.directoryRefresh) await this.directoryStore.clear();
        throw new LarkPermissionRequiredError(await larkPermissionHelp(api.appId, error.permission));
      }
      throw error;
    }
  }
  setRecipient(openId: unknown, appId?: unknown): Promise<void> {
    return this.serialized(async () => {
      if (appId !== undefined && appId !== this.options.lark.credentials?.appId) throw new HttpError(409, 'Feishu credentials changed; reload the directory');
      if (!isOpenId(openId)) throw new HttpError(400, 'Expected a Feishu open_id (ou_…)');
      const { state, lark } = this.options;
      const rollback = await this.persistSettings(() => { state.settings.lark_recipient_open_id = openId; });
      try { await lark.setRecipient?.(openId); }
      catch (error) { if (rejected(error)) await this.persistSettings(rollback); throw error; }
    });
  }

  private async configFile(): Promise<ConfigFile> {
    const { lark, state, pulls, agents } = this.options;
    const credentials = lark.credentials;
    const recipient = lark.channel().recipient ?? state.settings.lark_recipient_open_id;
    const backends = Object.fromEntries((['codex', 'opencode'] as const).flatMap(adapter => {
      const connection = state.backends.get(adapter);
      return connection ? [[adapter, connection]] : [];
    }));
    return { format: FORMAT, version: 1, exported_at: new Date().toISOString(),
      lark: { ...(credentials ? { app_id: credentials.appId, app_secret: credentials.appSecret, connection_type: this.larkConnectionType() } : {}), ...(recipient ? { recipient_open_id: recipient } : {}) },
      pulls: await pulls.preferences(), backends, agents: (await agents.list()).filter(agent => agent.injected).map(agent => agent.agent),
      ...(this.options.providers ? { providers: await this.options.providers.exportConfig() } : {}) };
  }
  /** Returns only where the file went: the page has no bearer token, so secrets never travel over its HTTP routes. */
  exportConfig(): Promise<{ path: string; summary: ImportSummary }> {
    return this.serialized(async () => {
      const file = await this.configFile();
      const directory = this.exportsDir;
      await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
      const path = join(directory, `nootify-config-${file.exported_at.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
      await writeFile(path, JSON.stringify(file, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      const old = (await readdir(directory)).filter(name => name.startsWith('nootify-config-')).sort().slice(0, -EXPORTS_KEPT);
      await Promise.all(old.map(name => rm(join(directory, name), { force: true })));
      this.lastExport = path;
      this.report({ source: 'host', status: 'config_exported' });
      return { path, summary: summarize(file) };
    });
  }
  async previewImport(value: unknown): Promise<ImportSummary> { return summarize(parseConfig(value)); }
  /** Replaces the settings the file names and leaves everything else. Agents in the file are enabled; none are removed. */
  importConfig(value: unknown): Promise<ImportSummary> {
    this.registration.cancel();
    return this.serialized(async () => {
      const file = parseConfig(value);
      const { state, pulls, agents, lark } = this.options;
      const summary = summarize(file);
      if (file.providers && !this.options.providers) throw new HttpError(400, 'Provider configuration is not supported by this service');
      const legacy = (file.providers?.providers as Record<string, unknown>[] | undefined)?.find(provider => provider.id === 'legacy-feishu' && provider.type === 'feishu');
      const imported = legacy && typeof legacy.app_id === 'string' && typeof legacy.app_secret === 'string'
        ? { appId: legacy.app_id, appSecret: legacy.app_secret } : undefined;
      const proposed = { ...state.settings };
      if (file.providers) {
        delete proposed.lark_app_id; delete proposed.lark_app_secret;
        if (imported) { proposed.lark_app_id = imported.appId; proposed.lark_app_secret = imported.appSecret; }
      } else if (file.lark?.app_id) { proposed.lark_app_id = file.lark.app_id; proposed.lark_app_secret = file.lark.app_secret; }
      // Resolve before changing either store. Environment precedence cannot leave the core and compatibility API using different apps.
      const effective = await resolveCredentials(this.env, proposed, this.options.mcpConfig);
      if (file.providers && effective?.source === 'environment' && (!imported || imported.appId !== effective.credentials.appId || imported.appSecret !== effective.credentials.appSecret)) {
        throw new HttpError(409, 'Imported providers conflict with the active environment Feishu credentials; preserve the environment provider');
      }
      const previous = lark.credentials;
      const refreshImported = async (allowConfigure = true) => {
        if (lark.refreshCompatibilityCredentials) lark.refreshCompatibilityCredentials(imported);
        else if (allowConfigure && (previous?.appId !== imported?.appId || previous?.appSecret !== imported?.appSecret)) await lark.configure(imported);
        this.source = imported ? effective?.source ?? 'settings' : undefined;
        if (previous?.appId !== imported?.appId || previous?.appSecret !== imported?.appSecret) { this.directoryRefresh++; await this.directoryStore.clear(); }
      };
      const rollback = await this.persistSettings(() => {
        if (file.providers) {
          this.scopeLarkBindings(imported?.appId);
          if (imported) {
            state.settings.lark_app_id = imported.appId; state.settings.lark_app_secret = imported.appSecret;
            state.settings.lark_connection_type = file.lark?.app_id === imported.appId ? file.lark.connection_type ?? 'bot' : 'bot';
          } else { delete state.settings.lark_app_id; delete state.settings.lark_app_secret; delete state.settings.lark_connection_type; }
          const recipient = typeof legacy?.recipient_open_id === 'string' ? legacy.recipient_open_id : undefined;
          if (recipient) state.settings.lark_recipient_open_id = recipient; else delete state.settings.lark_recipient_open_id;
        } else {
          if (file.lark?.app_id) {
            const nextAppId = effective?.credentials.appId;
            this.scopeLarkBindings(nextAppId);
            if (nextAppId !== lark.credentials?.appId) delete state.settings.lark_recipient_open_id;
            state.settings.lark_app_id = file.lark.app_id; state.settings.lark_app_secret = file.lark.app_secret;
            state.settings.lark_connection_type = file.lark.connection_type ?? 'bot';
          }
          if (file.lark?.recipient_open_id) state.settings.lark_recipient_open_id = file.lark.recipient_open_id;
        }
        for (const adapter of ['codex', 'opencode'] as const) {
          const connection = file.backends?.[adapter];
          if (connection) state.backends.set(adapter, connection);
        }
      });
      if (file.providers) {
        try { await this.options.providers!.importConfig(file.providers); }
        catch (error) {
          if (rejected(error)) await this.persistSettings(rollback);
          else if (coreErrorCode(error) === 'committed_not_durable') await refreshImported(false);
          throw error;
        }
        await refreshImported();
      } else await this.reloadSettings(rollback, false, file.lark?.recipient_open_id);
      if (file.pulls) await pulls.restore(file.pulls);
      for (const agent of file.agents ?? []) {
        try { await agents.set(agent, true); } catch (error) { summary.warnings.push(`${agent}: ${(error as Error).message}`); }
      }
      if (file.lark?.app_id && this.source === 'environment') summary.warnings.push('LARK_APP_ID and LARK_APP_SECRET are set for this process and stay in use');
      this.report({ source: 'host', status: 'config_imported' });
      return summary;
    });
  }
  /** Shows only a path this service chose: the latest export, or else their folder. */
  async reveal(): Promise<void> {
    const directory = this.exportsDir;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await (this.options.reveal ?? showInFinder)(this.lastExport ?? directory);
  }
}
const showInFinder = async (path: string): Promise<void> => {
  const exec = promisify(execFile);
  if (process.platform === 'win32') {
    try { await exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), ['/select,', path], { windowsHide: true }); }
    catch (error) {
      // Explorer may exit 1 after handing the selection to the existing shell.
      // Spawn failures, signals and other exit codes still indicate a failed request.
      const failure = error as ExecFileException;
      if (failure.code !== 1 || failure.killed || failure.signal) throw error;
    }
  } else if (process.platform === 'darwin') await exec('/usr/bin/open', ['-R', path]);
  else await exec('xdg-open', [(await stat(path)).isDirectory() ? path : dirname(path)]);
};
