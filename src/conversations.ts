import { createReadStream, type Dirent } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { key, parseGitHubPull, type GitHubPullReference } from './github-model.js';
import type { Adapter } from './types.js';

export type ConversationAgent = 'claude' | 'codex' | 'opencode';
export interface ConversationSession {
  id: string;
  agent: ConversationAgent;
  adapter: Adapter;
  title: string;
  directory: string;
  /** Current worktree, original checkout, and other repository anchors stored with this session. */
  directories: string[];
  branch?: string;
  origin?: string;
  archived?: boolean;
  lastActive?: string;
  pulls: GitHubPullReference[];
}
export interface ConversationDirectory { directory: string; agent: ConversationAgent; sessions: number; lastActive?: string; origin?: string }
export interface ConversationSources { claudeDir?: string; desktopRoots?: string[]; codexHome?: string; opencodeData?: string }

const HEAD_BYTES = 64 * 1024;
const MAX_METADATA = 1024 * 1024;
const MAX_SESSIONS = 10_000;
const isMissing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const path = (value: unknown): string | undefined => typeof value === 'string' && value.startsWith('/') ? value : undefined;
const iso = (milliseconds: number): string | undefined => Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : undefined;
const epoch = (value: unknown): number => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : NaN;
const uniquePulls = (pulls: GitHubPullReference[]): GitHubPullReference[] => [...new Map(pulls.map(pull => [`${key(pull.repository)}#${pull.number}`, pull])).values()];

