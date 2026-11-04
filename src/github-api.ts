import { execFile, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { PullRequest } from './github.js';
import { classifyPull, comparePulls, key, normalizePull, ownerOf, parseGitHubRemote, unique, type GitHubPull, type PullScope } from './github-model.js';

const BASE_FIELDS = `id number url title state isDraft isCrossRepository headRefName updatedAt
  author { login } repository { nameWithOwner } headRepository { nameWithOwner }`;
const DETAIL_FIELDS = `id state updatedAt mergeable reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes {
    __typename ... on CheckRun { status conclusion } ... on StatusContext { state }
  } } } } } }
  reviews(last: 30) { totalCount nodes { author { login } state submittedAt } }`;
const expandHome = (path: string): string => path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export interface PullConfig {
  authors: string[];
  ownedOwners: string[];
  upstreamOwners: string[];
  excludeRepositories: string[];
  scanRoots: string[];
  maxScanDepth: number;
  maxSearchPages: number;
  maxForkPages: number;
  maxUpstreamPages: number;
  /** Repositories without an explicit choice are followed when we are involved in them, or always. */
  followDefault: 'involved' | 'all';
}
export function parsePullConfig(value: unknown): PullConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pulls configuration must be a JSON object.');
  const input = value as Record<string, unknown>;
  function logins(name: string): string[] {
    const list = input[name] ?? [];
    if (!Array.isArray(list) || list.length > 100 || list.some(item => typeof item !== 'string' || !/^[a-z\d][a-z\d-]*(?:\[bot\])?$/i.test(item))) {
      throw new Error(`${name} must contain at most 100 GitHub logins.`);
    }
    return unique(list);
  }
  function integer(name: string, fallback: number, min: number, max: number): number {
    const number = input[name] ?? fallback;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min) throw new Error(`${name} must be an integer >= ${min}.`);
    return Math.min(number, max);
  }
  const excluded = input.excludeRepositories ?? [];
  if (!Array.isArray(excluded) || excluded.length > 1000 || excluded.some(item => typeof item !== 'string' || parseGitHubRemote(`https://github.com/${item}`) !== item)) {
    throw new Error('excludeRepositories must contain owner/repository names.');
  }
  const roots = input.scanRoots ?? [];
  if (!Array.isArray(roots) || roots.length > 100 || roots.some(item => typeof item !== 'string' || !item || !isAbsolute(expandHome(item)))) {
    throw new Error('scanRoots must contain absolute paths or ~/ paths.');
  }
  const followDefault = input.followDefault ?? 'involved';
  if (followDefault !== 'involved' && followDefault !== 'all') throw new Error('followDefault must be "involved" or "all".');
  return {
    followDefault,
    authors: logins('authors'), ownedOwners: logins('ownedOwners'), upstreamOwners: logins('upstreamOwners'),
    excludeRepositories: unique(excluded), scanRoots: [...new Set(roots.map(path => resolve(expandHome(path))))],
    maxScanDepth: integer('maxScanDepth', 6, 0, 20), maxSearchPages: integer('maxSearchPages', 10, 1, 10),
    maxForkPages: integer('maxForkPages', 3, 1, 10), maxUpstreamPages: integer('maxUpstreamPages', 10, 1, 10),
  };
}

/** Optional configuration is read as data from the state directory or NOOTIFY_PULLS_CONFIG. */
export async function loadPullConfig(directory: string): Promise<{ config: PullConfig; source: string; warnings: string[] }> {
  const explicit = process.env.NOOTIFY_PULLS_CONFIG?.trim();
  const candidates = explicit ? [resolve(expandHome(explicit))] : [join(directory, 'pulls.config.json')];
  for (const path of candidates) {
    let text: string;
    try {
      if ((await stat(path)).size > 1024 * 1024) throw new Error('Pulls configuration exceeds 1 MiB.');
      text = await readFile(path, 'utf8');
    } catch (error) { if (!explicit && isMissing(error)) continue; throw new Error(`Cannot read pulls configuration ${path}: ${safeError(error)}`); }
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new Error(`Invalid JSON in pulls configuration ${path}.`); }
    const warnings: string[] = [];
    if ((input as Record<string, unknown>)?.refreshMinutes !== undefined && (input as Record<string, unknown>).refreshMinutes !== 5) {
      warnings.push('The pulls service refreshes every 5 minutes; legacy refreshMinutes is ignored.');
    }
    return { config: parsePullConfig(input), source: path, warnings };
  }
  return { config: parsePullConfig({}), source: 'defaults', warnings: [] };
}

