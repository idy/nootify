import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ConversationAgent = 'claude' | 'codex' | 'opencode';
/** A working directory that local agent conversations ran in; the repositories come from its git remotes. */
export interface ConversationDirectory { directory: string; agent: ConversationAgent; sessions: number; lastActive?: string; origin?: string }
export interface ConversationSources { claudeDir?: string; codexHome?: string; opencodeData?: string }

const HEAD_BYTES = 64 * 1024;
const MAX_JSON_SESSIONS = 5000;
const isMissing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const iso = (milliseconds: number): string | undefined => Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : undefined;
/** Epoch values from agent databases are seconds or milliseconds depending on the client version. */
const epoch = (value: unknown): number => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : NaN;

export function defaultSources(env: NodeJS.ProcessEnv = process.env): Required<ConversationSources> {
  return {
    claudeDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    codexHome: env.CODEX_HOME ?? join(homedir(), '.codex'),
    opencodeData: join(env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode'),
  };
}

/** Reads only conversation metadata (working directories and times), never message content beyond the first transcript line holding `cwd`. */
export async function conversationDirectories(sources: ConversationSources = defaultSources()): Promise<{ directories: ConversationDirectory[]; warnings: string[] }> {
  const warnings: string[] = [];
  const collect = async (name: string, read: () => Promise<ConversationDirectory[]>): Promise<ConversationDirectory[]> => {
    try { return await read(); } catch (error) { warnings.push(`${name} conversations were not read: ${(error as Error).message}`); return []; }
  };
  const parts = await Promise.all([
    sources.claudeDir ? collect('Claude', () => claudeDirectories(sources.claudeDir!)) : [],
    sources.codexHome ? collect('Codex', () => codexDirectories(sources.codexHome!)) : [],
    sources.opencodeData ? collect('OpenCode', () => opencodeDirectories(sources.opencodeData!)) : [],
  ]);
  return { directories: parts.flat(), warnings };
}

async function claudeDirectories(root: string): Promise<ConversationDirectory[]> {
  let projects;
  try { projects = await readdir(join(root, 'projects'), { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
  const result: ConversationDirectory[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const path = join(root, 'projects', project.name);
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { continue; }
    const transcripts = entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'));
    let newest = 0; let newestFile: string | undefined;
    for (const transcript of transcripts) {
      try { const { mtimeMs } = await stat(join(path, transcript.name)); if (mtimeMs > newest) { newest = mtimeMs; newestFile = transcript.name; } } catch { /* removed meanwhile */ }
    }
    // Transcripts record the exact cwd; folders whose transcripts were cleaned up keep only the encoded name.
    const directory = (newestFile && await transcriptDirectory(join(path, newestFile))) || await decodeProjectPath(project.name);
    if (directory) result.push({ directory, agent: 'claude', sessions: transcripts.length, ...(iso(newest) ? { lastActive: iso(newest) } : {}) });
  }
  return result;
}

export async function transcriptDirectory(file: string): Promise<string | undefined> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!match) return;
    const value: unknown = JSON.parse(`"${match[1]}"`);
    return typeof value === 'string' && value.startsWith('/') ? value : undefined;
  } catch { return; } finally { await handle.close(); }
}

/** Claude replaces every non-alphanumeric path character with '-'; match each segment against real entries. */
export async function decodeProjectPath(name: string, root = '/'): Promise<string | undefined> {
  if (!name.startsWith('-')) return;
  const encode = (value: string): string => value.replace(/[^a-zA-Z0-9]/g, '-');
  let reads = 0;
  async function walk(directory: string, rest: string): Promise<string | undefined> {
    if (!rest) return directory;
    if (++reads > 400) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const encoded = encode(entry.name);
      if (rest !== encoded && !rest.startsWith(`${encoded}-`)) continue;
      const found = await walk(join(directory, entry.name), rest.slice(encoded.length + 1));
      if (found) return found;
    }
  }
  return walk(root, name.slice(1));
}

