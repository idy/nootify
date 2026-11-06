import { hostname } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { InvalidAnnouncement, parseAnnouncement, readAnnouncement, requestLark, type LarkApi } from './lark-metadata.js';
import { LarkHistoryBuffer, type LarkHistoryMessage, type LarkHistoryEntry } from './lark-history-buffer.js';
import type { State } from './state.js';
import { isAdapter, larkPollCursorKey, type LarkBinding, type LarkPollCursor, type LarkPollReceipt } from './types.js';

const INTERVAL_MS = 3_000;
const REQUEST_INTERVAL_MS = 200;
const OVERLAP_MS = 10_000;
const DISCOVERY_INTERVAL_MS = 60_000;
const ROOT_PAGES_PER_PASS = 1;
const CHECKPOINT_MESSAGES = 50;
const CONTINUATION_FAILURES = 3;
interface Page<T> { items?: T[]; has_more?: boolean; page_token?: string }
interface RootScan { end: number; page?: string; tokens: Set<string>; readyAt: number; failures: number; complete: boolean }
interface Discovery { page?: string; tokens: Set<string>; queue: string[]; members: Set<string>; listed: boolean; retryAt: number; failures: number; initial: boolean }
interface Scan { cursor: LarkPollCursor; lower: number; end: number; covered: number; providerClock: boolean }
export interface LarkReceiver { start(): Promise<void>; stop(): Promise<void> }
export interface LarkPollingOptions {
  state: State;
  api: LarkApi;
  receive(payload: unknown): Promise<boolean>;
  status(status: 'ready' | 'failed'): void;
  report(record: Record<string, unknown>): void;
  /** Epoch time at construction; monotonic elapsed time drives scheduling independently. */
  now?: () => number;
  monotonic?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export type LarkPollingFactory = (options: LarkPollingOptions) => LarkReceiver;

/** Independent history reads, with bounded metadata discovery and durable per-message receipts. */
export class LarkPoller implements LarkReceiver {
  private readonly monotonic: () => number;
  private readonly wait: NonNullable<LarkPollingOptions['wait']>;
  private readonly startedAt: number;
  private readonly startedMono: number;
  private readonly startupBindings = new Map<string, number>();
  private readonly provisional = new Set<string>();
  private readonly startupDiscovery: boolean;
  private initialDiscoveryDone = false;
  private clockOffset = 0;
  private controller?: AbortController;
  private task?: Promise<void>;
  private verified = false;
  private cleaned = false;
  private lastRequest = -Infinity;
  private roots = new Map<string, RootScan>();
  private discovered = new Map<string, number>();
  private discoveryAt = -Infinity;
  private discovery?: Discovery;
  private threads = new Map<string, Map<string, LarkPollCursor>>();
  private retries = new Map<string, { failures: number; at: number }>();
  private progress = new Map<string, LarkPollCursor>();
  private storageFailed = false;
  constructor(private readonly options: LarkPollingOptions) {
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.wait = options.wait ?? (async (ms, signal) => { await wait(ms, undefined, { signal, ref: false }); });
    this.startedAt = (options.now ?? Date.now)();
    this.startedMono = this.monotonic();
    for (const binding of this.bindings()) this.startupBindings.set(binding.chat_id, binding.activated_at ?? this.startedAt);
    this.startupDiscovery = this.trustedSenders();
  }
  private now(): number {
    const local = this.startedAt + (this.monotonic() - this.startedMono);
    const provider = this.options.api.serverTime?.();
    if (provider !== undefined && Number.isFinite(provider) && Math.abs(provider - local) > OVERLAP_MS) this.clockOffset = provider - local;
    return Math.floor(local + this.clockOffset);
  }
  async start(): Promise<void> {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.task = this.run(controller.signal);
  }
  async stop(): Promise<void> {
    const controller = this.controller;
    this.controller = undefined;
    controller?.abort();
    await this.task;
  }
  private async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let healthy = false; let globalFailure = false;
      try { healthy = await this.pollOnce(signal); globalFailure = this.storageFailed; }
      catch (error) { globalFailure = true; if (!signal.aborted) this.failure(error); }
      if (signal.aborted) return;
      this.options.status(healthy ? 'ready' : 'failed');
      // One conversation's outage must not slow every other conversation.
      failures = globalFailure ? failures + 1 : 0;
      try { await this.wait(Math.min(30_000, INTERVAL_MS * 2 ** Math.min(failures, 4)), signal); }
      catch { if (signal.aborted) return; throw new Error('Feishu polling delay failed'); }
    }
  }
  private failure(error: unknown, chat_id?: string): void {
    this.options.report({ source: 'lark', status: 'lark_failed', ...(chat_id ? { chat_id } : {}), error: (error as Error).message });
  }
  private async request<T>(path: string, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const delay = REQUEST_INTERVAL_MS - (this.monotonic() - this.lastRequest);
    if (delay > 0) await this.wait(delay, signal);
    signal.throwIfAborted();
    this.lastRequest = this.monotonic();
    return requestLark<T>(this.options.api, 'GET', path, undefined, signal);
  }
  private announcementApi(signal: AbortSignal): LarkApi {
    return { appId: this.options.api.appId, request: <T>(_method: unknown, path: string, _body?: unknown, context?: AbortSignal) =>
      this.request<T>(path, context ? AbortSignal.any([signal, context]) : signal) };
  }
  private bindings(): LarkBinding[] {
    return [...this.options.state.bindings.values()].filter(binding => !binding.app_id || binding.app_id === this.options.api.appId);
  }
  private trustedSenders(): boolean {
    return this.bindings().length > 0 || (process.env.LARK_ALLOWED_OPEN_IDS ?? '').split(',').some(id => id.trim());
  }
  private async save(cursors: readonly LarkPollCursor[], receipts: readonly LarkPollReceipt[] = [], prune: readonly { cursor_id: string; before: number }[] = []): Promise<void> {
    await this.options.state.saveLarkPollProgress(cursors, receipts, prune);
    for (const cursor of cursors) if (cursor.container_type === 'thread') {
      const id = larkPollCursorKey(cursor);
      let index = this.threads.get(cursor.chat_id);
      if (!index) { index = new Map(); this.threads.set(cursor.chat_id, index); }
      index.set(id, this.options.state.larkPollCursors.get(id)!);
    }
  }
  private makeChat(chatId: string): LarkPollCursor {
    const binding = this.options.state.bindings.get(chatId);
    const baseline = this.startupBindings.get(chatId) ?? binding?.activated_at ?? this.discovered.get(chatId) ?? this.now();
    const cursor: LarkPollCursor = { app_id: this.options.api.appId, chat_id: chatId, container_type: 'chat', container_id: chatId,
      started_at: Math.floor(baseline), through: Math.floor(baseline) };
    if (binding?.activated_at === undefined && this.startupBindings.has(chatId) && this.options.api.serverTime && this.options.api.serverTime() === undefined) {
      cursor.provisional_clock = true;
    }
    return cursor;
  }
  private async ensureBaselines(): Promise<void> {
    const added: LarkPollCursor[] = [];
    for (const { chat_id: chatId } of this.bindings()) {
      const cursor = this.makeChat(chatId);
      const id = larkPollCursorKey(cursor);
      if (!this.options.state.larkPollCursors.has(id)) { added.push(cursor); if (cursor.provisional_clock) this.provisional.add(id); }
    }
    if (added.length) await this.save(added);
  }
  private async calibrateBaselines(): Promise<void> {
    if (!this.options.api.serverTime) return;
    const provider = this.options.api.serverTime();
    if (provider === undefined || !Number.isFinite(provider)) throw new Error('Feishu did not provide a usable server clock; history progress was not advanced');
    const estimate = this.now() - (this.monotonic() - this.startedMono);
    const changed: LarkPollCursor[] = [];
    for (const cursor of this.options.state.larkPollCursors.values()) {
      if (cursor.app_id !== this.options.api.appId || !cursor.provisional_clock) continue;
      const id = larkPollCursorKey(cursor);
      if (!this.provisional.has(id) && cursor.started_at > provider + OVERLAP_MS) {
        throw new Error('Saved Feishu activation time is ahead of the provider clock; automatic replay is unsafe');
      }
      const next = { ...cursor };
      if (this.provisional.has(id)) { next.started_at = Math.floor(estimate); next.through = next.started_at; }
      delete next.provisional_clock;
      changed.push(next);
    }
    if (changed.length) await this.save(changed);
    this.provisional.clear();
  }
  private async chatCursor(chatId: string): Promise<LarkPollCursor> {
    const candidate = this.makeChat(chatId); const id = larkPollCursorKey(candidate);
    const previous = this.options.state.larkPollCursors.get(id);
    if (previous) return previous;
    if (candidate.provisional_clock) this.provisional.add(id);
    await this.save([candidate]);
    return this.options.state.larkPollCursors.get(id)!;
  }
  private validateMessage(item: LarkHistoryMessage, chatId: string): number {
    const time = Number(item.create_time);
    if (!item.message_id || item.chat_id !== chatId || typeof item.create_time !== 'string' || !/^\d+$/.test(item.create_time) || !Number.isSafeInteger(time) || time < 0) {
      throw new Error('Feishu returned an invalid history message');
    }
    return time;
  }
  private nextPage<T>(page: Page<T>, tokens: Set<string>): string | undefined {
    if (!page || (page.items !== undefined && !Array.isArray(page.items)) || (page.items === undefined && page.has_more !== false)) throw new Error('Feishu returned an invalid history page');
    if (!page.has_more) return;
    if (!page.page_token || tokens.has(page.page_token)) throw new Error('Feishu returned an invalid history page token');
    return page.page_token;
  }
  private async registerTopics(parent: LarkPollCursor, items: readonly LarkHistoryMessage[], end: number): Promise<void> {
    const changed = new Map<string, LarkPollCursor>();
    for (const item of items) {
      const time = this.validateMessage(item, parent.chat_id);
      if (!item.thread_id || time > end) continue;
      const identity = { app_id: parent.app_id, chat_id: parent.chat_id, container_type: 'thread' as const, container_id: item.thread_id };
      const id = larkPollCursorKey(identity);
      const previous = changed.get(id) ?? this.options.state.larkPollCursors.get(id);
      const root_message_id = item.root_id || item.message_id;
      if (!previous || previous.root_message_id !== root_message_id) changed.set(id, previous ? { ...previous, root_message_id }
        : { ...identity, started_at: parent.started_at, through: parent.started_at, root_message_id });
    }
    if (changed.size) await this.save([...changed.values()]);
  }
  private async refreshRoots(cursor: LarkPollCursor, signal: AbortSignal): Promise<void> {
    const now = this.monotonic();
    let scan = this.roots.get(cursor.chat_id);
    if (scan?.complete && now < scan.readyAt) return;
    if (!scan || scan.complete) {
      scan = { end: this.now(), tokens: new Set(), readyAt: 0, failures: 0, complete: false };
      this.roots.set(cursor.chat_id, scan);
    }
    if (now < scan.readyAt) return;
    try {
      for (let budget = 0; budget < ROOT_PAGES_PER_PASS; budget++) {
        const query = new URLSearchParams({ container_id_type: 'chat', container_id: cursor.chat_id, page_size: '50',
          sort_type: 'ByCreateTimeDesc', only_thread_root_messages: 'true', end_time: String(Math.floor(scan.end / 1000) + 1) });
        if (scan.page) query.set('page_token', scan.page);
        const page = await this.request<Page<LarkHistoryMessage>>(`/open-apis/im/v1/messages?${query}`, signal);
        const next = this.nextPage(page, scan.tokens);
        await this.registerTopics(cursor, page.items ?? [], scan.end);
        scan.failures = 0; scan.page = next;
        if (next) scan.tokens.add(next);
        else { scan.complete = true; scan.readyAt = this.monotonic() + DISCOVERY_INTERVAL_MS; break; }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      scan.failures++;
      if (scan.failures >= CONTINUATION_FAILURES) { scan.page = undefined; scan.tokens.clear(); scan.end = this.now(); scan.failures = 0; }
      scan.readyAt = this.monotonic() + DISCOVERY_INTERVAL_MS;
      this.options.report({ source: 'lark', status: 'lark_discovery_failed', chat_id: cursor.chat_id, error: (error as Error).message });
    }
  }
  private compact(item: LarkHistoryMessage, retainBody: boolean): LarkHistoryMessage {
    return { message_id: item.message_id, chat_id: item.chat_id, create_time: item.create_time, msg_type: item.msg_type,
      deleted: item.deleted, thread_id: item.thread_id, root_id: item.root_id, sender: item.sender, ...(retainBody ? { body: item.body } : {}) };
  }
  private async collect(cursor: LarkPollCursor, signal: AbortSignal, end: number, buffer: LarkHistoryBuffer): Promise<Scan> {
    if (cursor.started_at > end + OVERLAP_MS || cursor.through > end + OVERLAP_MS) {
      throw new Error('Saved Feishu progress is ahead of the provider clock; preserve state and reconcile it before replaying commands');
    }
    const scan: Scan = { cursor, end, lower: Math.max(cursor.started_at, cursor.through - OVERLAP_MS), covered: cursor.through,
      providerClock: this.options.api.serverTime?.() !== undefined };
    const tokens = new Set<string>(); let pageToken: string | undefined;
    let root = cursor.root_message_id;
    do {
      signal.throwIfAborted();
      const query = new URLSearchParams({ container_id_type: cursor.container_type, container_id: cursor.container_id, page_size: '50',
        sort_type: cursor.container_type === 'thread' ? 'ByCreateTimeDesc' : 'ByCreateTimeAsc' });
      if (cursor.container_type === 'chat') {
        query.set('start_time', String(Math.max(0, Math.floor(scan.lower / 1000) - 1)));
        query.set('end_time', String(Math.floor(end / 1000) + 1));
        query.set('only_thread_root_messages', 'true');
      }
      if (pageToken) query.set('page_token', pageToken);
      const page = await this.request<Page<LarkHistoryMessage>>(`/open-apis/im/v1/messages?${query}`, signal);
      pageToken = this.nextPage(page, tokens);
      if (pageToken) tokens.add(pageToken);
      const items = page.items ?? [];
      if (cursor.container_type === 'chat') await this.registerTopics(cursor, items, end);
      const entries: LarkHistoryEntry[] = [];
      for (const item of items) {
        const time = this.validateMessage(item, cursor.chat_id);
        if (!root && cursor.container_type === 'thread' && item.root_id) root = item.root_id;
        if (time < scan.lower) { if (cursor.container_type === 'thread') { pageToken = undefined; break; } continue; }
        if (time > end) continue;
        scan.covered = Math.max(scan.covered, time);
        const eligible = !item.deleted && item.sender?.sender_type === 'user' && item.sender.id_type === 'open_id' && item.msg_type === 'text';
        const dispatch = eligible && !(cursor.container_type === 'thread' && item.message_id === root);
        const known = this.options.state.hasLarkPollReceipt(larkPollCursorKey(cursor), item.message_id);
        entries.push({ cursor_id: larkPollCursorKey(cursor), item: this.compact(item, dispatch && !known), dispatch: dispatch && !known });
      }
      if (cursor.container_type === 'thread' && !cursor.root_message_id && root) {
        cursor = { ...cursor, root_message_id: root }; scan.cursor = cursor; await this.save([cursor]);
      }
      buffer.append(entries);
    } while (pageToken);
    if (cursor.container_type === 'thread' && !cursor.root_message_id && root === undefined) {
      // Empty histories are safe; a legacy rootless cursor with new input needs metadata repair first.
      if (scan.covered > cursor.through) throw new Error('The topic root is unknown; waiting for the bounded root index refresh');
    }
    return scan;
  }
  private async dispatch(scans: readonly Scan[], buffer: LarkHistoryBuffer, signal: AbortSignal): Promise<void> {
    const byId = new Map(scans.map(scan => [larkPollCursorKey(scan.cursor), scan]));
    let pending: LarkPollReceipt[] = [];
    let prefix = -Infinity; let checkpointFailed = false;
    const flush = async () => {
      if (!pending.length) return;
      // Every stream for this window is already staged. A processed chronological prefix
      // is a safe provider-time frontier, including for streams with no rows in that prefix.
      const cursors = scans.map(scan => ({ ...scan.cursor, through: Math.max(scan.cursor.through, prefix) }));
      try {
        await this.save(cursors, pending, cursors.map(cursor => ({ cursor_id: larkPollCursorKey(cursor), before: cursor.through - OVERLAP_MS })));
      } catch (error) { checkpointFailed = true; throw error; }
      for (const scan of scans) scan.cursor = this.options.state.larkPollCursors.get(larkPollCursorKey(scan.cursor))!;
      pending = [];
    };
    let after: { time: number; sequence: number } | undefined;
    try {
      for (;;) {
        const batch = buffer.read(after, CHECKPOINT_MESSAGES);
        if (!batch.length) break;
        for (const record of batch) {
          signal.throwIfAborted();
          const known = record.cursor_ids.some(id => this.options.state.hasLarkPollReceipt(id, record.item.message_id));
          if (!known && record.dispatch) {
            const origin = record.cursor_ids.map(id => byId.get(id)!).find(scan => scan.cursor.container_type === 'thread') ?? byId.get(record.cursor_ids[0])!;
            const accepted = await this.options.receive({ sender: { sender_type: 'user', sender_id: { open_id: record.item.sender?.id } },
              message: { chat_id: record.item.chat_id, message_id: record.item.message_id, message_type: record.item.msg_type,
                content: record.item.body?.content, thread_id: record.item.thread_id ?? (origin.cursor.container_type === 'thread' ? origin.cursor.container_id : undefined) } });
            if (!accepted) throw new Error('Feishu message delivery is waiting for a safe retry');
          }
          for (const id of record.cursor_ids) if (!this.options.state.hasLarkPollReceipt(id, record.item.message_id)) {
            pending.push({ cursor_id: id, message_id: record.item.message_id, create_time: record.time });
          }
          prefix = Math.max(prefix, record.time);
          after = { time: record.time, sequence: record.sequence };
        }
        // Abrupt death cannot strand more than one small batch outside the durable receipt index.
        await flush();
      }
    } finally { if (!checkpointFailed) await flush(); }
    signal.throwIfAborted();
    for (const scan of scans) {
      const through = Math.max(scan.cursor.through, scan.covered, scan.providerClock ? scan.end : scan.cursor.through);
      if (through !== scan.cursor.through) this.progress.set(larkPollCursorKey(scan.cursor), { ...scan.cursor, through });
    }
  }
  private async conversation(chatId: string, signal: AbortSignal): Promise<void> {
    const cursor = await this.chatCursor(chatId);
    const end = this.now();
    const buffer = await LarkHistoryBuffer.open(this.options.state.directory);
    try {
      const scans: Scan[] = [await this.collect(cursor, signal, end, buffer)];
      await this.refreshRoots(cursor, signal);
      for (const topic of this.threads.get(chatId)?.values() ?? []) scans.push(await this.collect(topic, signal, end, buffer));
      await this.dispatch(scans, buffer, signal);
    } finally { await buffer.close(); }
  }
  private newDiscovery(): Discovery {
    return { tokens: new Set(), queue: [], members: new Set(), listed: false, retryAt: -Infinity, failures: 0,
      initial: !this.initialDiscoveryDone && this.startupDiscovery };
  }
  private async discover(signal: AbortSignal): Promise<void> {
    if (!this.trustedSenders() || (!this.discovery && this.monotonic() < this.discoveryAt)) return;
    const sweep = this.discovery ??= this.newDiscovery();
    if (!sweep.listed && this.monotonic() >= sweep.retryAt) {
      try {
        const query = new URLSearchParams({ page_size: '100' });
        if (sweep.page) query.set('page_token', sweep.page);
        const page = await this.request<Page<{ chat_id?: string }>>(`/open-apis/im/v1/chats?${query}`, signal);
        const next = this.nextPage(page, sweep.tokens);
        for (const chat of page.items ?? []) {
          if (!chat.chat_id || typeof chat.chat_id !== 'string') throw new Error('Feishu returned an invalid group list item');
          if (!sweep.members.has(chat.chat_id)) sweep.queue.push(chat.chat_id);
          sweep.members.add(chat.chat_id);
        }
        sweep.page = next; if (next) sweep.tokens.add(next);
        sweep.listed = !next; sweep.failures = 0;
      } catch (error) {
        if (signal.aborted) throw error;
        sweep.retryAt = this.monotonic() + DISCOVERY_INTERVAL_MS;
        this.options.report({ source: 'lark', status: 'lark_discovery_failed', error: (error as Error).message });
        if (++sweep.failures >= CONTINUATION_FAILURES) {
          // Abandon only this traversal, not monitored groups or their durable progress.
          this.discovery = undefined; this.discoveryAt = sweep.retryAt; return;
        }
      }
    }
    for (let count = 0; sweep.queue.length && count < 5; count++) {
      const chatId = sweep.queue.shift()!;
      if (this.options.state.bindings.has(chatId)) continue;
      try {
        const route = parseAnnouncement((await readAnnouncement(this.announcementApi(signal), chatId)).content);
        if ((!route.host_id || route.host_id === hostname()) && isAdapter(route.adapter)) {
          if (!this.discovered.has(chatId)) this.discovered.set(chatId, sweep.initial ? this.startedAt + this.clockOffset : this.now());
        } else this.discovered.delete(chatId);
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof InvalidAnnouncement) this.discovered.delete(chatId);
        else this.options.report({ source: 'lark', status: 'lark_discovery_failed', chat_id: chatId, error: (error as Error).message });
      }
    }
    if (sweep.listed && !sweep.queue.length) {
      for (const id of this.discovered.keys()) if (!sweep.members.has(id)) { this.discovered.delete(id); this.roots.delete(id); this.retries.delete(id); }
      this.initialDiscoveryDone = true; this.discovery = undefined;
      this.discoveryAt = this.monotonic() + DISCOVERY_INTERVAL_MS;
    }
  }
  /** One pass; network/persistence authentication failures remain isolated from unrelated modules. */
  async pollOnce(signal = new AbortController().signal): Promise<boolean> {
    this.storageFailed = false; this.progress.clear();
    signal.throwIfAborted();
    if (!this.cleaned) { await LarkHistoryBuffer.cleanupOrphans(this.options.state.directory); this.cleaned = true; }
    await this.ensureBaselines();
    if (!this.verified) { await this.request('/open-apis/bot/v3/info', signal); this.verified = true; }
    await this.calibrateBaselines();
    this.threads.clear();
    for (const [id, cursor] of this.options.state.larkPollCursors) if (cursor.app_id === this.options.api.appId && cursor.container_type === 'thread') {
      let index = this.threads.get(cursor.chat_id);
      if (!index) { index = new Map(); this.threads.set(cursor.chat_id, index); }
      index.set(id, cursor);
    }
    await this.discover(signal);
    const chats = new Set([...this.bindings().map(binding => binding.chat_id), ...this.discovered.keys()]);
    let healthy = true;
    try {
      for (const chatId of chats) {
        signal.throwIfAborted();
        if (this.options.state.bindings.get(chatId)?.announcement_pending) continue;
        const prior = this.retries.get(chatId);
        if (prior && this.monotonic() < prior.at) { healthy = false; continue; }
        try { await this.conversation(chatId, signal); this.retries.delete(chatId); }
        catch (error) {
          if (signal.aborted) throw error;
          healthy = false;
          const failures = (prior?.failures ?? 0) + 1;
          this.retries.set(chatId, { failures, at: this.monotonic() + Math.min(30_000, INTERVAL_MS * 2 ** Math.min(failures, 4)) });
          this.failure(error, chatId);
        }
      }
    } finally {
      if (this.progress.size) {
        const cursors = [...this.progress.values()];
        try { await this.save(cursors, [], cursors.map(cursor => ({ cursor_id: larkPollCursorKey(cursor), before: cursor.through - OVERLAP_MS }))); }
        catch (error) { this.storageFailed = true; healthy = false; this.failure(error); }
        this.progress.clear();
      }
    }
    return healthy;
  }
}