export function defaultSources(env: NodeJS.ProcessEnv = process.env): Required<ConversationSources> {
  return {
    claudeDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    desktopRoots: ['Claude-3p', 'Claude'].map(app => join(homedir(), 'Library/Application Support', app, 'claude-code-sessions')),
    codexHome: env.CODEX_HOME ?? join(homedir(), '.codex'),
    opencodeData: join(env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode'),
  };
}

/** Read structured session metadata and explicit PR-link records, never infer subscriptions from message text. */
export async function conversationSessions(sources: ConversationSources = defaultSources(), options: { includeTranscripts?: boolean } = {}): Promise<{ sessions: ConversationSession[]; warnings: string[] }> {
  const warnings: string[] = [];
  const collect = async <T>(name: string, read: () => Promise<T[]>): Promise<T[]> => {
    try { return await read(); } catch (error) { warnings.push(`${name} session metadata could not be read: ${(error as Error).message}`); return []; }
  };
  const desktop = await collect('Claude Desktop', () => desktopSessions(sources.desktopRoots ?? []));
  const cliIds = new Map(desktop.flatMap(entry => entry.cliIds.map(id => [id, entry] as const)));
  const [claude, codex, opencode] = await Promise.all([
    sources.claudeDir ? collect('Claude Code', () => claudeSessions(sources.claudeDir!, cliIds, options.includeTranscripts !== false)) : [],
    sources.codexHome ? collect('Codex', () => codexSessions(sources.codexHome!)) : [],
    sources.opencodeData ? collect('OpenCode', () => opencodeSessions(sources.opencodeData!)) : [],
  ]);
  const all = [...desktop.map(entry => entry.session), ...claude, ...codex, ...opencode];
  return { sessions: [...new Map(all.map(session => [`${session.adapter}:${session.id}`, session])).values()], warnings };
}

/** Directory summary for callers that need counts; the individual identities are retained by conversationSessions(). */
export async function conversationDirectories(sources: ConversationSources = defaultSources()): Promise<{ directories: ConversationDirectory[]; warnings: string[] }> {
  const found = await conversationSessions(sources);
  const grouped = new Map<string, ConversationDirectory>();
  for (const session of found.sessions) {
    if (!session.directory) continue;
    const id = `${session.agent}:${session.directory}`;
    const entry = grouped.get(id) ?? { directory: session.directory, agent: session.agent, sessions: 0, origin: session.origin };
    entry.sessions++;
    if (session.lastActive && (!entry.lastActive || session.lastActive > entry.lastActive)) entry.lastActive = session.lastActive;
    grouped.set(id, entry);
  }
  return { directories: [...grouped.values()], warnings: found.warnings };
}

async function entries(directory: string): Promise<Dirent[]> {
  try { return await readdir(directory, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
}
async function metadata(file: string): Promise<{ value: Record<string, unknown>; modified: number } | undefined> {
  const info = await stat(file);
  if (info.size > MAX_METADATA) return;
  try {
    const value = object(JSON.parse(await readFile(file, 'utf8')));
    if (value) return { value, modified: info.mtimeMs };
  } catch (error) { if (error instanceof SyntaxError || isMissing(error)) return; throw error; }
}
function linkedPull(value: unknown): GitHubPullReference | undefined {
  const entry = object(value);
  if (!entry || (entry.host && entry.host !== 'github.com') || (entry.provider && entry.provider !== 'github')) return;
  return parseGitHubPull(entry.url ?? entry.prUrl)
    ?? (typeof (entry.repo ?? entry.prRepository) === 'string' && Number.isSafeInteger(entry.prNumber)
      ? parseGitHubPull(`https://github.com/${entry.repo ?? entry.prRepository}/pull/${entry.prNumber}`) : undefined);
}
interface DesktopEntry { session: ConversationSession; cliIds: string[]; authoritativePulls: boolean }
async function desktopSessions(roots: string[]): Promise<DesktopEntry[]> {
  const found = new Map<string, DesktopEntry>();
  for (const root of roots) for (const account of await entries(root)) {
    if (!account.isDirectory()) continue;
    for (const profile of await entries(join(root, account.name))) {
      if (!profile.isDirectory()) continue;
      const directory = join(root, account.name, profile.name);
      for (const file of await entries(directory)) {
        if (!file.isFile() || !/^local_[A-Za-z0-9_-]+\.json$/.test(file.name)) continue;
        const data = await metadata(join(directory, file.name));
        if (!data || typeof data.value.sessionId !== 'string' || data.value.sessionId !== file.name.slice(0, -5)) continue;
        const value = data.value;
        const directories = [...new Set([value.cwd, value.worktreePath, value.originCwd,
          ...(Array.isArray(value.gitAnchors) ? value.gitAnchors.map(anchor => object(anchor)?.gitRoot) : [])].map(path).filter((item): item is string => !!item))];
        const session: ConversationSession = {
          id: String(value.sessionId), agent: 'claude', adapter: 'claude-desktop',
          title: string(value.title) ?? string(value.name) ?? String(value.sessionId),
          directory: directories[0] ?? '', directories,
          ...(string(value.branch) ? { branch: String(value.branch) } : {}),
          ...(typeof value.isArchived === 'boolean' ? { archived: value.isArchived } : {}),
          lastActive: iso(data.modified), pulls: uniquePulls((Array.isArray(value.prs) ? value.prs : []).flatMap(pr => linkedPull(pr) ?? [])),
        };
        const current = found.get(session.id);
        if (current && (current.session.lastActive ?? '') > (session.lastActive ?? '')) continue;
        found.set(session.id, { session,
          cliIds: [value.cliSessionId, ...(Array.isArray(value.priorCliSessionIds) ? value.priorCliSessionIds : [])].filter((id): id is string => typeof id === 'string'),
          authoritativePulls: Array.isArray(value.prs) });
        if (found.size >= MAX_SESSIONS) return [...found.values()];
      }
    }
  }
  return [...found.values()];
}

interface TranscriptMeta { directory?: string; title?: string; branch?: string; pulls: GitHubPullReference[] }
const transcriptCache = new Map<string, { size: number; modified: number; meta: TranscriptMeta }>();
async function headText(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
export async function transcriptDirectory(file: string): Promise<string | undefined> {
  const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(await headText(file));
  if (match) return path(JSON.parse(`"${match[1]}"`));
}
async function transcriptMetadata(file: string, id: string): Promise<TranscriptMeta> {
  const info = await stat(file);
  const cached = transcriptCache.get(file);
  if (cached?.size === info.size && cached.modified === info.mtimeMs) return structuredClone(cached.meta);
  const text = await headText(file);
  const result: TranscriptMeta = { pulls: [] };
  const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (cwd) result.directory = path(JSON.parse(`"${cwd[1]}"`));
  for (const line of text.split('\n')) {
    try {
      const entry = object(JSON.parse(line));
      if (!entry) continue;
      result.branch ??= string(entry.gitBranch);
      if (entry.type === 'custom-title') result.title = string(entry.customTitle) ?? string(entry.title);
    } catch { /* A large first record may end outside the bounded header. */ }
  }
  // Only the standalone pr-link records are parsed. Raw messages and command output are not used as PR evidence.
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!/"type"\s*:\s*"pr-link"/.test(line)) continue;
      try {
        const event = object(JSON.parse(line));
        if (event?.type !== 'pr-link' || (event.sessionId && event.sessionId !== id)) continue;
        const pull = linkedPull(event);
        if (pull) result.pulls.push(pull);
      } catch { /* Interrupted writes are retried after the transcript changes. */ }
    }
  } finally { lines.close(); stream.destroy(); }
  result.pulls = uniquePulls(result.pulls);
  transcriptCache.set(file, { size: info.size, modified: info.mtimeMs, meta: structuredClone(result) });
  if (transcriptCache.size > MAX_SESSIONS) transcriptCache.delete(transcriptCache.keys().next().value!);
  return result;
}
async function claudeSessions(root: string, desktop: Map<string, DesktopEntry>, includeTranscripts: boolean): Promise<ConversationSession[]> {
  const result: ConversationSession[] = [];
  for (const project of await entries(join(root, 'projects'))) {
    if (!project.isDirectory()) continue;
    let fallback: string | undefined;
    for (const file of await entries(join(root, 'projects', project.name))) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const id = file.name.slice(0, -6);
      const mapped = desktop.get(id);
      // Desktop's persisted prs[] wins over historical link events, including an explicitly empty list after unlinking.
      if (mapped && (mapped.authoritativePulls || !includeTranscripts)) continue;
      const source = join(root, 'projects', project.name, file.name);
      const data: TranscriptMeta = includeTranscripts ? await transcriptMetadata(source, id) : { pulls: [] };
      if (mapped) { mapped.session.pulls = uniquePulls([...mapped.session.pulls, ...data.pulls]); continue; }
      if (includeTranscripts) fallback ??= data.directory ? undefined : await decodeProjectPath(project.name);
      const directory = data.directory ?? fallback ?? '';
      result.push({ id, agent: 'claude', adapter: 'claude-code', title: data.title ?? id, directory, directories: directory ? [directory] : [],
        branch: data.branch, lastActive: iso((await stat(source)).mtimeMs), pulls: data.pulls });
      if (result.length >= MAX_SESSIONS) return result;
    }
  }
  return result;
}

