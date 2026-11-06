import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStateDir } from './state.js';
import { HttpError, object } from './types.js';
import type { Adapter, RouteRequest, RouteResponse, ServiceModule } from './types.js';
import type { NotificationChannel } from './chat-transport.js';

export type AgentId = 'claude' | 'codex' | 'opencode';
export const AGENT_IDS: AgentId[] = ['claude', 'codex', 'opencode'];
export const isAgent = (value: unknown): value is AgentId => typeof value === 'string' && (AGENT_IDS as string[]).includes(value);
/**
 * `missing`: the agent's configuration directory does not exist. `absent`: no Nootify block.
 * `current`/`outdated`: the block matches, or differs from, what Nootify would write now. `conflict`: unbalanced markers;
 * `error`: the file could not be read. Neither of the last two is ever edited.
 */
export type PromptStatus = 'missing' | 'absent' | 'current' | 'outdated' | 'conflict' | 'error';
export interface AgentPrompt { agent: AgentId; name: string; file: string; status: PromptStatus; injected: boolean; block: string; error?: string }
export const BEGIN = '<!-- nootify:begin -->';
export const END = '<!-- nootify:end -->';
const names: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const MAX_PROMPT_FILE = 1024 * 1024;
const BACKUPS_PER_AGENT = 10;

export function promptFiles(env: NodeJS.ProcessEnv = process.env): Record<AgentId, string> {
  return {
    claude: join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'CLAUDE.md'),
    codex: join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'AGENTS.md'),
    opencode: join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode', 'AGENTS.md'),
  };
}

/** Agents run the CLI from their own shells; this resolves the calling session from the variables each client sets. */
export function agentSession(agent: AgentId, env: NodeJS.ProcessEnv = process.env): { adapter: Adapter; session_id?: string } {
  if (agent === 'claude') {
    if (env.CLAUDE_CODE_HOST_SESSION_ID) return { adapter: 'claude-desktop', session_id: env.CLAUDE_CODE_HOST_SESSION_ID };
    return { adapter: 'claude-code', session_id: env.CLAUDE_CODE_SESSION_ID || undefined };
  }
  if (agent === 'codex') return { adapter: 'codex', session_id: env.CODEX_THREAD_ID || undefined };
  return { adapter: 'opencode' };
}

const plain = /^[A-Za-z0-9_./:@%+=,-]+$/;
const quote = (value: string): string => plain.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
export interface PromptOptions { stateDir: string; port: number; tailnetAddress?: () => string | undefined; notificationChannel?: () => NotificationChannel; command?: string[] }

/** The block for one agent. Commands name this installation's Node and CLI, so they work from any project directory. */
export function promptBlock(agent: AgentId, options: PromptOptions): string {
  const base = (options.command ?? [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))]).map(quote).join(' ');
  const extra = `${options.stateDir !== defaultStateDir() ? ` --state-dir ${quote(options.stateDir)}` : ''}${options.port !== 9417 ? ` --port ${options.port}` : ''}`;
  const channel = options.notificationChannel?.() ?? 'feishu';
  const identity = (agent === 'opencode' ? '--agent opencode --session-id <this ses_… session ID>' : `--agent ${agent}`) + (channel === 'feishu' ? '' : ` --channel ${channel}`);
  const run = (command: string, args: string): string => `\`${base} ${command} ${identity} ${args}${extra}\``;
  const address = options.tailnetAddress?.();
  return [
    BEGIN,
    `## ${channel === 'feishu' ? 'Feishu' : channel === 'slack' ? 'Slack' : 'Telegram'} updates through Nootify`,
    '',
    channel === 'feishu' ? 'Nootify gives each conversation its own Feishu group, so the user can follow your progress and reply from Feishu.'
      : `Nootify gives each conversation its own ${channel === 'slack' ? 'Slack thread' : 'Telegram topic'}, so the user can follow your progress and reply there.`,
    '',
    channel === 'feishu' ? "- For work longer than a quick answer, open this conversation's group first. Later calls reuse it; Nootify keeps the session's routing token in the group announcement:"
      : "- For work longer than a quick answer, open this conversation's thread first. Later calls reuse its local session binding:",
    `  ${run('thread-open', '--session-name "<short task title>"')}`,
    "- Post progress, blockers and results as you go, in the user's language. Each message is prefixed with the session name:",
    `  ${run('thread-send', '--text "<message>"')}`,
    '  Use `--text-file -` to send multi-line text from standard input.',
    `- Nootify's independent Tailscale device${address ? ` (\`http://${address}/\`)` : ''} exposes only Nootify on port 80. It does not expose this Mac's previews, files, or other ports. Share other local pages or files only through a separately configured and verified reachable address; never substitute the Nootify device IP for a host address.`,
    channel === 'feishu' ? '- Messages from the user in that group arrive here marked 【来自飞书用户的消息】 with `lark-ack` and `lark-reply` commands; answer them when convenient.'
      : `- Messages arrive here marked 【来自${channel === 'slack' ? 'Slack' : 'Telegram'}用户的消息】 with \`chat-ack\` and \`chat-reply\` commands. Answer when convenient; the reply goes to the original thread or topic.`,
    "- Nootify maintains this block; change it on Nootify's Agents page instead of editing it here.",
    END,
  ].join('\n');
}

