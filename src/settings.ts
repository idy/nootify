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
import type { State } from './state.js';
import { HttpError, type BackendConnection } from './types.js';
import type { TailscaleService, TailscalePage, TailscaleLogin } from './tailscale.js';

const FORMAT = 'nootify-config';
const EXPORTS_KEPT = 10;
const BACKEND_PROTOCOLS: Record<'codex' | 'opencode', string[]> = { codex: ['ws:', 'wss:'], opencode: ['http:', 'https:'] };
const packageFile = new URL('../../package.json', import.meta.url);
/** The Feishu SDK silently refuses to connect with any other shape, which would leave the bot "connecting" forever. */
const isAppId = (value: unknown): value is string => typeof value === 'string' && /^cli_[0-9a-fA-F]{16}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Everything Settings shows; secrets are write-only and never appear here. */
export interface SettingsPage {
  version: string;
  exports_dir: string;
  last_export?: string;
  lark: { status: string; source?: CredentialSource; app_id?: string; saved: boolean; recipient?: string; groups: number };
}
export interface GitHubSettings { account?: GitHubAccount; login: GitHubLogin }
/** What a configuration file changes, in terms safe to show before and after importing it. */
export interface ImportSummary {
  exported_at?: string; app_id?: string; recipient?: string; pulls_config: boolean; follow?: number; backends: string[]; agents: AgentId[];
  warnings: string[];
}
/** The exported file. It holds secrets, so it is only ever written to disk, never returned over HTTP. */
interface ConfigFile {
  format: typeof FORMAT; version: 1; exported_at: string;
  lark?: { app_id?: string; app_secret?: string; recipient_open_id?: string };
  pulls?: { config?: unknown; follow?: { repository: string; follow: boolean }[] };
  backends?: Partial<Record<'codex' | 'opencode', BackendConnection>>;
  agents?: AgentId[];
}
export interface LarkControl {
  credentials?: Credentials;
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
  mcpConfig?: string; source?: CredentialSource; env?: NodeJS.ProcessEnv;
  verify?: (credentials: Credentials) => Promise<void>;
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
    const { app_id, app_secret, recipient_open_id } = value.lark;
    if ((app_id === undefined) !== (app_secret === undefined)) throw new HttpError(400, 'app_id and app_secret must appear together');
    if (app_id !== undefined && (!isAppId(app_id) || typeof app_secret !== 'string' || !app_secret)) throw new HttpError(400, 'Invalid Feishu app credentials');
    if (recipient_open_id !== undefined && !isOpenId(recipient_open_id)) throw new HttpError(400, 'Invalid Feishu recipient');
    result.lark = { ...(app_id !== undefined ? { app_id: app_id as string, app_secret: app_secret as string } : {}), ...(recipient_open_id !== undefined ? { recipient_open_id } : {}) };
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
    ...(file.pulls?.follow ? { follow: file.pulls.follow.length } : {}), backends: Object.keys(file.backends ?? {}), agents: file.agents ?? [], warnings: [] };
}

/** Owner settings behind the Settings pages. Page callers are limited to this Mac by the UI layer. */
export class SettingsService {
  private source?: CredentialSource;
  private lastExport?: string;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly env: NodeJS.ProcessEnv;
  private readonly report: (record: Record<string, unknown>) => void;
  constructor(private readonly options: SettingsOptions) {
    this.source = options.source; this.env = options.env ?? process.env; this.report = options.report ?? (() => {});
  }
  private get exportsDir(): string { return join(this.options.state.directory, 'exports'); }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.catch(() => {}).then(operation);
    this.writes = pending;
    return pending;
  }
  async page(): Promise<SettingsPage> {
    const { lark, state } = this.options;
    const { version } = JSON.parse(await readFile(packageFile, 'utf8')) as { version: string };
    const channel = lark.channel();
    return { version, exports_dir: this.exportsDir, ...(this.lastExport ? { last_export: this.lastExport } : {}),
      lark: { status: lark.status(), source: this.source, app_id: lark.credentials?.appId, saved: Boolean(state.settings.lark_app_id),
        recipient: channel.recipient ?? state.settings.lark_recipient_open_id, groups: channel.groups } };
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
  async stop(): Promise<void> { await this.options.github.stop(); await this.writes.catch(() => {}); }

  /** Re-derives the active bot from its sources and moves the connection only if that changed it. */
  private async reload(): Promise<void> {
    const { lark, state, mcpConfig } = this.options;
    const resolved = await resolveCredentials(this.env, state.settings, mcpConfig);
    this.source = resolved?.source;
    const current = lark.credentials;
    if (current?.appId === resolved?.credentials.appId && current?.appSecret === resolved?.credentials.appSecret) return;
    await lark.configure(resolved?.credentials);
    this.report({ source: 'lark', status: 'lark_configured', reason: resolved ? resolved.credentials.appId : undefined });
  }
  saveLark(appId: unknown, appSecret: unknown): Promise<void> {
    return this.serialized(async () => {
      if (this.env.LARK_APP_ID || this.env.LARK_APP_SECRET) throw new HttpError(409, 'LARK_APP_ID and LARK_APP_SECRET are set for this process and take precedence');
      const { state } = this.options;
      if (!isAppId(appId)) throw new HttpError(400, 'Expected a Feishu App ID (cli_ and 16 hexadecimal digits)');
      // A blank secret keeps the saved one, so changing nothing else does not mean retyping it.
      const secret = appSecret === '' || appSecret === undefined ? (appId === state.settings.lark_app_id ? state.settings.lark_app_secret : undefined) : appSecret;
      if (typeof secret !== 'string' || !secret.trim()) throw new HttpError(400, 'Enter the App Secret');
      const credentials = { appId, appSecret: secret.trim() };
      try { await (this.options.verify ?? verifyCredentials)(credentials); }
      catch (error) { throw new HttpError(400, `Could not verify these credentials with Feishu: ${(error as Error).message}`); }
      state.settings.lark_app_id = credentials.appId; state.settings.lark_app_secret = credentials.appSecret;
      await state.save();
      await this.reload();
    });
  }
  /** Falls back to the MCP file, if any, and refuses rather than leaving saved credentials half removed if it is unreadable. */
  clearLark(): Promise<void> {
    return this.serialized(async () => {
      const { state, mcpConfig } = this.options;
      const { lark_app_id: _id, lark_app_secret: _secret, ...rest } = state.settings;
      await resolveCredentials(this.env, rest, mcpConfig);
      delete state.settings.lark_app_id; delete state.settings.lark_app_secret;
      await state.save();
      await this.reload();
    });
  }
  setRecipient(openId: unknown): Promise<void> {
    return this.serialized(async () => {
      if (!isOpenId(openId)) throw new HttpError(400, 'Expected a Feishu open_id (ou_…)');
      this.options.state.settings.lark_recipient_open_id = openId;
      await this.options.state.save();
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
      lark: { ...(credentials ? { app_id: credentials.appId, app_secret: credentials.appSecret } : {}), ...(recipient ? { recipient_open_id: recipient } : {}) },
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
    return this.serialized(async () => {
      const file = parseConfig(value);
      const { state, pulls, agents } = this.options;
      const summary = summarize(file);
      if (file.lark?.app_id) { state.settings.lark_app_id = file.lark.app_id; state.settings.lark_app_secret = file.lark.app_secret; }
      if (file.lark?.recipient_open_id) state.settings.lark_recipient_open_id = file.lark.recipient_open_id;
      for (const adapter of ['codex', 'opencode'] as const) {
        const connection = file.backends?.[adapter];
        if (connection) state.backends.set(adapter, connection);
      }
      await state.save();
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
