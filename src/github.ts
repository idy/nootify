import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, object } from './types.js';
import type { RouteRequest, RouteResponse, ServiceModule } from './types.js';
import { collectPulls, GitHubCommands, loadPullConfig, PullCollectionError, safeError, type PullCollection } from './github-api.js';
import { comparePulls, key, ownerOf, parseGitHubRemote } from './github-model.js';
import { conversationDirectories, defaultSources, type ConversationAgent, type ConversationSources } from './conversations.js';

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
  repository: string;
  author: string;
  headRepository?: string;
  updatedAt: string;
  reviewDecision: string;
  mergeable: string;
  ci: { state: string; passed: number; failed: number; pending: number; total: number };
}
/** A repository seen in local agent conversations or in a pull request queue. */
export interface RepositoryEntry {
  repository: string;
  /** Whether its PRs are shown: the explicit choice, else whether we are involved in it (or `followDefault: "all"`). */
  followed: boolean;
  choice?: 'follow' | 'mute';
  agents: ConversationAgent[];
  /** Conversations whose working directory has this repository as a remote. */
  sessions: number;
  /** Open PRs authored by our accounts. */
  authored: number;
  lastActive?: string;
  pulls: { internal: number; upstream: number };
}
export interface PullSnapshot {
  internal: PullRequest[];
  upstream: PullRequest[];
  /** Open PRs left out because their repository is not followed. */
  hidden: { internal: number; upstream: number };
  repositories: RepositoryEntry[];
  refresh: { running: boolean; startedAt?: string; finishedAt?: string; lastSuccessAt?: string; error?: string };
  warnings: string[];
}
interface Involvement { repository: string; agents: ConversationAgent[]; sessions: number; lastActive?: string }
/** What is collected and cached; follow choices are applied when a snapshot is read. */
interface Collected {
  internal: PullRequest[];
  upstream: PullRequest[];
  involved: Involvement[];
  authors: string[];
  followDefault: 'involved' | 'all';
  refresh: PullSnapshot['refresh'];
  warnings: string[];
}
const REFRESH_INTERVAL = 5 * 60_000;
const AGENTS: ConversationAgent[] = ['claude', 'codex', 'opencode'];
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const repositoryName = (value: unknown): value is string => typeof value === 'string' && parseGitHubRemote(`https://github.com/${value}`) === value;
function cachedPull(value: unknown): value is PullRequest {
  if (!isObject(value) || !isObject(value.ci)) return false;
  const ci = value.ci;
  return Number.isInteger(value.number) && (value.number as number) > 0 && typeof value.isDraft === 'boolean'
    && ['url', 'title', 'repository', 'author', 'updatedAt', 'reviewDecision', 'mergeable'].every(field => typeof value[field] === 'string')
    && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(value.url as string)
    && (value.headRepository === undefined || typeof value.headRepository === 'string')
    && typeof value.ci.state === 'string' && ['passed', 'failed', 'pending', 'total'].every(field => Number.isInteger(ci[field]) && (ci[field] as number) >= 0);
}
function cachedInvolvement(value: unknown): value is Involvement {
  return isObject(value) && repositoryName(value.repository) && Array.isArray(value.agents)
    && value.agents.every(agent => AGENTS.includes(agent as ConversationAgent))
    && Number.isInteger(value.sessions) && (value.sessions as number) >= 0 && (value.lastActive === undefined || timestamp(value.lastActive));
}
/** Version 1 caches predate repository involvement; they load with none until the next refresh. */
function cachedSnapshot(value: unknown): Collected | undefined {
  if (!isObject(value) || (value.version !== 1 && value.version !== 2) || !isObject(value.snapshot)) return;
  const snapshot = value.snapshot;
  if (!isObject(snapshot.refresh)) return;
  const refresh = snapshot.refresh;
  const involved = snapshot.involved ?? [];
  const authors = snapshot.authors ?? [];
  const followDefault = snapshot.followDefault ?? 'involved';
  const valid = Array.isArray(snapshot.internal) && Array.isArray(snapshot.upstream)
    && snapshot.internal.length + snapshot.upstream.length <= 50_000 && [...snapshot.internal, ...snapshot.upstream].every(cachedPull)
    && typeof refresh.running === 'boolean'
    && ['startedAt', 'finishedAt', 'lastSuccessAt'].every(field => refresh[field] === undefined || timestamp(refresh[field]))
    && (refresh.error === undefined || typeof refresh.error === 'string')
    && Array.isArray(snapshot.warnings) && snapshot.warnings.length <= 5000 && snapshot.warnings.every(warning => typeof warning === 'string')
    && Array.isArray(involved) && involved.length <= 10_000 && involved.every(cachedInvolvement)
    && Array.isArray(authors) && authors.length <= 100 && authors.every(author => typeof author === 'string')
    && (followDefault === 'involved' || followDefault === 'all');
  if (!valid) return;
  return { internal: snapshot.internal as PullRequest[], upstream: snapshot.upstream as PullRequest[], involved: involved as Involvement[],
    authors: authors as string[], followDefault: followDefault as Collected['followDefault'], refresh: refresh as PullSnapshot['refresh'], warnings: snapshot.warnings as string[] };
}
async function writePrivate(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, name));
  } finally { await rm(temporary, { force: true }); }
}

