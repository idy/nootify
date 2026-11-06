import { ApiError, type LarkApi } from './lark-metadata.js';
import { isOpenId } from './lark-threads.js';
import { HttpError } from './types.js';

export interface LarkRecipient { open_id: string; name: string; en_name?: string }
export interface LarkDirectory {
  app_id: string; users: LarkRecipient[]; truncated: boolean; permission_limited: boolean;
}
interface Page { has_more?: boolean; page_token?: string }
interface User {
  open_id?: string; name?: string; en_name?: string;
  status?: { is_frozen?: boolean; is_resigned?: boolean; is_exited?: boolean; is_unjoin?: boolean };
}
const MAX_REQUESTS = 100;
const MAX_USERS = 5000;
const permissionError = (error: unknown): boolean => error instanceof ApiError && [99991672, 99991679, 99991668, 40004, 41050].includes(error.code);

/** Reads only the app's authorized contact range. No profile data is persisted or logged. */
export async function larkDirectory(api: LarkApi, signal: AbortSignal = AbortSignal.timeout(20000)): Promise<LarkDirectory> {
  const users = new Map<string, LarkRecipient>();
  const departments = new Set<string>(); const expanded = new Set<string>();
  const directUsers = new Set<string>(); const groups = new Set<string>();
  let requests = 0; let truncated = false; let permissionLimited = false;
  const full = () => requests >= MAX_REQUESTS || users.size >= MAX_USERS || signal.aborted;
  const addUsers = (items: User[] = []) => {
    for (const user of items) {
      if (!isOpenId(user.open_id) || user.status?.is_frozen || user.status?.is_resigned || user.status?.is_exited || user.status?.is_unjoin) continue;
      if (users.size >= MAX_USERS && !users.has(user.open_id)) { truncated = true; break; }
      users.set(user.open_id, { open_id: user.open_id, name: user.name?.trim() || user.en_name?.trim() || user.open_id,
        ...(user.en_name?.trim() ? { en_name: user.en_name.trim() } : {}) });
    }
  };
  async function pages<T extends Page>(path: string, read: (page: T) => void): Promise<void> {
    const seen = new Set<string>(); let token: string | undefined;
    do {
      if (full()) { truncated = true; return; }
      const url = path + (token ? `&page_token=${encodeURIComponent(token)}` : '');
      requests++;
      const page = await api.request<T>('GET', url, undefined, signal);
      read(page);
      if (!page.has_more) return;
      if (!page.page_token || seen.has(page.page_token)) throw new Error('Invalid Feishu directory pagination');
      token = page.page_token; seen.add(token);
    } while (true);
  }
  async function readable(operation: () => Promise<void>): Promise<void> {
    try { await operation(); }
    catch (error) {
      if (permissionError(error)) permissionLimited = true;
      else if (signal.aborted && users.size) truncated = true;
      else throw error;
    }
  }
  async function profiles(ids: Set<string>): Promise<void> {
    const pending = [...ids].filter(id => isOpenId(id) && !users.has(id));
    for (let offset = 0; offset < pending.length; offset += 50) {
      if (full()) { truncated = true; return; }
      const query = new URLSearchParams({ user_id_type: 'open_id' });
      for (const id of pending.slice(offset, offset + 50)) query.append('user_ids', id);
      requests++;
      await readable(async () => addUsers((await api.request<{ items?: User[] }>('GET', `/open-apis/contact/v3/users/batch?${query}`, undefined, signal)).items));
    }
  }
  async function department(root: string): Promise<void> {
    if (expanded.has(root)) return;
    const descendants = new Set([root]);
    await readable(() => pages<Page & { items?: { open_department_id?: string }[] }>(
      `/open-apis/contact/v3/departments/${encodeURIComponent(root)}/children?department_id_type=open_department_id&fetch_child=true&page_size=50`,
      page => { for (const item of page.items ?? []) if (item.open_department_id) descendants.add(item.open_department_id); }));
    for (const id of descendants) {
      if (expanded.has(id)) continue;
      expanded.add(id);
      await readable(() => pages<Page & { items?: User[] }>(
        `/open-apis/contact/v3/users/find_by_department?department_id=${encodeURIComponent(id)}&department_id_type=open_department_id&user_id_type=open_id&page_size=50`,
        page => addUsers(page.items)));
      if (full()) { truncated = true; return; }
    }
  }
  try {
    await pages<Page & { user_ids?: string[]; department_ids?: string[]; group_ids?: string[] }>(
      '/open-apis/contact/v3/scopes?user_id_type=open_id&department_id_type=open_department_id&page_size=100', page => {
        for (const id of page.user_ids ?? []) directUsers.add(id);
        for (const id of page.department_ids ?? []) departments.add(id);
        for (const id of page.group_ids ?? []) groups.add(id);
      });
    await profiles(directUsers);
    for (const id of departments) { if (full()) { truncated = true; break; } await department(id); }
    for (const id of groups) {
      if (full()) { truncated = true; break; }
      const memberUsers = new Set<string>(); const memberDepartments = new Set<string>();
      for (const type of ['user', 'department'] as const) {
        await readable(() => pages<Page & { memberlist?: { member_id?: string; member_type?: string }[] }>(
          `/open-apis/contact/v3/group/${encodeURIComponent(id)}/member/simplelist?member_type=${type}&member_id_type=open_id&page_size=100`,
          page => { for (const member of page.memberlist ?? []) if (member.member_type === type && member.member_id) (type === 'user' ? memberUsers : memberDepartments).add(member.member_id); }));
      }
      await profiles(memberUsers);
      for (const id of memberDepartments) await department(id);
    }
  } catch (error) {
    if (permissionError(error)) throw new HttpError(403, 'Feishu contact permissions and contact access range are required');
    if (signal.aborted && users.size) truncated = true;
    else if (signal.aborted) throw new HttpError(504, 'Feishu directory request timed out');
    else throw new HttpError(502, 'Could not read the Feishu directory');
  }
  if (!users.size && permissionLimited) throw new HttpError(403, 'Feishu contact permissions and contact access range are required');
  return { app_id: api.appId, users: [...users.values()].sort((a, b) => a.name.localeCompare(b.name) || a.open_id.localeCompare(b.open_id)), truncated, permission_limited: permissionLimited };
}
