import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { serviceStateDir } from './runtime-paths.js';
import { join } from 'node:path';
import type { Adapter, BackendConnection, LarkBinding, LarkDelivery, LarkPollCursor, LarkPollReceipt, PublicSession, SessionRecord, StoredInboxMessage } from './types.js';
import { HttpError, isAdapter, larkPollCursorKey, larkPollReceiptKey } from './types.js';
import { isNotificationChannel, validChatConfig, type ChatBinding, type ChatDelivery, type NotificationChannel, type SlackConfig, type TelegramConfig } from './chat-transport.js';
import { StateDatabase, legacyLarkPollReceipts, validateLarkPollReceipt, type LarkPollPrune, type StateRows } from './state-database.js';

export type LarkConnectionType = 'bot' | 'personal-app';
export const isLarkConnectionType = (value: unknown): value is LarkConnectionType => value === 'bot' || value === 'personal-app';

/** Owner choices that are not tied to one session or binding. */
export interface Settings {
  lark_recipient_open_id?: string; lark_app_id?: string; lark_app_secret?: string; lark_connection_type?: LarkConnectionType; github_token?: string; tailscale_enabled?: boolean;
  notification_channel?: NotificationChannel; slack?: SlackConfig; telegram?: TelegramConfig;
}
/** The pre-SQLite format is read only for the first successful database migration. */
interface StoredState { version: 1; sessions: SessionRecord[]; lark_bindings: LarkBinding[]; backends?: [Adapter, BackendConnection][]; lark_deliveries?: LarkDelivery[]; lark_poll_cursors?: LarkPollCursor[]; lark_poll_receipts?: LarkPollReceipt[]; chat_bindings?: ChatBinding[]; chat_deliveries?: ChatDelivery[]; inbox_messages?: StoredInboxMessage[]; settings?: Settings }
function validateCursor(value: unknown): asserts value is LarkPollCursor {
  const cursor = value as LarkPollCursor | null;
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) ||
    typeof cursor.app_id !== 'string' || !cursor.app_id || typeof cursor.chat_id !== 'string' || !cursor.chat_id ||
    typeof cursor.container_id !== 'string' || !cursor.container_id || !['chat', 'thread'].includes(cursor.container_type) ||
    !Number.isSafeInteger(cursor.started_at) || !Number.isSafeInteger(cursor.through)) {
    throw new Error('Invalid service state poll cursor; the original data was not replaced');
  }
  legacyLarkPollReceipts(larkPollCursorKey(cursor), cursor.recent);
}
function validate(data: unknown): asserts data is StoredState {
  const fail = () => { throw new Error('Invalid service state; the original data was not replaced'); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail();
  const state = data as Record<string, unknown>;
  if (state.version !== 1 || !Array.isArray(state.sessions) || !Array.isArray(state.lark_bindings)) return fail();
  for (const [field, identity] of [['sessions', 'session_id'], ['lark_bindings', 'chat_id'], ['lark_deliveries', 'message_id'],
    ['chat_bindings', 'id'], ['chat_deliveries', 'id'], ['inbox_messages', 'id']] as const) {
    const records = state[field];
    if (records === undefined) continue;
    if (!Array.isArray(records)) return fail();
    for (const record of records) if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record[identity] !== 'string' || !record[identity]) return fail();
  }
  if (state.backends !== undefined) {
    if (!Array.isArray(state.backends)) return fail();
    for (const entry of state.backends) if (!Array.isArray(entry) || entry.length !== 2 || !isAdapter(entry[0]) || !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1])) return fail();
  }
  if (state.lark_poll_cursors !== undefined) {
    if (!Array.isArray(state.lark_poll_cursors)) return fail();
    for (const cursor of state.lark_poll_cursors) validateCursor(cursor);
  }
  if (state.lark_poll_receipts !== undefined) {
    if (!Array.isArray(state.lark_poll_receipts)) return fail();
    for (const receipt of state.lark_poll_receipts) validateLarkPollReceipt(receipt);
  }
  if (state.settings !== undefined && (!state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings))) return fail();
}
function encode(entries: Iterable<readonly [string, unknown]>): Map<string, string> {
  const rows = new Map<string, string>();
  for (const [id, value] of entries) { const serialized = JSON.stringify(value); if (serialized !== undefined) rows.set(id, serialized); }
  return rows;
}
const decode = <T>(rows: Map<string, string>): T[] => [...rows.values()].map(value => JSON.parse(value) as T);
export const defaultStateDir = () => serviceStateDir();
export class State {
  readonly sessions = new Map<string, SessionRecord>();
  readonly bindings = new Map<string, LarkBinding>();
  readonly backends = new Map<Adapter, BackendConnection>();
  readonly deliveries = new Map<string, LarkDelivery>();
  readonly larkPollCursors = new Map<string, LarkPollCursor>();
  readonly chatBindings = new Map<string, ChatBinding>();
  readonly chatDeliveries = new Map<string, ChatDelivery>();
  readonly inboxMessages = new Map<string, StoredInboxMessage>();
  readonly settings: Settings = {};
  private readonly pollReceiptRows = new Map<string, string>();
  private readonly pollReceipts = new Map<string, Map<string, number>>();
  private readonly emptyPollReceipts: ReadonlyMap<string, number> = new Map();
  private writes: Promise<void> = Promise.resolve();
  private database!: StateDatabase;
  private constructor(readonly directory: string, readonly token: string) {}
  static async open(directory = defaultStateDir()): Promise<State> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const tokenPath = join(directory, 'auth-token');
    let contents: string;
    try { contents = await readFile(tokenPath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const temporary = join(directory, `.auth-token-${randomUUID()}`);
      try {
        await writeFile(temporary, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
        // Publish a complete file without replacing another opener's token (also atomic on NTFS).
        try { await link(temporary, tokenPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally { await rm(temporary, { force: true }); }
      contents = await readFile(tokenPath, 'utf8');
    }
    const token = contents.trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid private service authentication file');
    const state = new State(directory, token);
    state.database = await StateDatabase.open(directory, async () => {
      let content: string;
      try { content = await readFile(join(directory, 'state.json'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      let data: unknown;
      try { data = JSON.parse(content); }
      catch { throw new Error('Invalid legacy state JSON; the original file was not replaced'); }
      validate(data); state.restore(data);
      return state.snapshot();
    });
    const rows = state.database.load();
    const data: StoredState = { version: 1, sessions: decode(rows.sessions), lark_bindings: decode(rows.lark_bindings),
      backends: [...rows.backends].map(([adapter, value]) => [adapter as Adapter, JSON.parse(value) as BackendConnection]),
      lark_deliveries: decode(rows.lark_deliveries), lark_poll_cursors: decode(rows.lark_poll_cursors), lark_poll_receipts: decode(rows.lark_poll_receipts),
      chat_bindings: decode(rows.chat_bindings), chat_deliveries: decode(rows.chat_deliveries), inbox_messages: decode(rows.inbox_messages),
      settings: Object.fromEntries([...rows.settings].map(([id, value]) => [id, JSON.parse(value)])) as Settings };
    validate(data); state.restore(data);
    return state;
  }
  private restore(data: StoredState): void {
    this.sessions.clear(); this.bindings.clear(); this.backends.clear(); this.deliveries.clear(); this.larkPollCursors.clear();
    this.chatBindings.clear(); this.chatDeliveries.clear(); this.inboxMessages.clear(); this.pollReceiptRows.clear(); this.pollReceipts.clear();
    for (const key of Object.keys(this.settings)) delete this.settings[key as keyof Settings];
    for (const session of data.sessions) this.sessions.set(session.session_id, session);
    for (const binding of data.lark_bindings) this.bindings.set(binding.chat_id, binding);
    for (const [adapter, backend] of data.backends ?? []) this.backends.set(adapter, backend);
    for (const delivery of data.lark_deliveries ?? []) this.deliveries.set(delivery.message_id, delivery);
    for (const cursor of data.lark_poll_cursors ?? []) {
      const id = larkPollCursorKey(cursor); const { recent, ...current } = cursor;
      this.larkPollCursors.set(id, current);
      for (const receipt of legacyLarkPollReceipts(id, recent)) this.storePollReceipt(receipt, JSON.stringify(receipt));
    }
    for (const receipt of data.lark_poll_receipts ?? []) {
      const previous = this.pollReceipts.get(receipt.cursor_id)?.get(receipt.message_id);
      if (previous !== undefined && previous !== receipt.create_time) throw new Error('Invalid service state conflicting poll receipts; the original data was not replaced');
      this.storePollReceipt(receipt, JSON.stringify(receipt));
    }
    for (const binding of data.chat_bindings ?? []) this.chatBindings.set(binding.id, binding);
    for (const delivery of data.chat_deliveries ?? []) this.chatDeliveries.set(delivery.id, delivery);
    for (const message of data.inbox_messages ?? []) {
      const source = message.source;
      // Keep one shared context so receipts/replies stay current even after the bounded ledger evicts it.
      if (source?.channel === 'feishu') source.delivery = this.larkDelivery(source.delivery.message_id) ?? source.delivery;
      else if (source) source.delivery = this.chatDelivery(source.delivery.id) ?? source.delivery;
      this.inboxMessages.set(message.id, message);
    }
    if (isNotificationChannel(data.settings?.notification_channel)) this.settings.notification_channel = data.settings.notification_channel;
    if (validChatConfig('slack', data.settings?.slack)) this.settings.slack = data.settings.slack;
    if (validChatConfig('telegram', data.settings?.telegram)) this.settings.telegram = data.settings.telegram;
    if (typeof data.settings?.tailscale_enabled === 'boolean') this.settings.tailscale_enabled = data.settings.tailscale_enabled;
    if (isLarkConnectionType(data.settings?.lark_connection_type)) this.settings.lark_connection_type = data.settings.lark_connection_type;
    for (const field of ['lark_recipient_open_id', 'lark_app_id', 'lark_app_secret', 'github_token'] as const) {
      const value = data.settings?.[field];
      if (typeof value === 'string') this.settings[field] = value;
    }
  }
  private snapshot(): StateRows {
    return { sessions: encode(this.sessions), lark_bindings: encode(this.bindings), backends: encode(this.backends),
      lark_deliveries: encode(this.deliveries), lark_poll_cursors: encode(this.larkPollCursors), lark_poll_receipts: new Map(this.pollReceiptRows), chat_bindings: encode(this.chatBindings),
      chat_deliveries: encode(this.chatDeliveries), inbox_messages: encode(this.inboxMessages), settings: encode(Object.entries(this.settings)) };
  }
  session(id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, 'Session is not registered');
    return session;
  }
  publicSessions(): PublicSession[] {
    return [...this.sessions.values()].map(({ session_id, host_id, adapter, session_name }) => ({ session_id, host_id, adapter, session_name }));
  }
  larkDelivery(id: string): LarkDelivery | undefined {
    const saved = this.deliveries.get(id);
    if (saved) return saved;
    for (const { source } of this.inboxMessages.values()) if (source?.channel === 'feishu' && source.delivery.message_id === id) return source.delivery;
  }
  chatDelivery(id: string): ChatDelivery | undefined {
    const saved = this.chatDeliveries.get(id);
    if (saved) return saved;
    for (const { source } of this.inboxMessages.values()) if (source && source.channel !== 'feishu' && source.delivery.id === id) return source.delivery;
  }
  *chatDeliveryRecords(): Generator<ChatDelivery> {
    yield* this.chatDeliveries.values();
    const seen = new Set(this.chatDeliveries.keys());
    for (const { source } of this.inboxMessages.values()) {
      if (source && source.channel !== 'feishu' && !seen.has(source.delivery.id)) { seen.add(source.delivery.id); yield source.delivery; }
    }
  }
  hasLarkPollReceipt(cursorId: string, messageId: string): boolean { return this.pollReceipts.get(cursorId)?.has(messageId) ?? false; }
  larkPollReceipts(cursorId: string): ReadonlyMap<string, number> { return this.pollReceipts.get(cursorId) ?? this.emptyPollReceipts; }
  private storePollReceipt(receipt: LarkPollReceipt, value: string): void {
    this.pollReceiptRows.set(larkPollReceiptKey(receipt.cursor_id, receipt.message_id), value);
    let receipts = this.pollReceipts.get(receipt.cursor_id);
    if (!receipts) { receipts = new Map(); this.pollReceipts.set(receipt.cursor_id, receipts); }
    receipts.set(receipt.message_id, receipt.create_time);
  }
  /** Incremental progress shares the save queue, and becomes visible only after the whole transaction succeeds. */
  async saveLarkPollProgress(cursors: readonly LarkPollCursor[], receipts: readonly LarkPollReceipt[] = [], prune: readonly LarkPollPrune[] = []): Promise<void> {
    return this.enqueue(async () => {
      const updates = new Map<string, LarkPollCursor>(); const completed = new Map<string, LarkPollReceipt>();
      for (const cursor of cursors) {
        validateCursor(cursor);
        const id = larkPollCursorKey(cursor); const { recent, ...current } = cursor;
        updates.set(id, current);
        for (const receipt of legacyLarkPollReceipts(id, recent)) completed.set(larkPollReceiptKey(id, receipt.message_id), receipt);
      }
      for (const receipt of receipts) {
        validateLarkPollReceipt(receipt);
        completed.set(larkPollReceiptKey(receipt.cursor_id, receipt.message_id), receipt);
      }
      const cutoffs = new Map<string, number>();
      for (const { cursor_id, before } of prune) {
        if (typeof cursor_id !== 'string' || !cursor_id || !Number.isSafeInteger(before)) throw new Error('Invalid poll receipt pruning request');
        cutoffs.set(cursor_id, Math.max(cutoffs.get(cursor_id) ?? -Infinity, before));
      }
      const receiptRows = encode(completed);
      await this.database.patch({ lark_poll_cursors: encode(updates), lark_poll_receipts: receiptRows },
        [...cutoffs].map(([cursor_id, before]) => ({ cursor_id, before })));
      for (const [id, cursor] of updates) this.larkPollCursors.set(id, cursor);
      for (const [id, receipt] of completed) this.storePollReceipt(receipt, receiptRows.get(id)!);
      for (const [cursorId, before] of cutoffs) {
        const saved = this.pollReceipts.get(cursorId);
        if (!saved) continue;
        for (const [messageId, time] of saved) if (time < before) {
          saved.delete(messageId); this.pollReceiptRows.delete(larkPollReceiptKey(cursorId, messageId));
        }
        if (!saved.size) this.pollReceipts.delete(cursorId);
      }
    });
  }
  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.writes.catch(() => {}).then(operation);
    this.writes = pending;
    await pending;
  }
  /** In-memory changes, one SQLite transaction, and rollback share the same serialized queue. */
  async save(change?: { apply(): void; rollback(): void }): Promise<void> {
    return this.enqueue(async () => {
      try { change?.apply(); await this.database.write(this.snapshot()); }
      catch (error) { change?.rollback(); throw error; }
    });
  }
}
