import { ChatTransportError, textChunks, validChatConfig, type ChatLocation, type ChatMessage, type ChatTransport, type SentChatMessage, type TelegramConfig } from './chat-transport.js';

/** Optional runtime seams keep tests off Telegram and make retry/timeout behavior deterministic. */
export interface TelegramTransportOptions {
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  pollTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

type Status = 'ready' | 'reconnecting' | 'failed';
type Method = 'getMe' | 'getChat' | 'getChatMember' | 'getWebhookInfo' | 'createForumTopic' | 'sendMessage' | 'getUpdates';
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function id(value: unknown, negative = false): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (negative ? number >= 0 : number <= 0)) return;
  const normalized = String(number);
  if (typeof value === 'string' && normalized !== value) return;
  return normalized;
}
function updateId(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 && number < Number.MAX_SAFE_INTEGER ? number : undefined;
}

/** No remote description, request URL, fetch error, or error cause may escape this module. */
class TelegramError extends ChatTransportError {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs = 0) { super(message); this.name = 'TelegramError'; }
}
function apiError(method: Method, code: unknown, retryAfter: unknown): TelegramError {
  if (code === 409) return new TelegramError('Telegram polling conflict: a webhook or another getUpdates poller is using this bot. Stop the other receiver before starting Nootify.');
  if (code === 401) return new TelegramError('Telegram rejected the bot credentials.');
  if (code === 403) return new TelegramError(`Telegram denied permission for ${method}. Check the bot's forum administrator permissions.`);
  const status = typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : undefined;
  const retry = status === undefined || status === 429 || status >= 500;
  const retryAfterMs = typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter, 86_400) * 1000 : 0;
  return new TelegramError(`Telegram ${method} ${status ? `failed (${status})` : 'returned an invalid response'}.`, retry, retryAfterMs);
}
function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new TelegramError('Invalid Telegram timeout or retry configuration.');
  return value;
}

