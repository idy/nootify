import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Credentials } from './lark-metadata.js';
import type { LarkDirectory, LarkRecipient } from './lark-directory.js';
import { larkAvatarURL } from './lark-profile.js';

export const DIRECTORY_FRESH_MS = 15 * 60_000;
export const DIRECTORY_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_USERS = 5000;
interface Entry { scope: string; directory: LarkDirectory; at: number }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 4096 ? value.trim() || undefined : undefined;
const scopeKey = (credentials: Credentials): string => createHash('sha256').update(JSON.stringify([credentials.appId, credentials.appSecret])).digest('hex');

/** Project cached provider data onto the directory's small public field set. */
function sanitize(value: unknown, appId: string): LarkDirectory | undefined {
  if (!record(value) || value.app_id !== appId || !Array.isArray(value.users) || value.users.length > MAX_USERS ||
      typeof value.truncated !== 'boolean' || typeof value.permission_limited !== 'boolean') return;
  const users: LarkRecipient[] = [];
  for (const user of value.users) {
    if (!record(user) || typeof user.open_id !== 'string' || user.open_id.length > 4096 || !/^ou_[A-Za-z0-9]+$/.test(user.open_id) || !text(user.name)) return;
    const enName = text(user.en_name); const nickname = text(user.nickname); const avatar = larkAvatarURL(user.avatar_url);
    users.push({ open_id: user.open_id, name: text(user.name)!, ...(enName ? { en_name: enName } : {}),
      ...(nickname ? { nickname } : {}), ...(avatar ? { avatar_url: avatar } : {}) });
  }
  const directory: LarkDirectory = { app_id: appId, users, truncated: value.truncated, permission_limited: value.permission_limited };
  if (record(value.permission) && Array.isArray(value.permission.scopes)) {
    const scopes = value.permission.scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length <= 256 && /^contact:[a-z0-9_.]+(?::[a-z0-9_.]+)?$/.test(scope)).slice(0, 100);
    directory.permission = { scopes: [...new Set(scopes)] };
    const link = text(value.permission.url);
    if (link) try {
      const url = new URL(link);
      if (url.protocol === 'https:' && url.hostname === 'open.feishu.cn' && !url.username && !url.password && !url.port && url.pathname === `/app/${appId}/auth`) directory.permission.url = link;
    } catch { /* Invalid permission links are omitted. */ }
  }
  return directory;
}

/** Optional private storage: failures never prevent a directory network refresh. */
export class LarkDirectoryCache {
  private readonly path: string;
  private memory?: Entry;
  private diskCleared = false;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly stateDirectory: string, private readonly now: () => number = Date.now) {
    this.path = join(stateDirectory, 'lark-directory-cache.json');
  }

  private validTime(at: unknown): at is number {
    const now = this.now();
    return typeof at === 'number' && Number.isFinite(at) && at >= 0 && at <= now && now - at < DIRECTORY_MAX_AGE_MS;
  }

  // Reads participate too, so an in-flight disk read cannot repopulate memory after clear.
  private enqueue<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const result = this.pending.then(operation).catch(() => undefined);
    this.pending = result;
    return result;
  }

  async read(credentials: Credentials): Promise<{ directory: LarkDirectory; at: number } | undefined> {
    const scope = scopeKey(credentials); const appId = credentials.appId;
    return this.enqueue(async () => {
      if (this.memory?.scope === scope && this.validTime(this.memory.at)) {
        return { directory: structuredClone(this.memory.directory), at: this.memory.at };
      }
      if (this.memory && !this.validTime(this.memory.at)) this.memory = undefined;
      if (this.diskCleared) return;
      const info = await lstat(this.path);
      if (!info.isFile() || info.size > MAX_BYTES) return;
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) return;
        // Read at most the advertised size plus one byte, detecting growth without unbounded allocation.
        const bytes = Buffer.alloc(stat.size + 1); let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > stat.size || length > MAX_BYTES) return;
        const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
        if (!record(value) || value.version !== 1 || value.scope !== scope || !this.validTime(value.at)) return;
        const directory = sanitize(value.directory, appId);
        if (!directory) return;
        this.memory = { scope, directory, at: value.at };
        return { directory: structuredClone(directory), at: value.at };
      } finally { await file.close(); }
    });
  }

  async write(credentials: Credentials, directory: LarkDirectory, at: number = this.now()): Promise<void> {
    // Snapshot before queuing so callers can safely mutate their next progress snapshot.
    let entry: Entry;
    let body: string;
    try {
      const clean = sanitize(directory, credentials.appId);
      if (!clean || !this.validTime(at)) return;
      entry = { scope: scopeKey(credentials), directory: clean, at };
      body = JSON.stringify({ version: 1, ...entry });
      if (Buffer.byteLength(body) > MAX_BYTES) return;
    } catch { return; }
    await this.enqueue(async () => {
      this.memory = entry; this.diskCleared = false;
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(body, 'utf8');
        await file.close();
        await rename(temp, this.path);
      } finally {
        await file.close().catch(() => {});
        await unlink(temp).catch(() => {});
      }
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      this.memory = undefined; this.diskCleared = true;
      await unlink(this.path);
    });
  }
}