function locate(content: string): { start: number; end: number } | 'none' | 'conflict' {
  const count = (marker: string): number => content.split(marker).length - 1;
  const begins = count(BEGIN); const ends = count(END);
  if (!begins && !ends) return 'none';
  const start = content.indexOf(BEGIN); const end = content.indexOf(END);
  if (begins !== 1 || ends !== 1 || end < start) return 'conflict';
  return { start, end: end + END.length };
}
/** Appends after one blank line; removal takes that separator back out, so other content is left as it was. */
export function withBlock(content: string, block: string): string {
  const found = locate(content);
  if (found === 'conflict') throw new HttpError(409, 'The prompt file has unbalanced Nootify markers; fix them by hand first');
  if (found !== 'none') return content.slice(0, found.start) + block + content.slice(found.end);
  return content + (content === '' ? '' : content.endsWith('\n') ? '\n' : '\n\n') + block + '\n';
}
export function withoutBlock(content: string): string {
  const found = locate(content);
  if (found === 'conflict') throw new HttpError(409, 'The prompt file has unbalanced Nootify markers; fix them by hand first');
  if (found === 'none') return content;
  let before = content.slice(0, found.start); let after = content.slice(found.end);
  if (after.startsWith('\n')) after = after.slice(1);
  if (before.endsWith('\n\n')) before = before.slice(0, -1);
  return before + after;
}