/** Also retires injected operations which ignore AbortSignal; their eventual rejection stays handled. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new TelegramError('Telegram operation stopped.')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
  });
}

interface Run {
  controller: AbortController;
  receive: (message: ChatMessage) => Promise<void>;
  status: (status: Status) => void;
  lastStatus?: Status;
  started: Promise<void>;
  resolve: () => void;
  reject: (error: TelegramError) => void;
  task?: Promise<void>;
}

class TelegramTransport implements ChatTransport {
  readonly identity: string;
  readonly account: string;
  private run?: Run;
  private initialized = false;
  private offset = 0;
  private readonly requestTimeout: number;
  private readonly pollTimeout: number;
  private readonly retryBase: number;
  private readonly retryMax: number;
  private readonly wait: NonNullable<TelegramTransportOptions['wait']>;

  constructor(private readonly config: TelegramConfig, botId: string, username: string, options: TelegramTransportOptions,
    private readonly request: (method: Method, body?: JsonObject, signal?: AbortSignal, timeout?: number) => Promise<unknown>) {
    this.identity = `telegram:${botId}:${config.chat_id}`;
    this.account = `@${username}`;
    this.requestTimeout = positive(options.requestTimeoutMs, 10_000);
    this.pollTimeout = positive(options.pollTimeoutMs, 35_000);
    this.retryBase = positive(options.retryBaseMs, 500);
    this.retryMax = positive(options.retryMaxMs, 30_000);
    this.wait = options.wait ?? wait;
  }

  private current(run: Run): boolean { return this.run === run && !run.controller.signal.aborted; }
  private report(run: Run, status: Status): void {
    if (!this.current(run) || run.lastStatus === status) return;
    run.lastStatus = status;
    try { Promise.resolve(run.status(status)).catch(() => {}); } catch { /* Status observers cannot break polling. */ }
  }
  start(receive: Run['receive'], status: Run['status']): Promise<void> {
    if (this.run) return this.run.started;
    let resolve!: () => void; let reject!: (error: TelegramError) => void;
    const started = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    const run: Run = { controller: new AbortController(), receive, status, started, resolve, reject };
    this.run = run;
    run.task = this.poll(run).then(() => run.resolve(), error => {
      if (this.current(run)) {
        this.report(run, 'failed');
        run.reject(error instanceof TelegramError ? error : new TelegramError('Telegram polling failed.'));
      } else run.resolve();
    }).finally(() => { if (this.run === run) this.run = undefined; });
    return started;
  }
  async stop(): Promise<void> {
    const run = this.run;
    if (!run) return;
    // Retire callbacks before aborting: even synchronous abort handlers belong to the old run.
    this.run = undefined;
    run.controller.abort(); run.resolve();
    await run.task;
  }

  private select(update: JsonObject): ChatMessage | undefined {
    if ('edited_message' in update || 'edited_channel_post' in update || 'channel_post' in update) return;
    const message = object(update.message); const sender = object(message?.from); const chat = object(message?.chat);
    if (!message || 'sender_chat' in message || 'edit_date' in message || message.is_topic_message !== true ||
        sender?.is_bot !== false || id(sender.id) !== this.config.user_id || chat?.type !== 'supergroup' ||
        id(chat.id, true) !== this.config.chat_id || typeof message.text !== 'string' || !message.text.trim()) return;
    const threadId = id(message.message_thread_id); const messageId = id(message.message_id);
    if (!threadId || !messageId) return;
    return { chat_id: this.config.chat_id, thread_id: threadId, message_id: messageId, sender_id: this.config.user_id, text: message.text };
  }
  private async poll(run: Run): Promise<void> {
    // A restarted transport already has its cursor; start must not wait for a 25-second poll.
    if (this.initialized) { this.report(run, 'ready'); run.resolve(); }
    let failures = 0;
    while (this.current(run)) {
      try {
        const seeking = !this.initialized;
        const result = await this.request('getUpdates', {
          offset: seeking ? -1 : this.offset, timeout: seeking ? 0 : 25,
          ...(seeking ? { limit: 1 } : {}), allowed_updates: ['message'],
        }, run.controller.signal, seeking ? this.requestTimeout : this.pollTimeout);
        if (!this.current(run)) return;
        if (!Array.isArray(result)) throw apiError('getUpdates', undefined, undefined);
        const updates = result.map(value => ({ value: object(value), id: updateId(object(value)?.update_id) }))
          .filter((entry): entry is { value: JsonObject; id: number } => entry.value !== undefined && entry.id !== undefined)
          .sort((left, right) => left.id - right.id);
        if (seeking) {
          if (updates.length !== result.length) throw apiError('getUpdates', undefined, undefined);
          // Negative offset drops the backlog; never dispatch even its last update as a new command.
          this.offset = updates.length ? updates[updates.length - 1].id + 1 : 0;
          this.initialized = true;
        }
        failures = 0;
        this.report(run, 'ready'); run.resolve();
        if (seeking) continue;
        for (const update of updates) {
          if (!this.current(run)) return;
          if (update.id < this.offset) continue;
          this.offset = update.id + 1;
          const message = this.select(update.value);
          if (!message) continue;
          try {
            await abortable(Promise.resolve().then(() => { if (this.current(run)) return run.receive(message); }), run.controller.signal);
          } catch {
            if (!this.current(run)) return;
            this.report(run, 'failed');
          }
        }
      } catch (error) {
        if (!this.current(run)) return;
        if (!(error instanceof TelegramError) || !error.retryable) throw error;
        this.report(run, 'reconnecting');
        const delay = Math.min(this.retryMax, Math.max(error.retryAfterMs, this.retryBase * 2 ** Math.min(failures++, 30)));
        try { await abortable(Promise.resolve().then(() => this.wait(delay, run.controller.signal)), run.controller.signal); }
        catch { if (this.current(run)) throw new TelegramError('Telegram retry wait failed.'); else return; }
      }
    }
  }

  async openThread(title: string): Promise<ChatLocation> {
    const name = Array.from(title.trim() || 'Nootify').slice(0, 128).join('');
    const topic = object(await this.request('createForumTopic', { chat_id: this.config.chat_id, name }));
    const threadId = id(topic?.message_thread_id);
    if (!threadId) throw new TelegramError('Telegram returned an invalid forum topic.');
    return { chat_id: this.config.chat_id, thread_id: threadId };
  }
  async send(location: ChatLocation, text: string, replyTo?: string): Promise<SentChatMessage> {
    const threadId = id(location.thread_id);
    if (location.chat_id !== this.config.chat_id || !threadId) throw new TelegramError('Invalid Telegram forum topic destination.');
    if (typeof text !== 'string' || !text.trim()) throw new TelegramError('Telegram messages must contain text.');
    const replyId = replyTo === undefined ? undefined : id(replyTo);
    // The caller's durable origin binding proves which topic owns this reply target.
    if (replyTo !== undefined && !replyId) throw new TelegramError('Invalid Telegram reply message ID.');
    let messageId = '';
    for (const chunk of textChunks(text, 3500)) {
      const result = object(await this.request('sendMessage', {
        chat_id: this.config.chat_id, message_thread_id: Number(threadId), text: chunk,
        ...(replyId && !messageId ? { reply_parameters: { message_id: Number(replyId), allow_sending_without_reply: false } } : {}),
      }));
      const sentId = id(result?.message_id); const chat = object(result?.chat);
      if (!sentId || id(chat?.id, true) !== this.config.chat_id || id(result?.message_thread_id) !== threadId) throw new TelegramError('Telegram returned an invalid topic message.');
      messageId = sentId;
    }
    return { message_id: messageId };
  }
}

