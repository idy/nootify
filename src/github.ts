import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, object, type Adapter, type RouteRequest, type RouteResponse, type ServiceModule } from './types.js';
import { collectPulls, GitHubCommands, loadPullConfig, PullCollectionError, safeError, type PullCollection, type PullTargets } from './github-api.js';
import { comparePulls, key, ownerOf, parseGitHubPull, parseGitHubRemote, type GitHubPullReference } from './github-model.js';
import { conversationSessions, defaultSources, type ConversationAgent, type ConversationSources } from './conversations.js';

export interface SessionReference { id: string; name: string; agent: ConversationAgent; adapter: Adapter }
export interface RepositorySession extends SessionReference {
  directory: string;
  branch?: string;
  archived?: boolean;
  lastActive?: string;
  /** True for a repository identified by this session's checkout; false for a linked PR's destination alone. */
  fromRepository: boolean;
  pulls: GitHubPullReference[];
}
export interface PullRequest {
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
  repository: string;
  author: string;
  headRepository?: string;
  headBranch?: string;
  updatedAt: string;
  reviewDecision: string;
  mergeable: string;
  ci: { state: string; passed: number; failed: number; pending: number; total: number };
  sessions?: SessionReference[];
  subscription?: 'session-pr' | 'session-branch' | 'session-repository' | 'manual';
}
export interface RepositoryEntry {
  repository: string;
  followed: boolean;
  choice?: 'follow' | 'mute';
  agents: ConversationAgent[];
  sessions: number;
  sources: RepositorySession[];
  /** Query the repository's PR list, in addition to its exact linked PRs. */
  allPulls: boolean;
  linkedPulls: number;
  authored: number;
  lastActive?: string;
  pulls: { internal: number; upstream: number };
}
export interface PullSnapshot {
  internal: PullRequest[];
  upstream: PullRequest[];
  hidden: { internal: number; upstream: number };
  repositories: RepositoryEntry[];
  refresh: { running: boolean; startedAt?: string; finishedAt?: string; lastSuccessAt?: string; error?: string };
  warnings: string[];
}
interface Involvement { repository: string; sources: RepositorySession[] }
interface Collected {
  internal: PullRequest[];
  upstream: PullRequest[];
  involved: Involvement[];
  localForks: string[];
  authors: string[];
  refresh: PullSnapshot['refresh'];
  warnings: string[];
}
const REFRESH_INTERVAL = 5 * 60_000;
const AGENTS: ConversationAgent[] = ['claude', 'codex', 'opencode'];
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const repositoryName = (value: unknown): value is string => typeof value === 'string' && parseGitHubRemote(`https://github.com/${value}`) === value;
const pullKey = (pull: { repository: string; number: number }): string => `${key(pull.repository)}#${pull.number}`;
function cachedPull(value: unknown): value is PullRequest {
  if (!isObject(value) || !isObject(value.ci)) return false;
  const ci = value.ci;
  return Number.isInteger(value.number) && (value.number as number) > 0 && typeof value.isDraft === 'boolean'
    && ['url', 'title', 'repository', 'author', 'updatedAt', 'reviewDecision', 'mergeable'].every(field => typeof value[field] === 'string')
    && !!parseGitHubPull(value.url) && repositoryName(value.repository)
    && (value.headRepository === undefined || typeof value.headRepository === 'string')
    && (value.headBranch === undefined || typeof value.headBranch === 'string')
    && typeof ci.state === 'string' && ['passed', 'failed', 'pending', 'total'].every(field => Number.isInteger(ci[field]) && (ci[field] as number) >= 0);
}
function cachedSource(value: unknown): value is RepositorySession {
  return isObject(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.directory === 'string'
    && AGENTS.includes(value.agent as ConversationAgent) && ['claude-code', 'claude-desktop', 'codex', 'opencode'].includes(String(value.adapter))
    && typeof value.fromRepository === 'boolean' && (value.branch === undefined || typeof value.branch === 'string')
    && (value.archived === undefined || typeof value.archived === 'boolean') && (value.lastActive === undefined || timestamp(value.lastActive))
    && Array.isArray(value.pulls) && value.pulls.every(pull => isObject(pull) && repositoryName(pull.repository) && !!parseGitHubPull(pull.url) && Number.isSafeInteger(pull.number));
}
/** Account-wide caches predate session subscriptions and must never become subscription candidates. */
function cachedSnapshot(value: unknown): Collected | undefined {
  if (!isObject(value) || value.version !== 3 || !isObject(value.snapshot)) return;
  const snapshot = value.snapshot;
  if (!isObject(snapshot.refresh)) return;
  const refresh = snapshot.refresh;
  if (!Array.isArray(snapshot.internal) || !Array.isArray(snapshot.upstream) || snapshot.internal.length + snapshot.upstream.length > 50_000
    || ![...snapshot.internal, ...snapshot.upstream].every(cachedPull)
    || !Array.isArray(snapshot.involved) || snapshot.involved.length > 10_000
    || !snapshot.involved.every(entry => isObject(entry) && repositoryName(entry.repository) && Array.isArray(entry.sources) && entry.sources.every(cachedSource))
    || !Array.isArray(snapshot.localForks) || !snapshot.localForks.every(repositoryName)
    || !Array.isArray(snapshot.authors) || !snapshot.authors.every(author => typeof author === 'string')
    || typeof refresh.running !== 'boolean' || !['startedAt', 'finishedAt', 'lastSuccessAt'].every(field => refresh[field] === undefined || timestamp(refresh[field]))
    || (refresh.error !== undefined && typeof refresh.error !== 'string')
    || !Array.isArray(snapshot.warnings) || snapshot.warnings.length > 5000 || !snapshot.warnings.every(warning => typeof warning === 'string')) return;
  return snapshot as unknown as Collected;
}
async function writePrivate(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, name));
  } finally { await rm(temporary, { force: true }); }
}