export function safeError(error: unknown): string {
  const value = error as { stderr?: string; message?: string; killed?: boolean; code?: unknown };
  return (value?.killed || value?.code === 'ETIMEDOUT' ? 'Read-only command exceeded its timeout.' : String(value?.stderr || value?.message || error))
    .replace(/https?:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, 'https://[redacted]@')
    .replace(/(?:gh[pousr]_[a-z\d_]+|github_pat_[a-z\d_]+)/gi, '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/\s+/g, ' ').trim().slice(0, 700);
}

export const ghEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_HOST: 'github.com' });

/** Own subprocesses so stop() can cancel network work and reap unresponsive children. */
export class GitHubCommands {
  private readonly children = new Set<ChildProcess>();
  private readonly closed = new Map<ChildProcess, Promise<void>>();
  private gh?: string;
  private readonly remoteCache = new Map<string, Promise<{ name: string; repository: string }[]>>();
  constructor(private readonly directory: string, private readonly signal: AbortSignal) {}
  private async run(file: string, args: string[], timeout = 30_000): Promise<string> {
    this.signal.throwIfAborted();
    return new Promise((accept, reject) => {
      const child = execFile(file, args, {
        cwd: this.directory, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, signal: this.signal, env: ghEnvironment(),
      }, (error, stdout, stderr) => {
        if (error) { Object.assign(error, { stdout, stderr }); reject(error); }
        else accept(stdout);
      });
      this.children.add(child);
      this.closed.set(child, new Promise(done => child.once('close', () => { this.children.delete(child); this.closed.delete(child); done(); })));
    });
  }
  async findGh(): Promise<string> {
    if (this.gh) return this.gh;
    const explicit = process.env.GH_BIN?.trim();
    const paths = (process.env.PATH ?? '').split(':').filter(path => isAbsolute(path));
    const candidates = explicit ? [resolve(expandHome(explicit))] : unique([
      '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh', ...paths.map(path => join(path, 'gh')),
    ]);
    const failures: string[] = [];
    for (const path of candidates) {
      this.signal.throwIfAborted();
      try {
        await access(path, constants.X_OK);
        if (!(await stat(path)).isFile()) continue;
        const version = await this.run(path, ['--version'], 5000);
        if (!/^gh version \d/m.test(version)) throw new Error('Executable did not identify itself as GitHub CLI.');
        this.gh = path; return path;
      } catch (error) {
        this.signal.throwIfAborted();
        if (!isMissing(error)) failures.push(`${path}: ${safeError(error)}`);
      }
    }
    throw new Error(`GitHub CLI is unavailable${explicit ? ` at GH_BIN=${explicit}` : '; checked Homebrew and standard executable paths'}. Install/authenticate gh or set an absolute GH_BIN.${failures.length ? ` ${failures.join('; ')}` : ''}`);
  }
  async graphql(query: string, variables: Record<string, string | number | null> = {}, partial = false): Promise<{ data: Record<string, any>; errors?: { message: string; path?: (string | number)[] }[] }> {
    if (!/^\s*query\s/.test(query)) throw new Error('Only read-only GitHub queries are allowed.');
    const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables)) args.push(value === null || typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
    let output: string;
    try { output = await this.run(await this.findGh(), args); }
    catch (error) {
      this.signal.throwIfAborted();
      if (!partial || !(error as { stdout?: string }).stdout) throw error;
      output = (error as { stdout: string }).stdout;
    }
    let response;
    try { response = JSON.parse(output); } catch { throw new Error('GitHub CLI returned invalid JSON.'); }
    if (!response?.data || response.errors?.length && !partial) {
      throw new Error(response.errors?.map((error: { message: string }) => error.message).join('; ') || 'GitHub returned no query data.');
    }
    return response;
  }
  /** Remotes are read at most once per directory per refresh; conversation and disk scans share them. */
  remotes(directory: string): Promise<{ name: string; repository: string }[]> {
    let pending = this.remoteCache.get(directory);
    if (!pending) { pending = this.readRemotes(directory); this.remoteCache.set(directory, pending); }
    return pending;
  }
  private async readRemotes(directory: string): Promise<{ name: string; repository: string }[]> {
    const git = process.platform === 'darwin' ? '/usr/bin/git' : 'git';
    let stdout: string;
    try { stdout = await this.run(git, ['-C', directory, 'config', '--local', '--get-regexp', '^remote\\..*\\.url$'], 10_000); }
    catch (error) {
      if ((error as { code?: number; stderr?: string }).code === 1 && !(error as { stderr?: string }).stderr?.trim()) return [];
      throw error;
    }
    return stdout.split(/\r?\n/).flatMap(line => {
      const match = /^remote\.(.+)\.url\s+(.+)$/i.exec(line);
      const repository = match && parseGitHubRemote(match[2]);
      return match && repository ? [{ name: match[1], repository }] : [];
    });
  }
  async stop(): Promise<void> {
    const children = [...this.children];
    for (const child of children) child.kill('SIGTERM');
    const kill = setTimeout(() => { for (const child of children) if (this.children.has(child)) child.kill('SIGKILL'); }, 1000);
    try { await Promise.all(children.map(child => this.closed.get(child))); } finally { clearTimeout(kill); }
  }
}