/** Match Claude's lossy project-directory encoding against real path segments, preserving dots and hyphens. */
export async function decodeProjectPath(name: string, root = '/'): Promise<string | undefined> {
  if (!name.startsWith('-')) return;
  const encode = (value: string): string => value.replace(/[^a-zA-Z0-9]/g, '-');
  let reads = 0;
  async function walk(directory: string, rest: string): Promise<string | undefined> {
    if (!rest) return directory;
    if (++reads > 400) return;
    for (const entry of await entries(directory).catch(() => [])) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const encoded = encode(entry.name);
      if (rest !== encoded && !rest.startsWith(`${encoded}-`)) continue;
      const found = await walk(join(directory, entry.name), rest.slice(encoded.length + 1));
      if (found) return found;
    }
  }
  return walk(root, name.slice(1));
}
async function latestDatabase(directory: string): Promise<string | undefined> {
  const files = (await entries(directory)).filter(entry => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name)).map(entry => entry.name);
  files.sort((a, b) => Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0));
  return files[0] && join(directory, files[0]);
}
async function query(file: string, table: string, build: (columns: Set<string>) => string | undefined): Promise<Record<string, unknown>[]> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
    const sql = build(columns);
    return sql ? db.prepare(sql).all() as Record<string, unknown>[] : [];
  } finally { db.close(); }
}
async function codexSessions(home: string): Promise<ConversationSession[]> {
  const file = await latestDatabase(home);
  if (!file) return [];
  const rows = await query(file, 'threads', columns => {
    if (!columns.has('id') || !columns.has('cwd')) return;
    const select = (name: string, alias = name): string => `${columns.has(name) ? name : 'NULL'} AS ${alias}`;
    return `SELECT id, cwd, ${select('title')}, ${select('name')}, ${select('git_branch', 'branch')}, ${select('git_origin_url', 'origin')}, ${select('updated_at', 'updated')}, ${select('archived')} FROM threads LIMIT ${MAX_SESSIONS}`;
  });
  return rows.flatMap(row => typeof row.id === 'string' ? [{ id: row.id, agent: 'codex' as const, adapter: 'codex' as const,
    title: string(row.name) ?? string(row.title) ?? row.id, directory: path(row.cwd) ?? '', directories: path(row.cwd) ? [String(row.cwd)] : [],
    branch: string(row.branch), origin: string(row.origin), lastActive: iso(epoch(row.updated)),
    archived: row.archived === 0 ? false : row.archived === 1 ? true : undefined, pulls: [] }] : []);
}
async function opencodeSessions(data: string): Promise<ConversationSession[]> {
  const database = join(data, 'opencode.db');
  try { await stat(database); } catch (error) { if (!isMissing(error)) throw error; return opencodeJsonSessions(join(data, 'storage/session')); }
  const rows = await query(database, 'session', columns => {
    if (!columns.has('id') || !columns.has('directory')) return;
    const updated = ['time_updated', 'time_created'].find(column => columns.has(column));
    return `SELECT id, directory, ${columns.has('title') ? 'title' : 'NULL AS title'}, ${updated ?? 'NULL'} AS updated,
      ${columns.has('time_archived') ? 'time_archived' : 'NULL'} AS archived FROM session LIMIT ${MAX_SESSIONS}`;
  });
  return rows.flatMap(row => typeof row.id === 'string' ? [{ id: row.id, agent: 'opencode' as const, adapter: 'opencode' as const,
    title: string(row.title) ?? row.id, directory: path(row.directory) ?? '', directories: path(row.directory) ? [String(row.directory)] : [],
    lastActive: iso(epoch(row.updated)), archived: row.archived !== null && row.archived !== 0, pulls: [] }] : []);
}
async function opencodeJsonSessions(root: string): Promise<ConversationSession[]> {
  const result: ConversationSession[] = [];
  for (const project of await entries(root)) {
    if (!project.isDirectory()) continue;
    for (const file of await entries(join(root, project.name))) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const data = await metadata(join(root, project.name, file.name));
      if (!data) continue;
      const value = data.value;
      const id = string(value.id) ?? file.name.slice(0, -5);
      const directory = path(value.directory) ?? '';
      const archived = object(value.time)?.archived;
      result.push({ id, agent: 'opencode', adapter: 'opencode', title: string(value.title) ?? id, directory, directories: directory ? [directory] : [],
        lastActive: iso(epoch(object(value.time)?.updated ?? object(value.time)?.created)),
        archived: archived !== undefined && archived !== null && archived !== 0, pulls: [] });
      if (result.length >= MAX_SESSIONS) return result;
    }
  }
  return result;
}