/** Session -> linked PRs / repositories -> GitHub queries. No account-wide PR inventory defines subscriptions. */
export class PullRequestsService implements ServiceModule {
  readonly name = 'pulls';
  private current: Collected = { internal: [], upstream: [], involved: [], localForks: [], authors: [], refresh: { running: false }, warnings: [] };
  private readonly choices = new Map<string, { repository: string; follow: boolean }>();
  private choiceWrites: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private initializing?: Promise<void>;
  private work?: Promise<void>;
  private refreshQueued = false;
  private controller?: AbortController;
  private stopped = false;
  private started = false;
  constructor(private readonly directory: string, private readonly report: (record: Record<string, unknown>) => void = () => {},
    private readonly sources: ConversationSources = defaultSources(), private readonly collect: typeof collectPulls = collectPulls) {}

  status(): string {
    if (this.stopped) return 'stopped';
    if (this.work) return 'refreshing';
    if (this.current.refresh.error) return this.current.refresh.lastSuccessAt ? 'stale' : 'error';
    return this.current.refresh.lastSuccessAt ? 'ready' : 'idle';
  }
  repositories(): RepositoryEntry[] {
    const entries = new Map<string, RepositoryEntry>();
    const entry = (repository: string): RepositoryEntry => {
      let found = entries.get(key(repository));
      if (!found) {
        found = { repository, followed: false, agents: [], sessions: 0, sources: [], allPulls: false, linkedPulls: 0, authored: 0, pulls: { internal: 0, upstream: 0 } };
        entries.set(key(repository), found);
      }
      return found;
    };
    for (const item of this.current.involved) {
      const found = entry(item.repository);
      found.sources = [...item.sources].sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? '') || a.name.localeCompare(b.name));
      found.sessions = found.sources.length;
      found.agents = AGENTS.filter(agent => found.sources.some(source => source.agent === agent));
      found.allPulls = found.sources.some(source => source.fromRepository);
      found.linkedPulls = new Set(found.sources.flatMap(source => source.pulls.map(pullKey))).size;
      found.lastActive = found.sources.flatMap(source => source.lastActive ?? []).sort().at(-1);
    }
    // Retain deliberate choices from earlier runs, but never infer subscriptions from authors or global PR results.
    for (const choice of this.choices.values()) entry(choice.repository);
    const authors = new Set(this.current.authors.map(key));
    for (const queue of ['internal', 'upstream'] as const) for (const pull of this.current[queue]) {
      const found = entries.get(key(pull.repository));
      if (found) { found.pulls[queue]++; if (authors.has(key(pull.author))) found.authored++; }
    }
    for (const found of entries.values()) {
      const choice = this.choices.get(key(found.repository));
      if (choice) found.choice = choice.follow ? 'follow' : 'mute';
      found.followed = choice ? choice.follow : found.sources.length > 0;
      if (choice?.follow && !found.sources.length) found.allPulls = true;
    }
    return [...entries.values()].sort((a, b) => Number(b.followed) - Number(a.followed)
      || (b.lastActive ?? '').localeCompare(a.lastActive ?? '') || key(a.repository).localeCompare(key(b.repository)));
  }
  private tracked(pull: PullRequest, entry?: RepositoryEntry): boolean {
    return !!entry?.followed && (entry.allPulls || entry.sources.some(source => source.pulls.some(link => pullKey(link) === pullKey(pull))));
  }
  private associate(pull: PullRequest, entry: RepositoryEntry): PullRequest {
    const explicit = entry.sources.filter(source => source.pulls.some(link => pullKey(link) === pullKey(pull)));
    const branch = entry.sources.filter(source => source.fromRepository && source.branch && source.branch === pull.headBranch);
    const sources = explicit.length ? explicit : branch.length ? branch : entry.sources.filter(source => source.fromRepository);
    return { ...pull,
      sessions: sources.map(({ id, name, agent, adapter }) => ({ id, name, agent, adapter })),
      subscription: explicit.length ? 'session-pr' : branch.length ? 'session-branch' : sources.length ? 'session-repository' : 'manual' };
  }
  snapshot(): PullSnapshot {
    const repositories = this.repositories();
    const byName = new Map(repositories.map(entry => [key(entry.repository), entry]));
    const visible = (pulls: PullRequest[]) => pulls.filter(pull => this.tracked(pull, byName.get(key(pull.repository))))
      .map(pull => this.associate(pull, byName.get(key(pull.repository))!));
    const internal = visible(this.current.internal); const upstream = visible(this.current.upstream);
    return structuredClone({ internal, upstream, repositories, refresh: { ...this.current.refresh, running: Boolean(this.work) }, warnings: this.current.warnings,
      hidden: { internal: this.current.internal.length - internal.length, upstream: this.current.upstream.length - upstream.length } });
  }
  async setChoice(repository: string, follow: boolean | null): Promise<RepositoryEntry> {
    if (!repositoryName(repository)) throw new HttpError(400, 'Expected an owner/name GitHub repository');
    if (follow !== null && typeof follow !== 'boolean') throw new HttpError(400, 'follow must be true, false or null');
    const known = this.repositories().find(entry => key(entry.repository) === key(repository));
    const name = known?.repository ?? repository;
    const automatic = !!known?.sources.length;
    if (follow === null || follow === automatic) this.choices.delete(key(name)); else this.choices.set(key(name), { repository: name, follow });
    const snapshot = { version: 1, choices: [...this.choices.values()] };
    const pending = this.choiceWrites.catch(() => {}).then(() => writePrivate(this.directory, 'repo-preferences.json', snapshot));
    this.choiceWrites = pending; await pending;
    if (this.started && !this.stopped) {
      if (this.work) this.refreshQueued = true; else this.refresh();
    }
    return this.repositories().find(entry => key(entry.repository) === key(name))
      ?? { repository: name, followed: false, sources: [], sessions: 0, agents: [], allPulls: false, linkedPulls: 0, authored: 0, pulls: { internal: 0, upstream: 0 } };
  }
  /** What an exported configuration carries: the pulls configuration as written, and deliberate follow choices. */
  async preferences(): Promise<{ config?: unknown; follow: { repository: string; follow: boolean }[] }> {
    const { source } = await loadPullConfig(this.directory);
    return { ...(source === 'defaults' ? {} : { config: JSON.parse(await readFile(source, 'utf8')) as unknown }), follow: [...this.choices.values()] };
  }
  /** `follow` replaces every saved choice. Both values are validated by the caller. */
  async restore(preferences: { config?: unknown; follow?: { repository: string; follow: boolean }[] }): Promise<void> {
    if (preferences.config !== undefined) await writePrivate(this.directory, 'pulls.config.json', preferences.config);
    if (preferences.follow) {
      this.choices.clear();
      for (const choice of preferences.follow) this.choices.set(key(choice.repository), choice);
      const snapshot = { version: 1, choices: [...this.choices.values()] };
      const pending = this.choiceWrites.catch(() => {}).then(() => writePrivate(this.directory, 'repo-preferences.json', snapshot));
      this.choiceWrites = pending; await pending;
    }
    if (this.started && !this.stopped) {
      if (this.work) this.refreshQueued = true; else this.refresh();
    }
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
        const cached = cachedSnapshot(JSON.parse(await readFile(path, 'utf8')));
        if (cached) {
          await chmod(path, 0o600); this.current = cached; this.current.refresh.running = false;
          this.current.internal.sort(comparePulls); this.current.upstream.sort(comparePulls);
        } else this.current.warnings.push('Rebuilding subscriptions from session metadata; the earlier account-wide cache is not used.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.current.warnings.push(`Could not load session PR cache: ${safeError(error)}`); }
      await this.loadChoices();
    } catch (error) { this.current.warnings.push(`Could not prepare session PR cache: ${safeError(error)}`); }
    if (this.stopped) return;
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL); this.timer.unref(); this.refresh();
  }
  private async loadChoices(): Promise<void> {
    let value: unknown;
    try {
      const path = join(this.directory, 'repo-preferences.json');
      if ((await stat(path)).size > 1024 * 1024) throw new Error('Repository preferences exceed 1 MiB.');
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.current.warnings.push(`Could not load repository choices: ${safeError(error)}`);
      return;
    }
    const choices = isObject(value) && value.version === 1 && Array.isArray(value.choices) ? value.choices : undefined;
    if (!choices?.every(choice => isObject(choice) && repositoryName(choice.repository) && typeof choice.follow === 'boolean')) {
      this.current.warnings.push('Ignored invalid repository follow choices.'); return;
    }
    this.choices.clear();
    for (const choice of choices as { repository: string; follow: boolean }[]) this.choices.set(key(choice.repository), choice);
  }
  refresh(): void {
    if (this.stopped || this.work) return;
    const controller = new AbortController(); this.controller = controller;
    this.current.refresh = { ...this.current.refresh, running: true, startedAt: new Date().toISOString() };
    delete this.current.refresh.error;
    this.work = this.update(controller.signal).finally(() => {
      this.work = undefined; if (this.controller === controller) this.controller = undefined;
      if (this.refreshQueued && !this.stopped) { this.refreshQueued = false; this.refresh(); }
    });
  }
  private async discover(commands: GitHubCommands, signal: AbortSignal): Promise<{ involved: Involvement[]; localForks: string[]; warnings: string[] }> {
    const found = await conversationSessions(this.sources);
    const involved = new Map<string, Map<string, RepositorySession>>();
    const names = new Map<string, string>();
    const localForks = new Set<string>();
    for (const session of found.sessions) {
      signal.throwIfAborted();
      const repositories = new Map<string, string>();
      const origin = session.origin ? parseGitHubRemote(session.origin) : undefined;
      if (origin) repositories.set(key(origin), origin);
      for (const directory of session.directories) {
        try {
          const remotes = await commands.remotes(directory);
          for (const remote of remotes) repositories.set(key(remote.repository), remote.repository);
          const origin = remotes.find(remote => key(remote.name) === 'origin');
          if (origin && remotes.some(remote => /^upstream(?:[-_].*)?$/i.test(remote.name) && key(remote.repository) !== key(origin.repository))) localForks.add(origin.repository);
        } catch { signal.throwIfAborted(); /* Removed worktrees still contribute explicit PR links and recorded origins. */ }
      }
      const related = new Map(repositories);
      for (const pull of session.pulls) related.set(key(pull.repository), pull.repository);
      for (const [repoKey, repository] of related) {
        names.set(repoKey, repository);
        let sources = involved.get(repoKey);
        if (!sources) { sources = new Map(); involved.set(repoKey, sources); }
        sources.set(`${session.adapter}:${session.id}`, { id: session.id, name: session.title, agent: session.agent, adapter: session.adapter,
          directory: session.directory, branch: session.branch, archived: session.archived, lastActive: session.lastActive,
          fromRepository: repositories.has(repoKey), pulls: session.pulls.filter(pull => key(pull.repository) === repoKey) });
      }
    }
    return { involved: [...involved.entries()].map(([id, sources]) => ({ repository: names.get(id)!, sources: [...sources.values()] })),
      localForks: [...localForks], warnings: [...found.warnings, `Subscriptions: ${found.sessions.length} local sessions; ${involved.size} related repositories. PR targets come from persisted session links and those sessions' repositories.`] };
  }
  private targets(): PullTargets {
    const entries = this.repositories().filter(entry => entry.followed);
    const pulls = new Map(entries.flatMap(entry => entry.sources.flatMap(source => source.pulls.map(pull => [pullKey(pull), { repository: pull.repository, number: pull.number }] as const))));
    return { repositories: entries.filter(entry => entry.allPulls).map(entry => entry.repository), pulls: [...pulls.values()], localForks: this.current.localForks };
  }
  private async update(signal: AbortSignal): Promise<void> {
    const commands = new GitHubCommands(this.directory, signal);
    try {
      const loaded = await loadPullConfig(this.directory);
      const discovered = await this.discover(commands, signal);
      signal.throwIfAborted();
      this.current.involved = discovered.involved; this.current.localForks = discovered.localForks;
      const collected = await this.collect(loaded.config, commands, signal, this.targets());
      signal.throwIfAborted();
      const warnings = [...loaded.warnings, ...discovered.warnings, ...collected.warnings];
      this.retainUncoveredCache(collected, warnings);
      const now = new Date().toISOString();
      this.current = { ...this.current, internal: collected.internal.sort(comparePulls), upstream: collected.upstream.sort(comparePulls), authors: collected.scope.authors,
        refresh: { running: false, startedAt: this.current.refresh.startedAt, finishedAt: now, lastSuccessAt: now }, warnings: [...new Set(warnings)] };
      try { await writePrivate(this.directory, 'pulls-cache.json', { version: 3, snapshot: this.current }); }
      catch (error) { this.current.warnings.push(`Session PR cache was not saved: ${safeError(error)}`); }
      const visible = this.snapshot();
      this.emit({ source: 'pulls', status: 'refresh_completed', reason: `会话订阅：我们仓库 ${visible.internal.length} 个、上游 ${visible.upstream.length} 个；来源仓库 ${visible.repositories.length} 个` });
    } catch (error) {
      this.current.refresh = { ...this.current.refresh, running: false, finishedAt: new Date().toISOString(), ...(signal.aborted ? {} : { error: safeError(error) }) };
      if (!signal.aborted) {
        this.current.warnings = [...new Set([...this.current.warnings, ...(error instanceof PullCollectionError ? error.warnings : []), 'Refresh failed; displaying the last good session-scoped PR snapshot.'])];
        this.emit({ source: 'pulls', status: 'refresh_failed', error: safeError(error) });
      }
    } finally { await commands.stop(); }
  }
  private retainUncoveredCache(result: PullCollection, warnings: string[]): void {
    const entries = new Map(this.repositories().map(entry => [key(entry.repository), entry]));
    const owned = new Set(result.scope.ownedOwners.map(key)); const excluded = new Set(result.scope.excludeRepositories.map(key));
    const authors = new Set(result.scope.authors.map(key)); const forks = new Set((result.scope.localForks ?? []).map(key));
    const observed = new Set(result.observedUrls);
    for (const queue of ['internal', 'upstream'] as const) {
      if (!(queue === 'internal' ? result.incompleteInternal : result.incompleteUpstream)) continue;
      const urls = new Set(result[queue].map(pr => key(pr.url))); let retained = 0;
      for (const pr of this.current[queue]) {
        const entry = entries.get(key(pr.repository));
        if (!this.tracked(pr, entry) || urls.has(key(pr.url)) || observed.has(key(pr.url)) || excluded.has(key(pr.repository))) continue;
        const internal = owned.has(key(ownerOf(pr.repository)));
        const explicit = entry!.sources.some(source => source.pulls.some(link => pullKey(link) === pullKey(pr)));
        const outgoing = (!pr.headRepository || key(pr.headRepository) !== key(pr.repository))
          && (authors.has(key(pr.author)) || pr.headRepository && (owned.has(key(ownerOf(pr.headRepository))) || forks.has(key(pr.headRepository))));
        if (queue === 'internal' ? !internal : internal || !(explicit || outgoing)) continue;
        result[queue].push(pr); urls.add(key(pr.url)); retained++;
      }
      if (retained) warnings.push(`Incomplete ${queue} coverage: retained ${retained} previously scoped PRs; they may have changed since the last complete refresh.`);
    }
  }
  private emit(record: Record<string, unknown>): void { try { this.report(record); } catch { /* Reporting must not break refreshes. */ } }
  async stop(): Promise<void> {
    this.stopped = true; this.refreshQueued = false;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.controller?.abort(); await this.initializing; await this.work; await this.choiceWrites.catch(() => {});
    this.started = false; this.initializing = undefined; this.current.refresh.running = false;
  }
  async handle(request: RouteRequest): Promise<RouteResponse | undefined> {
    if (request.method === 'GET' && request.path === '/v1/pulls') return { body: this.snapshot() };
    if (request.method === 'POST' && request.path === '/v1/pulls/refresh') { this.refresh(); return { status: 202, body: this.snapshot() }; }
    if (request.method === 'GET' && request.path === '/v1/repos') return { body: this.repositories() };
    const match = /^\/v1\/repos\/([^/]+)\/([^/]+)$/.exec(request.path);
    if (match && request.method === 'PUT') return { body: await this.setChoice(`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`, object(request.body).follow as boolean | null) };
  }
}