/** GitHub module: read-only queries, local conversation discovery, and the user's follow choices. The host owns HTTP authentication. */
export class PullRequestsService implements ServiceModule {
  readonly name = 'pulls';
  private current: Collected = { internal: [], upstream: [], involved: [], authors: [], followDefault: 'involved', refresh: { running: false }, warnings: ['GitHub has not refreshed yet.'] };
  private readonly choices = new Map<string, { repository: string; follow: boolean }>();
  private choiceWrites: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private initializing?: Promise<void>;
  private work?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;
  private started = false;
  constructor(private readonly directory: string, private readonly report: (record: Record<string, unknown>) => void = () => {},
    private readonly sources: ConversationSources = defaultSources()) {}

  status(): string {
    if (this.stopped) return 'stopped';
    if (this.current.refresh.running) return 'refreshing';
    if (this.current.refresh.error) return this.current.refresh.lastSuccessAt ? 'stale' : 'error';
    return this.current.refresh.lastSuccessAt ? 'ready' : 'idle';
  }
  repositories(): RepositoryEntry[] {
    const entries = new Map<string, RepositoryEntry>();
    const entry = (repository: string): RepositoryEntry => {
      let found = entries.get(key(repository));
      if (!found) { found = { repository, followed: false, agents: [], sessions: 0, authored: 0, pulls: { internal: 0, upstream: 0 } }; entries.set(key(repository), found); }
      return found;
    };
    for (const item of this.current.involved) {
      const found = entry(item.repository);
      found.agents = AGENTS.filter(agent => found.agents.includes(agent) || item.agents.includes(agent));
      found.sessions += item.sessions;
      if (item.lastActive && (!found.lastActive || item.lastActive > found.lastActive)) found.lastActive = item.lastActive;
    }
    const authors = new Set(this.current.authors.map(key));
    for (const queue of ['internal', 'upstream'] as const) {
      for (const pull of this.current[queue]) { const found = entry(pull.repository); found.pulls[queue]++; if (authors.has(key(pull.author))) found.authored++; }
    }
    // An explicit choice keeps a repository listed after its conversations and PRs are gone.
    for (const choice of this.choices.values()) entry(choice.repository);
    for (const found of entries.values()) {
      const choice = this.choices.get(key(found.repository));
      if (choice) found.choice = choice.follow ? 'follow' : 'mute';
      found.followed = choice ? choice.follow : this.current.followDefault === 'all' || found.agents.length > 0 || found.authored > 0;
    }
    return [...entries.values()].sort((a, b) => Number(b.followed) - Number(a.followed)
      || (b.lastActive ?? '').localeCompare(a.lastActive ?? '') || key(a.repository).localeCompare(key(b.repository)));
  }
  snapshot(): PullSnapshot {
    const repositories = this.repositories();
    const followed = new Set(repositories.filter(entry => entry.followed).map(entry => key(entry.repository)));
    const internal = this.current.internal.filter(pull => followed.has(key(pull.repository)));
    const upstream = this.current.upstream.filter(pull => followed.has(key(pull.repository)));
    return structuredClone({ internal, upstream, repositories, refresh: this.current.refresh, warnings: this.current.warnings,
      hidden: { internal: this.current.internal.length - internal.length, upstream: this.current.upstream.length - upstream.length } });
  }
  /** `follow: null` returns the repository to its default (followed when we are involved in it). */
  async setChoice(repository: string, follow: boolean | null): Promise<RepositoryEntry> {
    if (!repositoryName(repository)) throw new HttpError(400, 'Expected an owner/name GitHub repository');
    if (follow !== null && typeof follow !== 'boolean') throw new HttpError(400, 'follow must be true, false or null');
    const known = this.repositories().find(entry => key(entry.repository) === key(repository));
    const name = known?.repository ?? repository;
    // A choice equal to the automatic default is stored as none, so the repository keeps tracking involvement.
    const automatic = this.current.followDefault === 'all' || Boolean(known && (known.agents.length > 0 || known.authored > 0));
    if (follow === null || follow === automatic) this.choices.delete(key(name)); else this.choices.set(key(name), { repository: name, follow });
    const snapshot = { version: 1, choices: [...this.choices.values()] };
    const pending = this.choiceWrites.catch(() => {}).then(() => writePrivate(this.directory, 'repo-preferences.json', snapshot));
    this.choiceWrites = pending;
    await pending;
    return this.repositories().find(entry => key(entry.repository) === key(name))!;
  }
  async start(): Promise<void> {
    if (this.started) return this.initializing;
    this.started = true; this.stopped = false;
    this.initializing = this.initialize();
    return this.initializing;
  }
  private async initialize(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
      const path = join(this.directory, 'pulls-cache.json');
      try {
        if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('Pulls cache exceeds 32 MiB.');
        const value = cachedSnapshot(JSON.parse(await readFile(path, 'utf8')));
        if (!value) throw new Error('Invalid pulls cache.');
        await chmod(path, 0o600);
        this.current = value;
        this.current.refresh.running = false;
        this.current.internal.sort(comparePulls); this.current.upstream.sort(comparePulls);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.current.warnings = [`Could not load private pulls cache: ${safeError(error)}`];
      }
      await this.loadChoices();
    } catch (error) { this.current.warnings = [`Could not prepare private pulls cache: ${safeError(error)}`]; }
    if (this.stopped) return;
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL); this.timer.unref();
    this.refresh();
  }
  private async loadChoices(): Promise<void> {
    const path = join(this.directory, 'repo-preferences.json');
    let value: unknown;
    try {
      if ((await stat(path)).size > 1024 * 1024) throw new Error('Repository preferences exceed 1 MiB.');
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.current.warnings.push(`Could not load repository follow choices: ${safeError(error)}`); return;
    }
    const choices = isObject(value) && value.version === 1 && Array.isArray(value.choices) ? value.choices : undefined;
    if (!choices?.every(choice => isObject(choice) && repositoryName(choice.repository) && typeof choice.follow === 'boolean')) {
      this.current.warnings.push('Ignored invalid repository follow choices.'); return;
    }
    for (const choice of choices as { repository: string; follow: boolean }[]) this.choices.set(key(choice.repository), choice);
  }
  /** Coalesce repeated refreshes into the running operation; never await GitHub in an HTTP request. */
  refresh(): void {
    if (this.stopped || this.work) return;
    const controller = new AbortController(); this.controller = controller;
    this.current.refresh = { ...this.current.refresh, running: true, startedAt: new Date().toISOString() };
    delete this.current.refresh.error;
    this.work = this.update(controller.signal).finally(() => { this.work = undefined; if (this.controller === controller) this.controller = undefined; });
  }
  /** Repositories that local conversations ran in, from each directory's git remotes (and Codex's recorded origin). */
  private async involvement(commands: GitHubCommands, signal: AbortSignal): Promise<{ involved: Involvement[]; directories: string[]; warnings: string[] }> {
    const found = await conversationDirectories(this.sources);
    const involved = new Map<string, Involvement>();
    for (const item of found.directories) {
      signal.throwIfAborted();
      const repositories = new Map<string, string>();
      const origin = item.origin ? parseGitHubRemote(item.origin) : undefined;
      if (origin) repositories.set(key(origin), origin);
      try { for (const remote of await commands.remotes(item.directory)) repositories.set(key(remote.repository), remote.repository); }
      catch { signal.throwIfAborted(); /* removed worktree or not a repository */ }
      for (const repository of repositories.values()) {
        const entry = involved.get(key(repository)) ?? { repository, agents: [], sessions: 0 };
        if (!entry.agents.includes(item.agent)) entry.agents.push(item.agent);
        entry.sessions += item.sessions;
        if (item.lastActive && (!entry.lastActive || item.lastActive > entry.lastActive)) entry.lastActive = item.lastActive;
        involved.set(key(repository), entry);
      }
    }
    const counts = AGENTS.map(agent => `${agent} ${found.directories.filter(item => item.agent === agent).length}`).join(', ');
    return { involved: [...involved.values()], directories: found.directories.map(item => item.directory),
      warnings: [...found.warnings, `Conversation directories: ${counts}; ${involved.size} GitHub repositories found in their remotes. Repositories default to followed when they appear in conversations or have open PRs by our accounts.`] };
  }
  private async update(signal: AbortSignal): Promise<void> {
    const commands = new GitHubCommands(this.directory, signal);
    let configWarnings: string[] = [];
    try {
      const loaded = await loadPullConfig(this.directory); configWarnings = loaded.warnings;
      signal.throwIfAborted();
      const conversations = await this.involvement(commands, signal);
      const collected = await collectPulls(loaded.config, commands, signal, conversations.directories);
      signal.throwIfAborted();
      const warnings = [...loaded.warnings, ...conversations.warnings, ...collected.warnings];
      this.retainUncoveredCache(collected, warnings);
      const now = new Date().toISOString();
      this.current = {
        internal: collected.internal.sort(comparePulls), upstream: collected.upstream.sort(comparePulls),
        involved: conversations.involved, authors: collected.scope.authors, followDefault: loaded.config.followDefault,
        refresh: { running: false, startedAt: this.current.refresh.startedAt, finishedAt: now, lastSuccessAt: now },
        warnings: [...new Set(warnings)],
      };
      try { await this.persist(); }
      catch (error) { this.current.warnings.push(`GitHub refresh succeeded but the private cache was not saved: ${safeError(error)}`); }
      const visible = this.snapshot();
      this.emit({ source: 'pulls', status: 'refresh_completed',
        reason: `我们仓库 ${visible.internal.length} 个、提交上游 ${visible.upstream.length} 个；关注 ${visible.repositories.filter(entry => entry.followed).length} 个仓库；配置：${loaded.source}` });
    } catch (error) {
      const now = new Date().toISOString();
      this.current.refresh = { ...this.current.refresh, running: false, finishedAt: now,
        ...(signal.aborted ? {} : { error: safeError(error) }) };
      if (!signal.aborted) {
        this.current.warnings = [...new Set([...this.current.warnings, ...configWarnings,
          ...(error instanceof PullCollectionError ? error.warnings : []), 'Refresh failed; displaying the last good GitHub snapshot, which may be stale.'])];
        this.emit({ source: 'pulls', status: 'refresh_failed', error: safeError(error) });
      }
    } finally { await commands.stop(); }
  }
  private retainUncoveredCache(result: PullCollection, warnings: string[]): void {
    const owned = new Set(result.scope.ownedOwners.map(key));
    const excluded = new Set(result.scope.excludeRepositories.map(key));
    const authors = new Set(result.scope.authors.map(key));
    const forks = new Set((result.scope.localForks ?? []).map(key));
    const observed = new Set(result.observedUrls);
    for (const queue of ['internal', 'upstream'] as const) {
      if (!(queue === 'internal' ? result.incompleteInternal : result.incompleteUpstream)) continue;
      const urls = new Set(result[queue].map(pr => key(pr.url))); let retained = 0;
      for (const pr of this.current[queue]) {
        if (urls.has(key(pr.url)) || observed.has(key(pr.url)) || excluded.has(key(pr.repository))) continue;
        const internal = owned.has(key(ownerOf(pr.repository)));
        if (queue === 'internal' ? !internal : internal || !(authors.has(key(pr.author)) || pr.headRepository && (owned.has(key(ownerOf(pr.headRepository))) || forks.has(key(pr.headRepository))))) continue;
        result[queue].push(pr); urls.add(key(pr.url)); retained++;
      }
      if (retained) warnings.push(`Incomplete ${queue} source coverage: retained ${retained} cached PRs not returned by this scan; they may have changed or closed since the last complete refresh.`);
    }
  }
  private persist(): Promise<void> { return writePrivate(this.directory, 'pulls-cache.json', { version: 2, snapshot: this.current }); }
  private emit(record: Record<string, unknown>): void { try { this.report(record); } catch { /* Reporting must not break the module lifecycle. */ } }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.controller?.abort();
    await this.initializing;
    await this.work;
    await this.choiceWrites.catch(() => {});
    this.started = false; this.initializing = undefined;
    this.current.refresh.running = false;
  }
  async handle(request: RouteRequest): Promise<RouteResponse | undefined> {
    if (request.method === 'GET' && request.path === '/v1/pulls') return { body: this.snapshot() };
    if (request.method === 'POST' && request.path === '/v1/pulls/refresh') {
      this.refresh(); return { status: 202, body: this.snapshot() };
    }
    if (request.method === 'GET' && request.path === '/v1/repos') return { body: this.repositories() };
    const match = /^\/v1\/repos\/([^/]+)\/([^/]+)$/.exec(request.path);
    if (match && request.method === 'PUT') {
      return { body: await this.setChoice(`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`, object(request.body).follow as boolean | null) };
    }
  }
}
