import { setTimeout as wait } from 'node:timers/promises';
import type { LarkThreads } from './lark-threads.js';
import type { State } from './state.js';
import type { ThreadRequest } from './types.js';

export type ThreadDiscovery = (signal: AbortSignal) => AsyncIterable<ThreadRequest>;
interface Options {
  state: State;
  threads: LarkThreads;
  discover: ThreadDiscovery;
  report(record: Record<string, unknown>): void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
const INTERVAL_MS = 60_000;

/** Backfills old conversations through the same idempotent path as thread-open. */
export class LarkThreadSync {
  private controller?: AbortController;
  private task?: Promise<void>;
  private readonly wait: NonNullable<Options['wait']>;
  constructor(private readonly options: Options) {
    this.wait = options.wait ?? (async (ms, signal) => { await wait(ms, undefined, { signal, ref: false }); });
  }
  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    this.task = this.run(this.controller.signal);
  }
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.task;
    this.controller = undefined;
  }
  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.reconcile(signal); }
      catch (error) {
        if (!signal.aborted) this.options.report({ source: 'lark', status: 'lark_discovery_failed', error: (error as Error).message });
      }
      if (signal.aborted) return;
      try { await this.wait(INTERVAL_MS, signal); }
      catch { if (signal.aborted) return; }
    }
  }
  async reconcile(signal = new AbortController().signal): Promise<void> {
    const { state, threads } = this.options;
    const recipient = threads.recipient()?.open_id;
    const enrolled = () => (state.settings.notification_channel ?? 'feishu') === 'feishu' && threads.recipient()?.open_id === recipient;
    if (!recipient || !enrolled()) return;
    const seen = new Set<string>();
    for await (const session of this.options.discover(signal)) {
      signal.throwIfAborted();
      if (!enrolled()) return;
      const key = `${session.adapter}:${session.session_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const binding = threads.binding(session.session_id, session.adapter);
      if (binding && !binding.announcement_pending) continue;
      try { await threads.open(session.adapter, session.session_id, session.session_name, signal); }
      catch (error) {
        if (signal.aborted) throw error;
        this.options.report({ source: 'lark', status: 'thread_failed', session_id: session.session_id,
          session_name: session.session_name, error: (error as Error).message });
      }
    }
  }
}