/** Reads and edits only the marked block in each agent's global prompt file. Edits are atomic and back up the previous file. */
export class AgentPrompts implements ServiceModule {
  readonly name = 'agents';
  private writes: Promise<unknown> = Promise.resolve();
  private readonly files: Record<AgentId, string>;
  constructor(private readonly options: PromptOptions & { files?: Partial<Record<AgentId, string>> },
    private readonly report: (record: Record<string, unknown>) => void = () => {}) {
    this.files = { ...promptFiles(), ...options.files };
  }
  status(): string { return 'ready'; }
  /** Prompt files may be symlinks into a dotfiles checkout; edits go to the target and keep the link. */
  private async target(file: string): Promise<string> {
    try { return await realpath(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let link = false;
      try { link = (await lstat(file)).isSymbolicLink(); } catch { /* no file yet */ }
      if (link) throw new HttpError(409, `${file} is a symlink to a missing file`);
      return file;
    }
  }
  private async read(path: string): Promise<string | undefined> {
    try {
      if ((await stat(path)).size > MAX_PROMPT_FILE) throw new HttpError(413, `${path} exceeds 1 MiB`);
      return await readFile(path, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  async inspect(agent: AgentId): Promise<AgentPrompt> {
    const file = this.files[agent];
    const block = promptBlock(agent, this.options);
    const entry: AgentPrompt = { agent, name: names[agent], file, status: 'absent', injected: false, block };
    try {
      if (!(await stat(dirname(file)).then(info => info.isDirectory(), () => false))) return { ...entry, status: 'missing' };
      const content = await this.read(await this.target(file)) ?? '';
      const found = locate(content);
      if (found === 'conflict') return { ...entry, status: 'conflict' };
      if (found === 'none') return entry;
      return { ...entry, injected: true, status: content.slice(found.start, found.end) === block ? 'current' : 'outdated' };
    } catch (error) { return { ...entry, status: 'error', error: (error as Error).message }; }
  }
  list(): Promise<AgentPrompt[]> { return Promise.all(AGENT_IDS.map(agent => this.inspect(agent))); }
  /** `enabled: true` writes or refreshes the block; `false` removes it. Writes are serialized across agents. */
  set(agent: AgentId, enabled: boolean): Promise<AgentPrompt> {
    const operation = this.writes.catch(() => {}).then(() => this.apply(agent, enabled));
    this.writes = operation;
    return operation;
  }
  private async apply(agent: AgentId, enabled: boolean): Promise<AgentPrompt> {
    const current = await this.inspect(agent);
    if (current.status === 'missing') {
      if (!enabled) return current;
      await mkdir(dirname(current.file), { recursive: true, mode: 0o700 });
    }
    if (current.status === 'conflict') throw new HttpError(409, 'The prompt file has unbalanced Nootify markers; fix them by hand first');
    if (current.status === 'error') throw new HttpError(409, `Cannot read ${current.file}: ${current.error}`);
    const path = await this.target(current.file);
    if (enabled) {
      for (const other of AGENT_IDS.filter(id => id !== agent)) {
        const otherPath = await realpath(this.files[other]).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (otherPath === path) throw new HttpError(409, `${names[agent]} and ${names[other]} share the same prompt file; separate their files before adding agent-specific instructions`);
      }
    }
    const before = await this.read(path);
    const after = enabled ? withBlock(before ?? '', current.block) : withoutBlock(before ?? '');
    if (after === (before ?? '') && (before !== undefined || !enabled)) return this.inspect(agent);
    if (before !== undefined) await this.backup(agent, before);
    if (!after && before !== undefined) await rm(path);
    else {
      const mode = before === undefined ? 0o644 : (await stat(path)).mode & 0o777;
      const temporary = join(dirname(path), `.${randomUUID()}.nootify.tmp`);
      try {
        await writeFile(temporary, after, { flag: 'wx', mode });
        await chmod(temporary, mode);
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    }
    this.report({ source: 'agents', status: enabled ? 'prompt_injected' : 'prompt_removed', reason: `${names[agent]}: ${current.file}` });
    return this.inspect(agent);
  }
  private async backup(agent: AgentId, content: string): Promise<void> {
    const directory = join(this.options.stateDir, 'agent-backups');
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    await writeFile(join(directory, `${agent}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.md`), content, { flag: 'wx', mode: 0o600 });
    const old = (await readdir(directory)).filter(name => name.startsWith(`${agent}-`)).sort().slice(0, -BACKUPS_PER_AGENT);
    await Promise.all(old.map(name => rm(join(directory, name), { force: true })));
  }
  async handle(request: RouteRequest): Promise<RouteResponse | undefined> {
    if (request.path === '/v1/agents' && request.method === 'GET') return { body: await this.list() };
    const match = /^\/v1\/agents\/([^/]+)$/.exec(request.path);
    if (!match || request.method !== 'PUT') return;
    const agent = decodeURIComponent(match[1]);
    if (!isAgent(agent)) throw new HttpError(404, 'Unknown agent');
    const enabled = object(request.body).enabled;
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    return { body: await this.set(agent, enabled) };
  }
}
