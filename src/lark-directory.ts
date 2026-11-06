import { ApiError, type LarkApi, type LarkPermission } from './lark-metadata.js';
import { isOpenId } from './lark-threads.js';
import { HttpError } from './types.js';
import { larkAvatarURL } from './lark-profile.js';

export interface LarkRecipient { open_id: string; name: string; en_name?: string; nickname?: string; avatar_url?: string }
export type LarkDirectoryPermission = LarkPermission;
export interface LarkDirectory {
  app_id: string; users: LarkRecipient[]; truncated: boolean; permission_limited: boolean;
  permission?: LarkDirectoryPermission;
}
export class LarkDirectoryPermissionError extends HttpError {
  constructor(public readonly permission?: LarkDirectoryPermission) {
    super(403, 'Feishu contact permissions and contact access range are required');
  }
}
interface Page { has_more?: boolean; page_token?: string }
interface User {
  open_id?: string; name?: string; en_name?: string; nickname?: string;
  avatar?: { avatar_72?: string; avatar_240?: string; avatar_640?: string; avatar_origin?: string };
  status?: { is_frozen?: boolean; is_resigned?: boolean; is_exited?: boolean; is_unjoin?: boolean };
}
const MAX_REQUESTS = 100;
const MAX_USERS = 5000;
const CONCURRENCY = 4;
const permissionError = (error: unknown): error is ApiError => error instanceof ApiError && [99991672, 99991679, 99991668, 40004, 41050].includes(error.code);