async function latestDatabase(directory: string, pattern: RegExp): Promise<string | undefined> {
  let files: string[];
  try { files = (await readdir(directory)).filter(name => pattern.test(name)); } catch (error) { if (isMissing(error)) return; throw error; }
  files.sort((a, b) => Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0));
  return files[0] && join(directory, files[0]);
}

/** Opens agent databases read-only and adapts to the columns present, since their schemas change between releases. */
async function query(path: string, table: string, build: (columns: Set<string>) => string | undefined): Promise<Record<string, unknown>[]> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
    const sql = columns.size ? build(columns) : undefined;
    return sql ? db.prepare(sql).all() as Record<string, unknown>[] : [];
  } finally { db.close(); }
}

async function codexDirectories(home: string): Promise<ConversationDirectory[]> {
  const path = await latestDatabase(home, /^state_\d+\.sqlite$/);
  if (!path) return [];
  const rows = await query(path, 'threads', columns => columns.has('cwd')
    ? `SELECT cwd, COUNT(*) AS sessions, MAX(${columns.has('updated_at') ? 'updated_at' : 'NULL'}) AS updated, MAX(${columns.has('git_origin_url') ? 'git_origin_url' : 'NULL'}) AS origin FROM threads GROUP BY cwd`
    : undefined);
  return rows.flatMap(row => typeof row.cwd === 'string' && row.cwd.startsWith('/') ? [{
    directory: row.cwd, agent: 'codex' as const, sessions: Number(row.sessions) || 0,
    ...(iso(epoch(row.updated)) ? { lastActive: iso(epoch(row.updated)) } : {}),
    ...(typeof row.origin === 'string' && row.origin ? { origin: row.origin } : {}),
  }] : []);
}

async function opencodeDirectories(data: string): Promise<ConversationDirectory[]> {
  const database = join(data, 'opencode.db');
  try { await stat(database); } catch (error) { if (!isMissing(error)) throw error; return opencodeJsonDirectories(join(data, 'storage', 'session')); }
  const rows = await query(database, 'session', columns => columns.has('directory')
    ? `SELECT directory, COUNT(*) AS sessions, MAX(${['time_updated', 'time_created'].find(column => columns.has(column)) ?? 'NULL'}) AS updated FROM session GROUP BY directory`
    : undefined);
  return rows.flatMap(row => typeof row.directory === 'string' && row.directory.startsWith('/') ? [{
    directory: row.directory, agent: 'opencode' as const, sessions: Number(row.sessions) || 0,
    ...(iso(epoch(row.updated)) ? { lastActive: iso(epoch(row.updated)) } : {}),
  }] : []);
}

/** Older OpenCode releases keep one JSON file per session under storage/session/<project>/. */
async function opencodeJsonDirectories(root: string): Promise<ConversationDirectory[]> {
  const found = new Map<string, ConversationDirectory>();
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
  let files = 0;
  for (const project of projects.filter(entry => entry.isDirectory())) {
    let sessions: string[];
    try { sessions = (await readdir(join(root, project.name))).filter(name => name.endsWith('.json')); } catch { continue; }
    for (const name of sessions) {
      if (++files > MAX_JSON_SESSIONS) return [...found.values()];
      try {
        const handle = await open(join(root, project.name, name), 'r');
        let text: string;
        try { const buffer = Buffer.alloc(HEAD_BYTES); const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0); text = buffer.subarray(0, bytesRead).toString('utf8'); }
        finally { await handle.close(); }
        const session = JSON.parse(text) as { directory?: unknown; time?: { updated?: unknown; created?: unknown } };
        if (typeof session.directory !== 'string' || !session.directory.startsWith('/')) continue;
        const updated = epoch(session.time?.updated ?? session.time?.created);
        const entry = found.get(session.directory) ?? { directory: session.directory, agent: 'opencode' as const, sessions: 0 };
        entry.sessions++;
        if (iso(updated) && (!entry.lastActive || iso(updated)! > entry.lastActive)) entry.lastActive = iso(updated);
        found.set(session.directory, entry);
      } catch { /* truncated or concurrently written session file */ }
    }
  }
  return [...found.values()];
}