export async function createTelegramTransport(config: TelegramConfig, options: TelegramTransportOptions = {}): Promise<ChatTransport> {
  if (!validChatConfig('telegram', config) || !id(config.chat_id, true) || !id(config.user_id)) throw new TelegramError('Invalid Telegram configuration.');
  // Copy settings: changing the caller's object must not bypass the verified chat/user boundary.
  config = { ...config };
  const fetch = options.fetch ?? globalThis.fetch;
  const requestTimeout = positive(options.requestTimeoutMs, 10_000);
  positive(options.pollTimeoutMs, 35_000);
  if (positive(options.retryMaxMs, 30_000) < positive(options.retryBaseMs, 500)) throw new TelegramError('Invalid Telegram retry configuration.');
  const request = async (method: Method, body: JsonObject = {}, signal?: AbortSignal, timeout = requestTimeout): Promise<unknown> => {
    if (signal?.aborted) throw new TelegramError('Telegram operation stopped.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    try {
      return await abortable((async () => {
        const response = await fetch(`https://api.telegram.org/bot${config.bot_token}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          signal: controller.signal, redirect: 'error',
        });
        let payload: JsonObject | undefined;
        try { payload = object(await response.json()); } catch { /* Handle malformed responses without their raw errors. */ }
        if (!response.ok || payload?.ok !== true) throw apiError(method, !response.ok ? response.status : payload?.error_code, object(payload?.parameters)?.retry_after);
        return payload.result;
      })(), controller.signal);
    } catch (error) {
      if (signal?.aborted) throw new TelegramError('Telegram operation stopped.');
      if (timedOut) throw new TelegramError(`Telegram ${method} request timed out.`, true);
      if (error instanceof TelegramError) throw error;
      throw new TelegramError(`Telegram ${method} network request failed.`, true);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };

  const bot = object(await request('getMe')); const botId = id(bot?.id);
  if (!botId || bot?.is_bot !== true || typeof bot.username !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(bot.username)) throw new TelegramError('Telegram getMe did not identify a bot with a username.');
  const chat = object(await request('getChat', { chat_id: config.chat_id }));
  if (id(chat?.id, true) !== config.chat_id || chat?.type !== 'supergroup' || chat.is_forum !== true) throw new TelegramError('Telegram requires the configured chat to be a forum supergroup.');
  const membership = object(await request('getChatMember', { chat_id: config.chat_id, user_id: Number(botId) }));
  const memberBot = object(membership?.user);
  if (id(memberBot?.id) !== botId || memberBot?.is_bot !== true || !(membership?.status === 'creator' || membership?.status === 'administrator' && membership.can_manage_topics === true)) throw new TelegramError('Telegram bot must be a forum administrator with permission to manage topics.');
  const owner = object(await request('getChatMember', { chat_id: config.chat_id, user_id: Number(config.user_id) }));
  const user = object(owner?.user);
  if (id(user?.id) !== config.user_id || user?.is_bot !== false) throw new TelegramError('Telegram trusted user must be a verified human account.');
  const webhook = object(await request('getWebhookInfo'));
  if (typeof webhook?.url !== 'string') throw new TelegramError('Telegram returned invalid webhook information.');
  if (webhook.url) throw new TelegramError('Telegram bot already has a webhook. Remove it explicitly before using Nootify polling.');
  return new TelegramTransport(config, botId, bot.username, options, request);
}
