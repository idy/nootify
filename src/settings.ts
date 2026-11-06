import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { isNotificationChannel, validChatConfig, type ChatChannel, type ChatSettingsPage, type NotificationChannel, type SlackConfig, type TelegramConfig, type ChatDirectory, ChatTransportError } from './chat-transport.js';
import type { ChatService } from './chat-service.js';
import { larkDirectory, LarkDirectoryPermissionError, type LarkDirectory } from './lark-directory.js';
import { larkPermissionHelp, LarkPermissionRequiredError, type LarkPermissionHelp } from './lark-permissions.js';
import type { LarkApi } from './lark-metadata.js';
import { slackDirectory } from './slack.js';
import { telegramDirectory } from './telegram.js';
import { inspectLarkSetup, LarkRegistration, type LarkRegistrationOptions, type LarkRegistrationPage, type LarkRegistrationResult, type LarkSetup } from './lark-registration.js';
import { DIRECTORY_FRESH_MS, DIRECTORY_MAX_AGE_MS, LarkDirectoryCache } from './lark-directory-cache.js';
import { mergeRecipients } from './lark-profile.js';

const FORMAT = 'nootify-config';
const EXPORTS_KEPT = 10;
const BACKEND_PROTOCOLS: Record<'codex' | 'opencode', string[]> = { codex: ['ws:', 'wss:'], opencode: ['http:', 'https:'] };
const packageFile = new URL('../../package.json', import.meta.url);
/** Reject malformed application IDs before verifying or saving credentials. */
const isAppId = (value: unknown): value is string => typeof value === 'string' && /^cli_[0-9a-fA-F]{16}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Public Settings data; secrets are retrieved separately by an explicit local-only action. */
export interface SettingsPage {
  version: string;
  exports_dir: string;
  last_export?: string;
  lark: { status: string; configured: boolean; connection_type: LarkConnectionType; source?: CredentialSource; app_id?: string; saved: boolean; recipient?: string; groups: number };
  notification_channel: NotificationChannel; slack: ChatSettingsPage; telegram: ChatSettingsPage;
}
export interface LarkRecipientsPage extends Omit<LarkDirectory, 'permission'> { permission?: LarkPermissionHelp; cached?: boolean; fetched_at?: number; refresh_after?: number; expires_at?: number }
export interface GitHubSettings { account?: GitHubAccount; login: GitHubLogin }
/** What a configuration file changes, in terms safe to show before and after importing it. */
export interface ImportSummary {
  exported_at?: string; app_id?: string; recipient?: string; pulls_config: boolean; follow?: number; backends: string[]; agents: AgentId[];
  warnings: string[]; notification_channel?: NotificationChannel; slack?: { chat_id: string; user_id: string }; telegram?: { chat_id: string; user_id: string };
}
/** The exported file. It holds secrets, so it is only ever written to disk, never returned over HTTP. */
interface ConfigFile {
  format: typeof FORMAT; version: 1; exported_at: string;
  lark?: { app_id?: string; app_secret?: string; recipient_open_id?: string; connection_type?: LarkConnectionType };
  notification_channel?: NotificationChannel; slack?: SlackConfig; telegram?: TelegramConfig;
  pulls?: { config?: unknown; follow?: { repository: string; follow: boolean }[] };
  backends?: Partial<Record<'codex' | 'opencode', BackendConnection>>;
  agents?: AgentId[];
}
export interface LarkControl {
  credentials?: Credentials;
  api?: LarkApi;
  status(): string;
  channel(): { recipient?: string; groups: number };
  configure(credentials?: Credentials): Promise<void>;
}
export interface PullPreferences {
  preferences(): Promise<{ config?: unknown; follow: { repository: string; follow: boolean }[] }>;
  restore(preferences: { config?: unknown; follow?: { repository: string; follow: boolean }[] }): Promise<void>;
}
export interface AgentControl { list(): Promise<AgentPrompt[]>; set(agent: AgentId, enabled: boolean): Promise<AgentPrompt> }
export interface SettingsOptions {
  state: State; lark: LarkControl; github: GitHubAuth; pulls: PullPreferences; agents: AgentControl;
  tailscale?: TailscaleService;
  slack?: Pick<ChatService<'slack'>, 'page' | 'configure'> & { directoryTargets?(): ChatDirectory };
  telegram?: Pick<ChatService<'telegram'>, 'page' | 'configure'> & { directoryTargets?(): ChatDirectory };
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
  if (value.notification_channel !== undefined) {
    if (!isNotificationChannel(value.notification_channel)) throw new HttpError(400, 'Invalid notification channel');
    result.notification_channel = value.notification_channel;
  }
  if (value.slack !== undefined) {
    if (!validChatConfig('slack', value.slack)) throw new HttpError(400, 'Invalid Slack configuration');
    const { bot_token, app_token, channel_id, user_id } = value.slack;
    result.slack = { bot_token, app_token, channel_id, user_id };
  }
  if (value.telegram !== undefined) {
    if (!validChatConfig('telegram', value.telegram)) throw new HttpError(400, 'Invalid Telegram configuration');
    const { bot_token, chat_id, user_id } = value.telegram;
    result.telegram = { bot_token, chat_id, user_id };
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
    ...(file.notification_channel ? { notification_channel: file.notification_channel } : {}),
    ...(file.slack ? { slack: { chat_id: file.slack.channel_id, user_id: file.slack.user_id } } : {}),
    ...(file.telegram ? { telegram: { chat_id: file.telegram.chat_id, user_id: file.telegram.user_id } } : {}) };
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
  constructor(private readonly options: SettingsOptions) {
    this.source = options.source; this.env = options.env ?? process.env; this.report = options.report ?? (() => {});
    this.registration = new LarkRegistration((result, signal) => this.acceptLarkRegistration(result, signal), this.report, options.registration);
    this.directoryStore = new LarkDirectoryCache(options.state.directory);
  }
  private get exportsDir(): string { return join(this.options.state.directory, 'exports'); }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.catch(() => {}).then(operation);
    this.writes = pending;
    return pending;
  }
  /** Apply local configuration only when its State write starts; failed writes cannot leak into another queued snapshot. */
  private persistSettings(change: () => void): Promise<void> {
    const { state } = this.options;
    let before: typeof state.settings | undefined; let applied: typeof state.settings | undefined;
    let beforeBackends: typeof state.backends = new Map(); let appliedBackends: typeof state.backends = new Map();
    let owners: { binding: LarkBinding; before?: string; applied?: string }[] = [];
    return state.save({
      apply: () => {
        before = { ...state.settings }; beforeBackends = new Map(state.backends);
        owners = [...state.bindings.values()].map(binding => ({ binding, before: binding.app_id }));
        try { change(); }
        finally {
          applied = { ...state.settings }; appliedBackends = new Map(state.backends);
          for (const owner of owners) owner.applied = owner.binding.app_id;
        }
      },
      rollback: () => {
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
      },
    });
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
        recipient: channel.recipient ?? state.settings.lark_recipient_open_id, groups: channel.groups },
      notification_channel: state.settings.notification_channel ?? 'feishu',
      slack: this.chatPage('slack'), telegram: this.chatPage('telegram') };
  }
  private chatPage(channel: ChatChannel): ChatSettingsPage {
    return this.options[channel]?.page() ?? { status: 'disabled', configured: false, saved: false, threads: 0 };
  }
  saveChat(channel: ChatChannel, value: unknown): Promise<void> {
    return this.serialized(async () => {
      const service = this.options[channel];
      if (!service) throw new HttpError(404, 'Channel settings are not enabled');
      await service.configure(value);
    });
  }
  clearChat(channel: ChatChannel): Promise<void> { return this.saveChat(channel, undefined); }
  chatSecret(channel: ChatChannel, field: unknown): { secret?: string } {
    if (field !== 'bot_token' && !(channel === 'slack' && field === 'app_token')) throw new HttpError(400, 'Invalid secret field');
    const saved = this.options.state.settings[channel];
    const secret = saved && (field === 'app_token' && 'app_token' in saved ? saved.app_token : field === 'bot_token' ? saved.bot_token : undefined);
    return secret ? { secret } : {};
  }
  async chatDirectory(channel: ChatChannel, value: unknown): Promise<ChatDirectory> {
    if (!isObject(value)) throw new HttpError(400, 'Expected channel fields');
    const saved = this.options.state.settings[channel];
    const input = (name: string): string => {
      const valueForField = value[name];
      if (valueForField !== undefined && typeof valueForField !== 'string') throw new HttpError(400, 'Invalid channel field');
      const fallback = (saved as unknown as Record<string, string> | undefined)?.[name] ?? '';
      return typeof valueForField === 'string' && valueForField.trim() ? valueForField.trim() : fallback;
    };
    const bot_token = input('bot_token');
    let directory: ChatDirectory;
    try {
      directory = channel === 'slack'
        ? await slackDirectory({ bot_token, app_token: input('app_token'), channel_id: input('channel_id'), user_id: input('user_id') })
        : await telegramDirectory({ bot_token, chat_id: input('chat_id'), user_id: input('user_id') }, bot_token === saved?.bot_token ? this.options.telegram?.directoryTargets?.() : undefined);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error instanceof ChatTransportError ? error.message : 'Could not read channel recipients');
    }
    if (saved !== this.options.state.settings[channel]) throw new HttpError(409, 'Channel configuration changed; reload recipients');
    return directory;
  }
  setNotificationChannel(value: unknown): Promise<void> {
    return this.serialized(async () => {
      if (!isNotificationChannel(value)) throw new HttpError(400, 'Expected feishu, slack or telegram');
      if (value !== 'feishu' && !this.chatPage(value).configured) throw new HttpError(409, 'Configure this notification channel first');
      await this.persistSettings(() => { this.options.state.settings.notification_channel = value; });
    });
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
  }
  startTailscaleLogin(): Promise<TailscaleLogin> {
    if (!this.options.tailscale) throw new HttpError(404, 'Tailscale settings are not enabled');
    return this.options.tailscale.startLogin();
  }
  async cancelTailscaleLogin(): Promise<void> { await this.options.tailscale?.cancelLogin(); }
  async logoutTailscale(): Promise<void> {
    if (!this.options.tailscale) throw new HttpError(404, 'Tailscale settings are not enabled');
    await this.options.tailscale.logout();
  }
  async stop(): Promise<void> { await this.registration.stop(); await this.options.github.stop(); await this.writes.catch(() => {}); }

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
      await this.persistSettings(() => {
        signal.throwIfAborted();
        // An open_id belongs to an app. Never carry an old app's trusted recipient into the new one.
        this.scopeLarkBindings(result.credentials.appId);
        if (lark.credentials?.appId !== result.credentials.appId) delete state.settings.lark_recipient_open_id;
        state.settings.lark_app_id = result.credentials.appId;
        state.settings.lark_app_secret = result.credentials.appSecret;
        state.settings.lark_connection_type = 'personal-app';
        if (result.recipient) state.settings.lark_recipient_open_id = result.recipient;
      });
      await this.reload(true);
      return this.larkSetup(result.credentials.appId, signal);
    });
  }

  /** Re-derives the active bot from its sources and moves the connection only if that changed it. */
  private async reload(forceReconnect = false): Promise<void> {
    const { lark, state, mcpConfig } = this.options;
    const resolved = await resolveCredentials(this.env, state.settings, mcpConfig);
    this.source = resolved?.source;
    const current = lark.credentials;
    if (!forceReconnect && current?.appId === resolved?.credentials.appId && current?.appSecret === resolved?.credentials.appSecret) return;
    await lark.configure(resolved?.credentials);
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
      await this.persistSettings(() => {
        this.scopeLarkBindings(credentials.appId);
        if (lark.credentials?.appId !== credentials.appId) delete state.settings.lark_recipient_open_id;
        state.settings.lark_connection_type = connectionType ?? (state.settings.lark_app_id === credentials.appId ? state.settings.lark_connection_type ?? 'bot' : 'bot');
        state.settings.lark_app_id = credentials.appId; state.settings.lark_app_secret = credentials.appSecret;
      });
      await this.reload(true);
    });
  }
  /** Falls back to the MCP file, if any, and refuses rather than leaving saved credentials half removed if it is unreadable. */
  clearLark(): Promise<void> {
    this.registration.cancel();
    return this.serialized(async () => {
      const { state, mcpConfig } = this.options;
      const { lark_app_id: _id, lark_app_secret: _secret, ...rest } = state.settings;
      const fallback = await resolveCredentials(this.env, rest, mcpConfig);
      await this.persistSettings(() => {
        this.scopeLarkBindings(fallback?.credentials.appId);
        if (fallback?.credentials.appId !== this.options.lark.credentials?.appId) delete state.settings.lark_recipient_open_id;
        delete state.settings.lark_app_id; delete state.settings.lark_app_secret; delete state.settings.lark_connection_type;
      });
      await this.reload();
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
      await this.persistSettings(() => { this.options.state.settings.lark_recipient_open_id = openId; });
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
      ...(state.settings.notification_channel ? { notification_channel: state.settings.notification_channel } : {}),
      ...(state.settings.slack ? { slack: { ...state.settings.slack } } : {}), ...(state.settings.telegram ? { telegram: { ...state.settings.telegram } } : {}),
      pulls: await pulls.preferences(), backends, agents: (await agents.list()).filter(agent => agent.injected).map(agent => agent.agent) };
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
      const { state, pulls, agents } = this.options;
      const summary = summarize(file);
      for (const channel of ['slack', 'telegram'] as const) {
        if (file[channel]) {
          const service = this.options[channel];
          if (!service) throw new HttpError(404, `${channel} settings are not enabled`);
          await service.configure(file[channel]);
        }
      }
      const effective = file.lark?.app_id ? await resolveCredentials(this.env,
        { ...state.settings, lark_app_id: file.lark.app_id, lark_app_secret: file.lark.app_secret }, this.options.mcpConfig) : undefined;
      await this.persistSettings(() => {
        if (file.notification_channel) state.settings.notification_channel = file.notification_channel;
        if (file.lark?.app_id) {
          const nextAppId = effective?.credentials.appId;
          this.scopeLarkBindings(nextAppId);
          if (nextAppId !== this.options.lark.credentials?.appId) delete state.settings.lark_recipient_open_id;
          state.settings.lark_app_id = file.lark.app_id; state.settings.lark_app_secret = file.lark.app_secret;
          state.settings.lark_connection_type = file.lark.connection_type ?? 'bot';
        }
        if (file.lark?.recipient_open_id) state.settings.lark_recipient_open_id = file.lark.recipient_open_id;
        for (const adapter of ['codex', 'opencode'] as const) {
          const connection = file.backends?.[adapter];
          if (connection) state.backends.set(adapter, connection);
        }
      });
      if (file.pulls) await pulls.restore(file.pulls);
      for (const agent of file.agents ?? []) {
        try { await agents.set(agent, true); } catch (error) { summary.warnings.push(`${agent}: ${(error as Error).message}`); }
      }
      await this.reload();
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
const showInFinder = async (path: string): Promise<void> => { await promisify(execFile)('/usr/bin/open', ['-R', path]); };