interface Connection<T> { nodes: (T | null)[]; totalCount?: number; issueCount?: number; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
function connection<T>(value: unknown, source: string): Connection<T> {
  const result = value as Connection<T>;
  if (!result || !Array.isArray(result.nodes) || typeof result.pageInfo?.hasNextPage !== 'boolean' || !Number.isFinite(result.totalCount ?? result.issueCount)) {
    throw new Error(`GitHub omitted the ${source} connection; check account permissions.`);
  }
  return result;
}
function limiter(concurrency: number): <T>(operation: () => Promise<T>) => Promise<T> {
  let active = 0; const waiting: (() => void)[] = [];
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>(accept => waiting.push(accept)); else active++;
    try { return await operation(); } finally { if (waiting.length) waiting.shift()!(); else active--; }
  };
}
export class PullCollectionError extends Error {
  constructor(message: string, readonly warnings: string[]) { super(message); }
}
export interface PullCollection {
  internal: PullRequest[]; upstream: PullRequest[]; warnings: string[]; scope: PullScope;
  incompleteInternal: boolean; incompleteUpstream: boolean; observedUrls: string[];
}

export interface PullTarget { repository: string; number: number }
export interface PullTargets { repositories: string[]; pulls: PullTarget[]; localForks?: string[] }

/** Collect only repositories and exact PRs discovered by the caller's agent sessions. */
export async function collectPulls(config: PullConfig, commands: GitHubCommands, signal: AbortSignal, targets: PullTargets = { repositories: [], pulls: [] }): Promise<PullCollection> {
  const warnings = new Set<string>(); const failures: string[] = [];
  const warn = (message: string): void => { warnings.add(safeError(new Error(message))); };
  const limit = limiter(4);
  const graphql = (query: string, variables: Record<string, string | number | null> = {}, partial = false) => limit(async () => {
    signal.throwIfAborted(); const result = await commands.graphql(query, variables, partial); signal.throwIfAborted(); return result;
  });
  let incompleteInternal = false; let incompleteUpstream = false;
  async function pages<T>(source: string, maximum: number, fetch: (cursor: string | null) => Promise<unknown>, receive: (node: T) => void): Promise<boolean> {
    let cursor: string | null = null; let scanned = 0; let total = 0; let more = false;
    for (let index = 0; index < maximum; index++) {
      signal.throwIfAborted();
      const result: Connection<T> = connection<T>(await fetch(cursor), source);
      total = Math.max(total, result.totalCount ?? result.issueCount!); scanned += result.nodes.length;
      for (const node of result.nodes) {
        if (!node) { more = true; warn(`${source}: a node was not visible; source coverage is incomplete.`); continue; }
        receive(node);
      }
      if (!result.pageInfo.hasNextPage) {
        if (total > scanned) { more = true; warn(`${source}: inspected ${scanned} of ${total} records; the list changed or inaccessible records were omitted.`); }
        return more;
      }
      if (!result.pageInfo.endCursor || result.pageInfo.endCursor === cursor) throw new Error(`${source}: GitHub pagination did not advance.`);
      cursor = result.pageInfo.endCursor;
    }
    warn(`${source}: truncated at ${scanned} of ${total} records (${maximum} pages).`);
    return true;
  }
  const owners = new Map<string, string>(); let viewer = '';
  try {
    await pages<{ login: string }>('organizations', 10, async cursor => {
      const { data } = await graphql(`query PullViewer($cursor: String) {
        viewer { login organizations(first: 100, after: $cursor) { totalCount nodes { login } pageInfo { hasNextPage endCursor } } }
      }`, { cursor });
      if (!data.viewer?.login) throw new Error('GitHub did not return the authenticated viewer.');
      viewer = data.viewer.login;
      return data.viewer.organizations;
    }, org => {
      if (!config.upstreamOwners.some(owner => key(owner) === key(org.login))) owners.set(key(org.login), org.login);
    }).then(incomplete => { incompleteInternal ||= incomplete; incompleteUpstream ||= incomplete; });
  } catch (error) {
    signal.throwIfAborted(); throw new PullCollectionError(`Cannot establish GitHub viewer and internal organizations: ${safeError(error)}`, [...warnings]);
  }
  owners.set(key(viewer), viewer);
  for (const login of config.ownedOwners) if (!owners.has(key(login))) owners.set(key(login), login);
  const scope: PullScope = { authors: unique([viewer, ...config.authors]), ownedOwners: [...owners.values()], excludeRepositories: config.excludeRepositories, localForks: unique(targets.localForks ?? []) };
  const owned = new Set(scope.ownedOwners.map(key)); const excluded = new Set(scope.excludeRepositories.map(key));
  const retained = new Map<string, GitHubPull>(); const observedUrls = new Set<string>(); const linkedUrls = new Set<string>();
  function classify(pr: GitHubPull): 'internal' | 'upstream' | undefined {
    if (!linkedUrls.has(key(pr.url))) return classifyPull(pr, scope);
    if (pr.state !== 'OPEN' || excluded.has(key(pr.repository.nameWithOwner))) return;
    return owned.has(key(ownerOf(pr.repository.nameWithOwner))) ? 'internal' : 'upstream';
  }
  function retain(pr: GitHubPull, linked = false): void {
    if (typeof pr.id !== 'string' || !pr.id || typeof pr.url !== 'string' || typeof pr.title !== 'string'
      || typeof pr.repository?.nameWithOwner !== 'string' || !pr.repository.nameWithOwner || typeof pr.state !== 'string'
      || typeof pr.updatedAt !== 'string' || !Number.isInteger(pr.number) || pr.number < 1) throw new Error('GitHub returned an incomplete pull request.');
    const url = key(pr.url); observedUrls.add(url);
    // Exact links decide subscription and state even if a repository page saw an earlier open version.
    if (linked) linkedUrls.add(url); else if (linkedUrls.has(url)) return;
    const previous = retained.get(url);
    if (linked || !previous || pr.updatedAt >= previous.updatedAt) {
      if (classify(pr)) retained.set(url, pr); else retained.delete(url);
    }
  }
  const source = async (name: string, operation: () => Promise<void>): Promise<void> => {
    try { await operation(); }
    catch (error) { signal.throwIfAborted(); const message = `${name}: ${safeError(error)}`; failures.push(message); warn(`${message} Coverage for this source failed; the last good snapshot is retained.`); }
  };
  const repositories = unique(targets.repositories).filter(repository => !excluded.has(key(repository)));
  const pulls = [...new Map(targets.pulls.filter(pr => !excluded.has(key(pr.repository)))
    .map(pr => [`${key(pr.repository)}#${pr.number}`, pr])).values()];
  await Promise.all([
    ...repositories.map(repository => source(`repository:${repository}`, async () => {
      const [owner, name] = repository.split('/');
      const incomplete = await pages<GitHubPull>(`repository:${repository}`, config.maxUpstreamPages, async cursor => {
        const { data } = await graphql(`query PullRepository($owner: String!, $name: String!, $cursor: String) {
          repository(owner: $owner, name: $name) { pullRequests(states: [OPEN], first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: ASC}) {
            totalCount nodes { ${BASE_FIELDS} } pageInfo { hasNextPage endCursor }
          } }
        }`, { owner, name, cursor }); return data.repository?.pullRequests;
      }, retain);
      if (owned.has(key(owner))) incompleteInternal ||= incomplete; else incompleteUpstream ||= incomplete;
    })),
    ...pulls.map(pr => source(`pull:${pr.repository}#${pr.number}`, async () => {
      const [owner, name] = pr.repository.split('/');
      const { data } = await graphql(`query PullTarget($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${BASE_FIELDS} } }
      }`, { owner, name, number: pr.number });
      if (!data.repository?.pullRequest) throw new Error('Linked pull request is inaccessible to the current account.');
      retain(data.repository.pullRequest, true);
    })),
  ]);
  if (failures.length) throw new PullCollectionError(`GitHub source collection failed: ${failures.join('; ')}`, [...warnings]);
  const entries = [...retained.values()];
  const batches: GitHubPull[][] = [];
  for (let offset = 0; offset < entries.length; offset += 8) batches.push(entries.slice(offset, offset + 8));
  await Promise.all(batches.map(async batch => {
    try {
      const definitions = batch.map((_, index) => `$id${index}: ID!`).join(', ');
      const fields = batch.map((_, index) => `p${index}: node(id: $id${index}) { ... on PullRequest { ${DETAIL_FIELDS} } }`).join('\n');
      const variables = Object.fromEntries(batch.map((pr, index) => [`id${index}`, pr.id]));
      const { data, errors = [] } = await graphql(`query PullDetails(${definitions}) { ${fields} }`, variables, true);
      batch.forEach((pr, index) => {
        const detail = data[`p${index}`];
        const errorsForPull = errors.filter(error => !error.path?.length || error.path[0] === `p${index}`);
        if (detail?.id === pr.id && ['OPEN', 'CLOSED', 'MERGED'].includes(detail.state)) pr.state = detail.state;
        const missing = ['mergeable', 'reviewDecision', 'commits', 'reviews'].filter(field => !detail || !Object.hasOwn(detail, field));
        if (detail?.id !== pr.id || errorsForPull.length || missing.length) {
          warn(`${pr.repository.nameWithOwner}#${pr.number}: review/merge/CI details unavailable; values are UNKNOWN. ${errorsForPull.map(error => error.message).join('; ')}${missing.length ? ` Missing fields: ${missing.join(', ')}.` : ''}`); return;
        }
        Object.assign(pr, detail);
      });
    } catch (error) { signal.throwIfAborted(); warn(`details: ${batch.length} PRs have UNKNOWN review/merge/CI values: ${safeError(error)}`); }
  }));
  const result: PullCollection = { internal: [], upstream: [], warnings: [], scope, incompleteInternal, incompleteUpstream, observedUrls: [...observedUrls] };
  for (const pr of entries) {
    const queue = classify(pr);
    if (queue) result[queue].push(normalizePull(pr, warn));
  }
  warn(`Source coverage: gh account ${viewer}; internal owners: ${scope.ownedOwners.sort().join(', ')}; outgoing authors: ${scope.authors.join(', ')} plus owned/local forks.`);
  warn('Only targeted github.com repositories and linked PRs visible to the authenticated gh account are covered; private repositories and organization SSO depend on its permissions.');
  warn('Organization memberships count as internal unless listed in upstreamOwners; explicit ownedOwners takes precedence. Linked open PRs are followed regardless of author or fork.');
  result.internal.sort(comparePulls); result.upstream.sort(comparePulls); result.warnings = [...warnings].sort();
  return result;
}
