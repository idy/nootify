import { spawn, type ChildProcess } from 'node:child_process';
import { GitHubCommands, ghEnvironment, safeError } from './github-api.js';

/** GitHub's device codes last 15 minutes; gh gives up by itself, this only bounds a stuck child. */
const LOGIN_TIMEOUT = 16 * 60_000;
const CODE_LIFETIME = 15 * 60_000;
const ACCOUNT_TIMEOUT = 15_000;

/** `installed: false` means no usable gh. `error` means the login could not be checked, not that it is gone. */
export interface GitHubAccount { installed: boolean; signedIn: boolean; login?: string; error?: string }
export interface GitHubLogin { status: 'idle' | 'starting' | 'waiting' | 'failed'; code?: string; url?: string; expiresAt?: string; error?: string }

/** gh writes `One-time code (X) copied to clipboard` or `First copy your one-time code: X`, after a warning if copying failed. */
export function deviceCode(output: string): { code: string; url: string } | undefined {
  const code = /[Oo]ne-time code[^\n]*?\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(output)?.[1];
  const url = /https:\/\/github\.com\/login\/device\S*/.exec(output)?.[0];
  return code && url ? { code, url } : undefined;
}

/**
 * Signs the GitHub CLI in through its device flow. Without a terminal, `gh auth login --web` prints the
 * code and URL and then waits for the browser, so the page can show both. The credential stays with gh,
 * shared with the terminal, and never passes through this service.
 */
export class GitHubAuth {
  private flow: GitHubLogin = { status: 'idle' };
  private child?: ChildProcess;
  private closed?: Promise<void>;
  /** Bumped by every start and cancel, so a superseded attempt cannot report over the current one. */
  private attempt = 0;
  constructor(private readonly directory: string, private readonly report: (record: Record<string, unknown>) => void = () => {},
    private readonly signedIn: () => void = () => {}) {}

  login(): GitHubLogin { return { ...this.flow }; }
  private active(): boolean { return this.flow.status === 'starting' || this.flow.status === 'waiting'; }
  async account(): Promise<GitHubAccount> {
    const commands = new GitHubCommands(this.directory, AbortSignal.timeout(ACCOUNT_TIMEOUT));
    try { await commands.findGh(); } catch (error) { return { installed: false, signedIn: false, error: safeError(error) }; }
    try {
      const { data } = await commands.graphql('query NootifyViewer { viewer { login } }');
      return { installed: true, signedIn: true, login: String(data.viewer?.login) };
    } catch (error) {
      // gh ends both "no token" and a rejected token by suggesting this command; anything else says nothing about the login.
      const expired = String((error as { stderr?: string }).stderr).includes('gh auth login');
      return { installed: true, signedIn: false, ...(expired ? {} : { error: safeError(error) }) };
    } finally { await commands.stop(); }
  }
  start(): GitHubLogin {
    if (this.active()) return this.login();
    const attempt = ++this.attempt;
    this.flow = { status: 'starting' };
    this.run(attempt).catch(error => { if (attempt === this.attempt) this.flow = { status: 'failed', error: safeError(error) }; });
    return this.login();
  }
  private async run(attempt: number): Promise<void> {
    const gh = await new GitHubCommands(this.directory, AbortSignal.timeout(ACCOUNT_TIMEOUT)).findGh();
    if (attempt !== this.attempt) return;
    const child = spawn(gh, ['auth', 'login', '--hostname', 'github.com', '--web'],
      { cwd: this.directory, env: ghEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], timeout: LOGIN_TIMEOUT });
    this.child = child;
    let output = '';
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8192);
      const found = deviceCode(output);
      if (found && attempt === this.attempt && this.flow.status === 'starting') {
        this.flow = { status: 'waiting', ...found, expiresAt: new Date(Date.now() + CODE_LIFETIME).toISOString() };
      }
    };
    child.stdout!.on('data', read); child.stderr!.on('data', read);
    const exit = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('close', accept); });
    this.closed = exit.then(() => {}, () => {});
    const code = await exit;
    if (this.child === child) this.child = undefined;
    if (attempt !== this.attempt) return;
    if (code === 0) {
      this.flow = { status: 'idle' };
      this.report({ source: 'pulls', status: 'github_login' });
      this.signedIn();
    } else this.flow = { status: 'failed', error: safeError({ stderr: output || `gh exited with ${code}` }) };
  }
  cancel(): GitHubLogin {
    if (this.active()) { this.attempt++; this.flow = { status: 'idle' }; this.child?.kill(); }
    return this.login();
  }
  async stop(): Promise<void> { this.cancel(); await this.closed; }
}