/** Reads only the app's authorized contact range. No profile data is persisted or logged. */
export async function larkDirectory(api: LarkApi, signal?: AbortSignal, onProgress?: (directory: LarkDirectory) => void): Promise<LarkDirectory> {
  const stop = new AbortController();
  const requestSignal = AbortSignal.any([stop.signal, AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
  const users = new Map<string, LarkRecipient>();
  const departments = new Set<string>(); const expanded = new Set<string>();
  const directUsers = new Set<string>(); const groups = new Set<string>();
  let requests = 0; let truncated = false; let permissionLimited = false;
  let permission: LarkDirectoryPermission | undefined; let finished = false;
  const full = () => requests >= MAX_REQUESTS || users.size >= MAX_USERS || requestSignal.aborted;
  const snapshot = (): LarkDirectory => ({ app_id: api.appId, users: [...users.values()].sort((a, b) => a.name.localeCompare(b.name) || a.open_id.localeCompare(b.open_id)), truncated, permission_limited: permissionLimited, ...(permission ? { permission } : {}) });
  const publish = () => { if (!finished && !requestSignal.aborted && onProgress) onProgress(snapshot()); };
  const addUsers = (items: User[] = []) => {
    if (finished || requestSignal.aborted) return;
    let changed = false;
    for (const user of items) {
      if (!isOpenId(user.open_id) || user.status?.is_frozen || user.status?.is_resigned || user.status?.is_exited || user.status?.is_unjoin) continue;
      if (users.size >= MAX_USERS && !users.has(user.open_id)) { truncated = true; break; }
      const avatar = [user.avatar?.avatar_72, user.avatar?.avatar_240, user.avatar?.avatar_640, user.avatar?.avatar_origin].map(larkAvatarURL).find(Boolean);
      const recipient: LarkRecipient = { open_id: user.open_id, name: user.name?.trim() || user.nickname?.trim() || user.en_name?.trim() || user.open_id,
        ...(user.en_name?.trim() ? { en_name: user.en_name.trim() } : {}),
        ...(user.nickname?.trim() ? { nickname: user.nickname.trim() } : {}), ...(avatar ? { avatar_url: avatar } : {}) };
      const previous = users.get(user.open_id);
      if (!previous || previous.name !== recipient.name || previous.en_name !== recipient.en_name || previous.nickname !== recipient.nickname || previous.avatar_url !== recipient.avatar_url) { users.set(user.open_id, recipient); changed = true; }
    }
    if (changed) publish();
  };
  const markPermission = (error: ApiError) => {
    permissionLimited = true;
    const metadata = error.permission;
    if (!permission && metadata && Array.isArray(metadata.scopes)) {
      permission = { scopes: metadata.scopes.filter((scope): scope is string => typeof scope === 'string'), ...(typeof metadata.url === 'string' ? { url: metadata.url } : {}) };
    }
    publish();
  };
  // Bound requests globally, including concurrent department and profile pagination.
  let active = 0; const waiters: (() => void)[] = [];
  async function request<T>(path: string): Promise<T | undefined> {
    if (full()) { truncated = true; return; }
    if (active >= CONCURRENCY) await new Promise<void>(resolve => waiters.push(resolve));
    else active++;
    if (full()) { truncated = true; if (waiters.length) waiters.shift()!(); else active--; return; }
    requests++;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        api.request<T>('GET', path, undefined, requestSignal),
        new Promise<never>((_, reject) => {
          abort = () => reject(new Error('Feishu directory request aborted'));
          if (requestSignal.aborted) abort(); else requestSignal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) requestSignal.removeEventListener('abort', abort);
      if (waiters.length) waiters.shift()!(); else active--;
    }
  }
  async function pages<T extends Page>(path: string, read: (page: T) => void): Promise<void> {
    const seen = new Set<string>(); let token: string | undefined;
    do {
      const page = await request<T>(path + (token ? `&page_token=${encodeURIComponent(token)}` : ''));
      if (!page || finished || requestSignal.aborted) return;
      read(page);
      if (!page.has_more) return;
      if (!page.page_token || seen.has(page.page_token)) throw new Error('Invalid Feishu directory pagination');
      token = page.page_token; seen.add(token);
    } while (true);
  }
  async function readable(operation: () => Promise<void>): Promise<boolean> {
    try { await operation(); return true; }
    catch (error) {
      if (permissionError(error)) { markPermission(error); return false; }
      throw error;
    }
  }
  async function profiles(ids: Set<string>): Promise<void> {
    const pending = [...ids].filter(id => isOpenId(id) && !users.has(id));
    const jobs: Promise<boolean>[] = [];
    for (let offset = 0; offset < pending.length; offset += 50) {
      const query = new URLSearchParams({ user_id_type: 'open_id' });
      for (const id of pending.slice(offset, offset + 50)) query.append('user_ids', id);
      jobs.push(readable(async () => { const page = await request<{ items?: User[] }>(`/open-apis/contact/v3/users/batch?${query}`); if (page) addUsers(page.items); }));
    }
    await Promise.all(jobs);
  }
  async function department(root: string): Promise<void> {
    if (expanded.has(root)) return;
    expanded.add(root);
    const readUsers = (id: string) => readable(() => pages<Page & { items?: User[] }>(
      `/open-apis/contact/v3/users/find_by_department?department_id=${encodeURIComponent(id)}&department_id_type=open_department_id&user_id_type=open_id&page_size=50`,
      page => addUsers(page.items)));
    await Promise.all([readUsers(root), (async () => {
      const descendants = new Set<string>();
      await readable(() => pages<Page & { items?: { open_department_id?: string }[] }>(
        `/open-apis/contact/v3/departments/${encodeURIComponent(root)}/children?department_id_type=open_department_id&fetch_child=true&page_size=50`,
        page => { for (const item of page.items ?? []) if (item.open_department_id) descendants.add(item.open_department_id); }));
      const jobs: Promise<boolean>[] = [];
      for (const id of descendants) {
        if (expanded.has(id)) continue;
        expanded.add(id);
        jobs.push(readUsers(id));
      }
      await Promise.all(jobs);
    })()]);
  }
  try {
    await pages<Page & { user_ids?: string[]; department_ids?: string[]; group_ids?: string[] }>(
      '/open-apis/contact/v3/scopes?user_id_type=open_id&department_id_type=open_department_id&page_size=100', page => {
        for (const id of page.user_ids ?? []) directUsers.add(id);
        for (const id of page.department_ids ?? []) departments.add(id);
        for (const id of page.group_ids ?? []) groups.add(id);
      });
    await Promise.all([profiles(directUsers), ...[...departments].map(id => department(id))]);
    for (const id of groups) {
      if (full()) { truncated = true; break; }
      const memberUsers = new Set<string>(); const memberDepartments = new Set<string>();
      let groupReadable = true;
      for (const type of ['user', 'department'] as const) {
        groupReadable = await readable(() => pages<Page & { memberlist?: { member_id?: string; member_type?: string }[] }>(
          `/open-apis/contact/v3/group/${encodeURIComponent(id)}/member/simplelist?member_type=${type}&member_id_type=open_id&page_size=100`,
          page => { for (const member of page.memberlist ?? []) if (member.member_type === type && member.member_id) (type === 'user' ? memberUsers : memberDepartments).add(member.member_id); }));
        if (!groupReadable) break;
      }
      await Promise.all([profiles(memberUsers), ...[...memberDepartments].map(id => department(id))]);
      if (!groupReadable) break;
    }
    if (requestSignal.aborted) throw requestSignal.reason;
  } catch (error) {
    if (permissionError(error)) { markPermission(error); if (!users.size) throw new LarkDirectoryPermissionError(permission); }
    else if (requestSignal.aborted && users.size) truncated = true;
    else if (requestSignal.aborted) throw new HttpError(504, 'Feishu directory request timed out');
    else throw new HttpError(502, 'Could not read the Feishu directory');
  } finally {
    finished = true;
    stop.abort();
  }
  if (!users.size && permissionLimited) throw new LarkDirectoryPermissionError(permission);
  return snapshot();
}
