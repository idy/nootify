import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { Adapter, PublicSession } from './types.js';
import { desktopSessionRoots } from './runtime-paths.js';
import { checkSocket } from './inbox.js';

export type Availability = 'active' | 'archived' | 'offline' | 'unknown';
export interface LocalSession extends PublicSession { availability: Availability; socket_path?: string }
export interface SessionCatalog {
  inspect(id: string, adapter: Adapter): Promise<LocalSession | undefined>;
}
interface RuntimeRecord { pid?: number; sessionId?: string; hostSessionId?: string; messagingSocketPath?: string; name?: string }
interface DesktopRecord { sessionId?: string; cliSessionId?: string; title?: string; isArchived?: boolean }
async function entries(path: string): Promise<import('node:fs').Dirent[]> {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function json(path: string): Promise<Record<string, unknown>> {
  const info = await stat(path);
  if (info.size > 12 * 1024 * 1024) throw new Error('Session metadata exceeds the read limit');
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid local session metadata');
  return data as Record<string, unknown>;
}
export class LocalSessions implements SessionCatalog {
  constructor(private readonly options: { desktopRoots?: string[]; registryDir?: string } = {}) {}
  private roots(): string[] {
    return this.options.desktopRoots ?? desktopSessionRoots();
  }
  private async desktopFolders(): Promise<string[]> {
    const folders: string[] = [];
    for (const root of this.roots()) {
      for (const account of await entries(root)) {
        if (!account.isDirectory()) continue;
        const parent = join(root, account.name);
        for (const profile of await entries(parent)) if (profile.isDirectory()) folders.push(join(parent, profile.name));
      }
    }
    return folders;
  }
  private async runtimes(id: string, adapter: Adapter): Promise<RuntimeRecord[]> {
    const dir = this.options.registryDir ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions');
    const records: RuntimeRecord[] = [];
    for (const entry of await entries(dir)) {
      if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
      try {
        const record = await json(join(dir, entry.name)) as RuntimeRecord;
        if (adapter === 'claude-desktop' ? record.hostSessionId !== id : record.sessionId !== id || Boolean(record.hostSessionId)) continue;
        if (!Number.isInteger(record.pid) || Number(record.pid) <= 0) continue;
        process.kill(record.pid!, 0);
        if (typeof record.messagingSocketPath !== 'string') continue;
        await checkSocket(record.messagingSocketPath);
        records.push(record);
      } catch { /* Closed runtimes leave files behind; they are not live endpoints. */ }
    }
    return records;
  }
  private async inspectWith(id: string, adapter: Adapter, folders: string[], runtimes: RuntimeRecord[]): Promise<LocalSession | undefined> {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    let runtime: RuntimeRecord | undefined;
    let metadata: DesktopRecord | undefined;
    let corrupt = false;
    if (adapter === 'claude-desktop') {
      for (const folder of folders) {
        try {
          const candidate = await json(join(folder, `${id}.json`)) as DesktopRecord;
          if (candidate.sessionId !== id || metadata) return { session_id: id, host_id: hostname(), adapter, session_name: id, availability: 'unknown' };
          metadata = candidate;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') corrupt = true; }
      }
      if (!metadata && !corrupt) return;
      runtime = runtimes.find(record => record.hostSessionId === id && (!metadata?.cliSessionId || record.sessionId === metadata.cliSessionId));
    } else {
      runtime = runtimes.find(record => record.sessionId === id && !record.hostSessionId);
      if (!runtime) return;
    }
    const result: LocalSession = { session_id: id, host_id: hostname(), adapter,
      session_name: metadata?.title ?? runtime?.name ?? id,
      availability: adapter === 'claude-desktop' && (corrupt || typeof metadata?.isArchived !== 'boolean') ? 'unknown' :
        metadata?.isArchived ? 'archived' : runtime ? 'active' : 'offline' };
    if (result.availability === 'active') result.socket_path = runtime?.messagingSocketPath;
    return result;
  }
  async inspect(id: string, adapter: Adapter): Promise<LocalSession | undefined> {
    // Never cache archive state at the point of delivery.
    if (adapter !== 'claude-code' && adapter !== 'claude-desktop') return;
    return this.inspectWith(id, adapter, adapter === 'claude-desktop' ? await this.desktopFolders() : [], await this.runtimes(id, adapter));
  }
}
