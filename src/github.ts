import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RouteRequest, RouteResponse, ServiceModule } from './types.js';
import { collectPulls, GitHubCommands, loadPullConfig, PullCollectionError, safeError, type PullCollection } from './github-api.js';
import { comparePulls, key, ownerOf } from './github-model.js';

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
export interface PullSnapshot {
  internal: PullRequest[];
  upstream: PullRequest[];
  refresh: { running: boolean; startedAt?: string; finishedAt?: string; lastSuccessAt?: string; error?: string };
  warnings: string[];
}
const REFRESH_INTERVAL = 5 * 60_000;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function cachedPull(value: unknown): value is PullRequest {
  if (!object(value) || !object(value.ci)) return false;
  const ci = value.ci;
  return Number.isInteger(value.number) && (value.number as number) > 0 && typeof value.isDraft === 'boolean'
    && ['url', 'title', 'repository', 'author', 'updatedAt', 'reviewDecision', 'mergeable'].every(field => typeof value[field] === 'string')
    && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(value.url as string)
    && (value.headRepository === undefined || typeof value.headRepository === 'string')
    && typeof value.ci.state === 'string' && ['passed', 'failed', 'pending', 'total'].every(field => Number.isInteger(ci[field]) && (ci[field] as number) >= 0);
}
function cachedSnapshot(value: unknown): value is { version: 1; snapshot: PullSnapshot } {
  if (!object(value) || value.version !== 1 || !object(value.snapshot)) return false;
  const snapshot = value.snapshot;
  if (!object(snapshot.refresh)) return false;
  const refresh = snapshot.refresh;
  return Array.isArray(snapshot.internal) && Array.isArray(snapshot.upstream)
    && snapshot.internal.length + snapshot.upstream.length <= 50_000 && [...snapshot.internal, ...snapshot.upstream].every(cachedPull)
    && typeof refresh.running === 'boolean'
    && ['startedAt', 'finishedAt', 'lastSuccessAt'].every(field => refresh[field] === undefined || timestamp(refresh[field]))
    && (refresh.error === undefined || typeof refresh.error === 'string')
    && Array.isArray(snapshot.warnings) && snapshot.warnings.length <= 5000 && snapshot.warnings.every(warning => typeof warning === 'string');
}

/** Read-only GitHub module; the host owns HTTP authentication and calls start()/stop(). */
export class PullRequestsService implements ServiceModule {
  readonly name = 'pulls';
  private current: PullSnapshot = { internal: [], upstream: [], refresh: { running: false }, warnings: ['GitHub has not refreshed yet.'] };
  private timer?: ReturnType<typeof setInterval>;
  private initializing?: Promise<void>;
  private work?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;
  private started = false;
  constructor(private readonly directory: string, private readonly report: (record: Record<string, unknown>) => void = () => {}) {}

  status(): string {
    if (this.stopped) return 'stopped';
    if (this.current.refresh.running) return 'refreshing';
    if (this.current.refresh.error) return this.current.refresh.lastSuccessAt ? 'stale' : 'error';
    return this.current.refresh.lastSuccessAt ? 'ready' : 'idle';
  }
  snapshot(): PullSnapshot { return structuredClone(this.current); }
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
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!cachedSnapshot(value)) throw new Error('Invalid pulls cache.');
        await chmod(path, 0o600);
        this.current = value.snapshot;
        this.current.refresh.running = false;
        this.current.internal.sort(comparePulls); this.current.upstream.sort(comparePulls);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.current.warnings = [`Could not load private pulls cache: ${safeError(error)}`];
      }
    } catch (error) { this.current.warnings = [`Could not prepare private pulls cache: ${safeError(error)}`]; }
    if (this.stopped) return;
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL); this.timer.unref();
    this.refresh();
  }
  /** Coalesce repeated refreshes into the running operation; never await GitHub in an HTTP request. */
  refresh(): void {
    if (this.stopped || this.work) return;
    const controller = new AbortController(); this.controller = controller;
    this.current.refresh = { ...this.current.refresh, running: true, startedAt: new Date().toISOString() };
    delete this.current.refresh.error;
    this.work = this.update(controller.signal).finally(() => { this.work = undefined; if (this.controller === controller) this.controller = undefined; });
  }
  private async update(signal: AbortSignal): Promise<void> {
    const commands = new GitHubCommands(this.directory, signal);
    let configWarnings: string[] = [];
    try {
      const loaded = await loadPullConfig(this.directory); configWarnings = loaded.warnings;
      signal.throwIfAborted();
      const collected = await collectPulls(loaded.config, commands, signal);
      signal.throwIfAborted();
      const warnings = [...loaded.warnings, ...collected.warnings];
      this.retainUncoveredCache(collected, warnings);
      const now = new Date().toISOString();
      this.current = {
        internal: collected.internal.sort(comparePulls), upstream: collected.upstream.sort(comparePulls),
        refresh: { running: false, startedAt: this.current.refresh.startedAt, finishedAt: now, lastSuccessAt: now },
        warnings: [...new Set(warnings)],
      };
      try { await this.persist(); }
      catch (error) { this.current.warnings.push(`GitHub refresh succeeded but the private cache was not saved: ${safeError(error)}`); }
      this.emit({ source: 'pulls', status: 'refresh_completed', reason: `我们仓库 ${this.current.internal.length} 个、提交上游 ${this.current.upstream.length} 个；配置：${loaded.source}` });
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
  private async persist(): Promise<void> {
    const temporary = join(this.directory, `.pulls-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, snapshot: this.current }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(this.directory, 'pulls-cache.json'));
    } finally { await rm(temporary, { force: true }); }
  }
  private emit(record: Record<string, unknown>): void { try { this.report(record); } catch { /* Reporting must not break the module lifecycle. */ } }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.controller?.abort();
    await this.initializing;
    await this.work;
    this.started = false; this.initializing = undefined;
    this.current.refresh.running = false;
  }
  async handle(request: RouteRequest): Promise<RouteResponse | undefined> {
    if (request.method === 'GET' && request.path === '/v1/pulls') return { body: this.snapshot() };
    if (request.method === 'POST' && request.path === '/v1/pulls/refresh') {
      this.refresh(); return { status: 202, body: this.snapshot() };
    }
  }
}
