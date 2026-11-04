import { setTimeout as delay } from 'node:timers/promises';
import { GitHubCommands, GitHubSignedOut, safeError, USER_AGENT } from './github-api.js';
import type { State } from './state.js';

/** Names Nootify's OAuth App, which has Device Flow enabled. Client IDs are public and this flow uses no client secret. */
export const GITHUB_CLIENT_ID = process.env.NOOTIFY_GITHUB_CLIENT_ID?.trim() || 'Ov23liMl1ElZD0hh84y1';
/** Private repositories need `repo`: OAuth has no read-only scope for them. Nootify only sends read-only queries. */
const SCOPES = 'repo read:org';
const DEVICE_PAGE = 'https://github.com/login/device';
const REQUEST_TIMEOUT = 15_000;
const ACCOUNT_TIMEOUT = 15_000;
/** GitHub's documented values, for a reply that leaves them out. */
const CODE_LIFETIME = 900;
const POLL_INTERVAL = 5;

/** `error` means the login could not be checked, not that it is gone. */
export interface GitHubAccount { signedIn: boolean; login?: string; error?: string }
/** `error` is GitHub's error code when it gave one, such as `access_denied`. */
export interface GitHubLogin { status: 'idle' | 'starting' | 'waiting' | 'failed'; code?: string; url?: string; expiresAt?: string; error?: string }
interface DeviceCode { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string }
interface TokenReply { access_token?: string; interval?: number; error?: string }

async function post<T>(path: string, fields: Record<string, string>, signal: AbortSignal): Promise<T> {
  const response = await fetch(`https://github.com/${path}`, { method: 'POST', redirect: 'error', body: new URLSearchParams(fields),
    headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]) });
  return await response.json() as T;
}

/**
 * Signs in through GitHub's device flow: the page shows the code, this service polls until it is
 * authorized, and the token stays in the private state file. The token is Nootify's own, so
 * signing in or out never touches the GitHub CLI's login on this Mac.
 */
export class GitHubAuth {
  private flow: GitHubLogin = { status: 'idle' };
  private controller?: AbortController;
  private running?: Promise<void>;
  constructor(private readonly state: State, private readonly report: (record: Record<string, unknown>) => void = () => {},
    private readonly changed: () => void = () => {}, private readonly clientId = GITHUB_CLIENT_ID) {}

  login(): GitHubLogin { return { ...this.flow }; }
  private active(): boolean { return this.flow.status === 'starting' || this.flow.status === 'waiting'; }
  async account(): Promise<GitHubAccount> {
    const commands = new GitHubCommands(this.state.directory, AbortSignal.timeout(ACCOUNT_TIMEOUT), () => this.state.settings.github_token);
    try {
      const { data } = await commands.graphql('query NootifyViewer { viewer { login } }');
      return { signedIn: true, login: String(data.viewer?.login) };
    } catch (error) { return { signedIn: false, ...(error instanceof GitHubSignedOut ? {} : { error: safeError(error) }) }; }
  }
  start(): GitHubLogin {
    if (this.active()) return this.login();
    if (!this.clientId) { this.flow = { status: 'failed', error: 'missing_client_id' }; return this.login(); }
    const controller = new AbortController();
    this.controller = controller;
    this.flow = { status: 'starting' };
    this.running = this.run(controller.signal).catch(error => { if (!controller.signal.aborted) this.flow = { status: 'failed', error: safeError(error) }; });
    return this.login();
  }
  private async run(signal: AbortSignal): Promise<void> {
    const device = await post<DeviceCode>('login/device/code', { client_id: this.clientId, scope: SCOPES }, signal);
    if (!device.device_code || !device.user_code) throw new Error(device.error ?? 'unexpected_reply');
    const expires = Date.now() + (device.expires_in ?? CODE_LIFETIME) * 1000;
    this.flow = { status: 'waiting', code: device.user_code, url: device.verification_uri ?? DEVICE_PAGE, expiresAt: new Date(expires).toISOString() };
    let interval = device.interval ?? POLL_INTERVAL;
    for (;;) {
      await delay(interval * 1000, undefined, { signal });
      if (Date.now() > expires) throw new Error('expired_token');
      let reply: TokenReply;
      try {
        reply = await post<TokenReply>('login/oauth/access_token', { client_id: this.clientId, device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal);
      } catch { signal.throwIfAborted(); continue; } // A dropped connection says nothing about the code.
      if (reply.access_token) {
        signal.throwIfAborted();
        this.state.settings.github_token = reply.access_token;
        await this.state.save();
        this.flow = { status: 'idle' };
        this.report({ source: 'pulls', status: 'github_login' });
        this.changed();
        return;
      }
      if (reply.error === 'slow_down') interval = reply.interval ?? interval + POLL_INTERVAL;
      else if (reply.error !== 'authorization_pending') throw new Error(reply.error ?? 'unexpected_reply');
    }
  }
  cancel(): GitHubLogin {
    if (this.active()) { this.controller?.abort(); this.flow = { status: 'idle' }; }
    return this.login();
  }
  /** Forgets the token here. Revoking it needs the OAuth App's secret, which Nootify does not have, so that stays on GitHub's settings page. */
  async signOut(): Promise<void> {
    this.cancel();
    delete this.state.settings.github_token;
    await this.state.save();
    this.report({ source: 'pulls', status: 'github_logout' });
    this.changed();
  }
  async stop(): Promise<void> { this.cancel(); await this.running; }
}
