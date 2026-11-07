import WebSocket from 'ws';
import { ChatTransportError, textChunks, validChatConfig } from './chat-transport.js';
import type { ChatDirectory, ChatLocation, ChatMessage, ChatTransport, SentChatMessage, SlackConfig } from './chat-transport.js';

const API_TIMEOUT = 15_000;
const CONNECT_TIMEOUT = 10_000;
const START_TIMEOUT = 30_000;
const HEARTBEAT_INTERVAL = 30_000;
const MAX_PAYLOAD = 256 * 1024;
const MAX_PENDING_ACKS = 128;
const MAX_QUEUED_MESSAGES = 100;
const MAX_SEEN_MESSAGES = 2_048;
const MAX_API_REQUESTS = 4;
const MAX_TEXT = 128_000;
const TIMESTAMP = /^\d{1,16}\.\d{6}$/;

type Json = Record<string, unknown>;
type Method = 'auth.test' | 'conversations.info' | 'conversations.list' | 'conversations.members' | 'users.info' | 'apps.connections.open' | 'chat.postMessage' | 'reactions.add';
type Status = Parameters<ChatTransport['start']>[1];

/** Small injectable boundary; production always uses fetch and ws with the options below. */
export interface SlackSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string, callback: (error?: Error) => void): void;
  ping(): void;
  terminate(): void;
}
export interface SlackSocketOptions {
  maxPayload: number;
  handshakeTimeout: number;
  followRedirects: false;
  perMessageDeflate: false;
}
export interface SlackClient {
  fetch: typeof globalThis.fetch;
  webSocket: (url: string, options: SlackSocketOptions) => SlackSocket;
}

class SlackError extends ChatTransportError {
  constructor(message: string, readonly permanent = false, readonly directoryUnavailable = false) { super(message); }
}
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && TIMESTAMP.test(value);

function apiFailure(method: Method, code?: unknown): SlackError {
  // Only fixed, local text may leave this boundary. Slack/fetch/ws errors can contain credentials.
  const error = typeof code === 'string' ? code : '';
  if (error === 'ratelimited') return new SlackError('Slack rate limit reached; try again later.');
  if (error === 'missing_scope' || error === 'not_allowed_token_type') {
    return new SlackError('Slack credentials are missing the required bot or Socket Mode permissions.', true, true);
  }
  if (['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'].includes(error)) {
    return new SlackError('Slack credentials are invalid or expired.', true);
  }
  if ((method === 'conversations.members' || method === 'users.info') && ['channel_not_found', 'not_in_channel', 'no_permission', 'user_not_found'].includes(error)) {
    return new SlackError('Slack directory information is unavailable.', false, true);
  }
  if (method === 'conversations.info' && ['channel_not_found', 'not_in_channel', 'no_permission'].includes(error)) {
    return new SlackError('Slack channel is unavailable. Invite the bot to the configured public or private channel.');
  }
  return new SlackError(`Slack ${method} request failed.`);
}

class SlackApi {
  private inFlight = 0;
  constructor(private readonly config: SlackConfig, private readonly client: SlackClient) {}

  async request(method: Method, parameters: Json = {}, signal?: AbortSignal): Promise<Json> {
    if (signal?.aborted) throw new SlackError('Slack operation cancelled.');
    if (this.inFlight >= MAX_API_REQUESTS) throw new SlackError('Slack request capacity reached; try again later.');
    this.inFlight++;
    const controller = new AbortController();
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const cancel = () => { rejectCancelled(new SlackError('Slack operation cancelled.')); controller.abort(); };
    const timer = setTimeout(() => {
      rejectCancelled(new SlackError('Slack API request timed out.')); controller.abort();
    }, API_TIMEOUT);
    timer.unref?.();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await Promise.race([this.perform(method, parameters, controller.signal), cancelled]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.abort(); // Also releases unread bodies on HTTP/API failures.
      this.inFlight--;
    }
  }

  private async perform(method: Method, parameters: Json, signal: AbortSignal): Promise<Json> {
    const url = new URL(`https://slack.com/api/${method}`);
    const read = method === 'conversations.info' || method === 'conversations.list' || method === 'conversations.members' || method === 'users.info';
    const app = method === 'apps.connections.open';
    const headers: Record<string, string> = {
      authorization: `Bearer ${app ? this.config.app_token : this.config.bot_token}`,
      accept: 'application/json',
    };
    let body: string | undefined;
    if (read) {
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
    } else {
      headers['content-type'] = app ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8';
      body = app ? '' : JSON.stringify(parameters);
    }
    let response: Response;
    try {
      response = await this.client.fetch(url, { method: read ? 'GET' : 'POST', headers, body, signal, redirect: 'error' });
    } catch { throw apiFailure(method); }
    if (!response.ok) throw apiFailure(method, response.status === 429 ? 'ratelimited' : undefined);
    let result: unknown;
    try { result = await response.json(); }
    catch { throw apiFailure(method); }
    if (object(result) && method === 'reactions.add' && result.ok === false && result.error === 'already_reacted') return { ok: true };
    if (!object(result) || result.ok !== true) throw apiFailure(method, object(result) ? result.error : undefined);
    return result;
  }
}

function socketUrl(value: unknown, config: SlackConfig): string {
  const invalid = () => new SlackError('Slack returned an invalid Socket Mode URL.', true);
  if (typeof value !== 'string' || value.length > 4_096 || /[\s\\]/.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  // Socket Mode currently uses wss.slack.com and wss-primary/backup.slack.com.
  // Tickets are expected in the query; userinfo, redirects and arbitrary hosts are never allowed.
  if (url.protocol !== 'wss:' || !/^wss(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.slack\.com$/.test(url.hostname)
    || url.username || url.password || url.hash || url.port || !/^\/link\/?$/.test(url.pathname)
    || !url.searchParams.get('ticket')) throw invalid();
  const parts = [value, ...url.searchParams.values()];
  if (parts.some(part => part.includes(config.bot_token) || part.includes(config.app_token) || /(?:xoxb|xapp)-/i.test(part))) throw invalid();
  return url.href;
}

function label(value: unknown, fallback: string, config: SlackConfig): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\p{C}]/u.test(value)
    || /(?:xoxb|xapp)-/i.test(value) || (config.bot_token && value.includes(config.bot_token))
    || (config.app_token && value.includes(config.app_token))) return fallback;
  return value.trim();
}

/** Escape Slack's control characters so explicit mentions and links remain literal, too. */
function plainChunks(text: string): string[] {
  const chunks: string[] = [];
  for (const plain of textChunks(text, 3_500)) {
    let chunk = '';
    for (const character of plain) {
      const encoded = character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : character;
      if (chunk.length + encoded.length > 3_500) { chunks.push(chunk); chunk = ''; }
      chunk += encoded;
    }
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

interface Connection { socket: SlackSocket; ready: boolean; finish: () => void }
interface Run {
  controller: AbortController;
  receive: Parameters<ChatTransport['start']>[0];
  status: Status;
  lastStatus?: Parameters<Status>[0];
  connection?: Connection;
  queue: ChatMessage[];
  seen: Set<string>;
  draining: boolean;
  started: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  startTimer?: ReturnType<typeof setTimeout>;
  task?: Promise<void>;
}

class SlackTransport implements ChatTransport {
  private run?: Run;
  private operations = new AbortController();
  private stopped = false;
  private initialUrl?: { url: string; time: number };

  constructor(private readonly config: SlackConfig, private readonly api: SlackApi, private readonly client: SlackClient,
    readonly identity: string, readonly account: string, private readonly teamId: string, url: string) {
    this.initialUrl = { url, time: Date.now() };
  }

  start(receive: Run['receive'], status: Status): Promise<void> {
    if (this.run) return this.run.started;
    if (this.stopped) { this.operations = new AbortController(); this.stopped = false; }
    let resolve!: () => void; let reject!: (error: Error) => void;
    const started = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    const run: Run = { controller: new AbortController(), receive, status, queue: [], seen: new Set(), draining: false, started, resolve, reject };
    this.run = run;
    run.startTimer = setTimeout(() => this.fail(run, 'Slack Socket Mode did not become ready in time.'), START_TIMEOUT);
    run.startTimer.unref?.();
    run.task = this.listen(run).catch(() => this.fail(run, 'Slack Socket Mode connection failed.'));
    return started;
  }

  async stop(): Promise<void> {
    const run = this.run;
    this.run = undefined; // Invalidate callbacks before abort/terminate can synchronously call them.
    this.stopped = true;
    this.initialUrl = undefined;
    this.operations.abort();
    if (!run) return;
    this.retire(run);
    await run.task;
  }

  async openThread(title: string): Promise<ChatLocation> {
    this.checkText(title);
    // One session is exactly one root. Long display titles are truncated to one safe message.
    const result = await this.post(plainChunks(title.trim())[0]);
    return { chat_id: this.config.channel_id, thread_id: result.message_id };
  }

  async send(location: ChatLocation, text: string, replyTo?: string): Promise<SentChatMessage> {
    if (location.chat_id !== this.config.channel_id || !timestamp(location.thread_id) || (replyTo !== undefined && !timestamp(replyTo))) {
      throw new SlackError('Slack message location is invalid.');
    }
    this.checkText(text);
    const signal = this.operations.signal;
    let result!: SentChatMessage;
    // Slack has no nested replies: replyTo never replaces the root thread_ts.
    for (const chunk of plainChunks(text)) result = await this.post(chunk, location.thread_id, signal);
    return result;
  }

  async react(location: ChatLocation, messageId: string): Promise<void> {
    if (this.stopped) throw new SlackError('Slack transport is stopped.');
    if (location.chat_id !== this.config.channel_id || !timestamp(location.thread_id) || !timestamp(messageId)) {
      throw new SlackError('Slack reaction location is invalid.');
    }
    await this.api.request('reactions.add', { channel: this.config.channel_id, timestamp: messageId, name: 'sparkling_heart' }, this.operations.signal);
  }

  private checkText(text: string): void {
    if (this.stopped) throw new SlackError('Slack transport is stopped.');
    if (typeof text !== 'string' || !text.trim()) throw new SlackError('Slack message text is empty.');
    if (text.length > MAX_TEXT) throw new SlackError('Slack message text is too large.');
  }

  private async post(text: string, thread?: string, signal = this.operations.signal): Promise<SentChatMessage> {
    const result = await this.api.request('chat.postMessage', {
      channel: this.config.channel_id, text, mrkdwn: false, parse: 'none', link_names: false,
      unfurl_links: false, unfurl_media: false, reply_broadcast: false, ...(thread ? { thread_ts: thread } : {}),
    }, signal);
    if (result.channel !== this.config.channel_id || !timestamp(result.ts)) throw new SlackError('Slack returned an invalid message receipt.');
    return { message_id: result.ts };
  }

  private current(run: Run, connection?: Connection): boolean {
    return this.run === run && !run.controller.signal.aborted && (!connection || run.connection === connection);
  }

  private notify(run: Run, status: Parameters<Status>[0]): void {
    if (!this.current(run) || run.lastStatus === status) return;
    run.lastStatus = status;
    try { run.status(status); } catch { /* Consumer callbacks cannot break Socket Mode acknowledgements. */ }
  }

  private retire(run: Run): void {
    clearTimeout(run.startTimer);
    run.queue.length = 0;
    run.controller.abort();
    run.connection?.finish();
    run.reject(new SlackError('Slack operation cancelled.'));
  }

  private fail(run: Run, message: string): void {
    if (!this.current(run)) return;
    this.run = undefined;
    this.stopped = true;
    this.initialUrl = undefined;
    this.operations.abort();
    run.reject(new SlackError(message));
    this.retire(run);
    // A status callback may immediately start a replacement; retire the old run first.
    if (run.lastStatus !== 'failed') {
      run.lastStatus = 'failed';
      try { run.status('failed'); } catch { /* Consumer status errors remain local. */ }
    }
  }

  private async listen(run: Run): Promise<void> {
    let failures = 0;
    while (this.current(run)) {
      try {
        const cached = this.initialUrl;
        this.initialUrl = undefined;
        const url = cached && Date.now() - cached.time < 10_000 ? cached.url
          : socketUrl((await this.api.request('apps.connections.open', {}, run.controller.signal)).url, this.config);
        if (!this.current(run)) return;
        await this.connect(run, url, () => { failures = 0; });
      } catch (error) {
        if (!this.current(run)) return;
        if (error instanceof SlackError && error.permanent) { this.fail(run, 'Slack Socket Mode credentials or connection URL are invalid.'); return; }
      }
      if (!this.current(run)) return;
      this.notify(run, 'reconnecting');
      const delay = Math.min(500 * 2 ** Math.min(failures++, 6), 30_000);
      await this.delay(run, delay);
    }
  }

  private delay(run: Run, milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); run.controller.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, milliseconds);
      timer.unref?.();
      run.controller.signal.addEventListener('abort', done, { once: true });
      if (run.controller.signal.aborted) done();
    });
  }

  private connect(run: Run, url: string, ready: () => void): Promise<void> {
    const socket = this.client.webSocket(url, {
      maxPayload: MAX_PAYLOAD, handshakeTimeout: CONNECT_TIMEOUT, followRedirects: false, perMessageDeflate: false,
    });
    return new Promise(resolve => {
      let finished = false; let pendingAcks = 0; let awaitingPong = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const connection: Connection = { socket, ready: false, finish: () => {
        if (finished) return;
        finished = true;
        clearTimeout(helloTimeout); clearInterval(heartbeat);
        if (run.connection === connection) run.connection = undefined;
        // ws may emit an error asynchronously after termination of a connecting socket.
        socket.on('error', ignoreError);
        socket.off('message', message); socket.off('error', finish); socket.off('close', finish); socket.off('pong', pong);
        try { socket.terminate(); } catch { /* Never expose a URL-bearing ws error. */ }
        resolve();
      } };
      const finish = () => connection.finish();
      const ignoreError = () => {};
      const pong = () => { if (this.current(run, connection)) awaitingPong = false; };
      const helloTimeout = setTimeout(finish, CONNECT_TIMEOUT);
      helloTimeout.unref?.();
      const message = (data: unknown, binary?: boolean) => {
        if (!this.current(run, connection) || finished || binary) return;
        let text: string;
        if (typeof data === 'string') text = data;
        else if (Buffer.isBuffer(data)) text = data.toString('utf8');
        else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
        else if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
          if (data.reduce((size, item: Buffer) => size + item.length, 0) > MAX_PAYLOAD) { finish(); return; }
          text = Buffer.concat(data).toString('utf8');
        } else return;
        if (Buffer.byteLength(text) > MAX_PAYLOAD) { finish(); return; }
        let envelope: unknown;
        try { envelope = JSON.parse(text); } catch { return; }
        if (!object(envelope)) return;
        // ACK all envelope types, including ignored events/interactive payloads, before invoking consumers.
        if (typeof envelope.envelope_id === 'string' && envelope.envelope_id.length > 0 && envelope.envelope_id.length <= 256) {
          // A congested wire cannot safely retain more ACK callbacks; closing leaves Slack free to retry.
          if (socket.readyState !== WebSocket.OPEN || pendingAcks >= MAX_PENDING_ACKS || socket.bufferedAmount > MAX_PAYLOAD) { finish(); return; }
          pendingAcks++;
          try {
            socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }), error => {
              pendingAcks--;
              if (error && this.current(run, connection)) finish();
            });
          } catch { pendingAcks--; finish(); return; }
          if (finished) return;
        } else if (envelope.type === 'events_api') return;
        if (envelope.type === 'hello') {
          if (connection.ready) return;
          connection.ready = true;
          clearTimeout(helloTimeout); clearTimeout(run.startTimer);
          ready(); run.resolve(); this.notify(run, 'ready');
          if (!this.current(run, connection)) return;
          heartbeat = setInterval(() => {
            if (!this.current(run, connection)) return;
            if (awaitingPong || socket.readyState !== WebSocket.OPEN) { finish(); return; }
            awaitingPong = true;
            try { socket.ping(); } catch { finish(); }
          }, HEARTBEAT_INTERVAL);
          heartbeat.unref?.();
        } else if (envelope.type === 'disconnect') finish();
        else if (envelope.type === 'events_api' && connection.ready) this.incoming(run, envelope.payload);
      };
      run.connection = connection;
      socket.on('message', message); socket.on('error', finish); socket.on('close', finish); socket.on('pong', pong);
      if (!this.current(run, connection)) finish();
    });
  }

  private incoming(run: Run, payload: unknown): void {
    if (!object(payload) || payload.type !== 'event_callback' || payload.team_id !== this.teamId || !object(payload.event)) return;
    const event = payload.event;
    if (event.type !== 'message' || event.subtype !== undefined || event.edited !== undefined || event.hidden === true || event.bot_id !== undefined
      || event.bot_profile !== undefined || event.app_id !== undefined || event.channel !== this.config.channel_id
      || event.user !== this.config.user_id || !timestamp(event.ts) || !timestamp(event.thread_ts)
      || typeof event.text !== 'string' || !event.text.trim() || event.text.length > MAX_TEXT) return;
    if (run.seen.has(event.ts)) return;
    // ACKs remain independent of a slow consumer. Saturation is an explicit failed status, not unbounded memory.
    if (run.queue.length >= MAX_QUEUED_MESSAGES) { this.notify(run, 'failed'); return; }
    run.seen.add(event.ts);
    if (run.seen.size > MAX_SEEN_MESSAGES) run.seen.delete(run.seen.values().next().value!);
    run.queue.push({ chat_id: this.config.channel_id, thread_id: event.thread_ts, message_id: event.ts, sender_id: this.config.user_id, text: event.text });
    if (!run.draining) {
      run.draining = true;
      queueMicrotask(() => { void this.drain(run); });
    }
  }

  private async drain(run: Run): Promise<void> {
    try {
      while (this.current(run) && run.queue.length) {
        const message = run.queue.shift()!;
        try { await run.receive(message); }
        catch { this.notify(run, 'failed'); }
      }
    } finally { run.draining = false; }
  }
}

/** Visible member channels and active humans in the selected room; limited signals incomplete discovery. */
export async function slackDirectory(config: SlackConfig): Promise<ChatDirectory> {
  if (typeof config.bot_token !== 'string' || config.bot_token.length > 512 || !/^xoxb-[A-Za-z0-9-]+$/.test(config.bot_token)
    || (config.channel_id && !/^[CG][A-Z0-9]+$/.test(config.channel_id))) {
    throw new SlackError('Slack directory requires a valid bot token and optional channel ID.', true);
  }
  const snapshot = { ...config };
  const api = new SlackApi(snapshot, { fetch: globalThis.fetch, webSocket: () => { throw new SlackError('Slack directory does not use Socket Mode.'); } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  timer.unref?.();
  const result: ChatDirectory = { users: [], chats: [], limited: !snapshot.channel_id };
  let requests = 0;
  const request = (method: Method, parameters: Json = {}) => {
    if (++requests > 60) throw new SlackError('Slack directory request limit reached.');
    return api.request(method, parameters, controller.signal);
  };
  // Empty pages can still have cursors. Repeated, oversized and excessive cursors stop discovery explicitly.
  const pages = async (method: 'conversations.list' | 'conversations.members', parameters: Json, field: string): Promise<unknown[]> => {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      let response: Json;
      try { response = await request(method, { ...parameters, limit: 200, ...(cursor ? { cursor } : {}) }); }
      catch (error) {
        if (!(error instanceof SlackError && error.directoryUnavailable)) throw error;
        result.limited = true; return items;
      }
      const values = response[field];
      if (!Array.isArray(values)) throw new SlackError('Slack returned an invalid directory response.');
      items.push(...values.slice(0, 200));
      if (values.length > 200) result.limited = true;
      const metadata = response.response_metadata;
      if (metadata !== undefined && !object(metadata)) throw new SlackError('Slack returned invalid directory pagination.');
      const next = object(metadata) ? metadata.next_cursor : undefined;
      if (next === undefined || next === '') return items;
      if (typeof next !== 'string' || next.length > 2_048 || /[\p{C}]/u.test(next)) {
        throw new SlackError('Slack returned invalid directory pagination.');
      }
      if (seen.has(next)) { result.limited = true; return items; }
      seen.add(next); cursor = next;
    }
    result.limited = true;
    return items;
  };
  try {
    const auth = await request('auth.test');
    if (typeof auth.user_id !== 'string' || !/^[UW][A-Z0-9]+$/.test(auth.user_id)
      || typeof auth.bot_id !== 'string' || !/^B[A-Z0-9]+$/.test(auth.bot_id)
      || typeof auth.team_id !== 'string' || !/^T[A-Z0-9]+$/.test(auth.team_id)) {
      throw new SlackError('Slack auth.test did not verify a bot and workspace.', true);
    }
    const channels = await pages('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true }, 'channels');
    const chatIds = new Set<string>();
    for (const channel of channels) {
      if (!object(channel) || typeof channel.id !== 'string' || !/^[CG][A-Z0-9]+$/.test(channel.id)
        || channel.is_member !== true || channel.is_archived === true || channel.is_im === true || channel.is_mpim === true
        || (channel.is_channel !== true && channel.is_group !== true) || chatIds.has(channel.id)) continue;
      chatIds.add(channel.id);
      result.chats.push({ id: channel.id, name: label(channel.name, channel.id, snapshot) });
    }
    if (snapshot.channel_id) {
      const members = await pages('conversations.members', { channel: snapshot.channel_id }, 'members');
      const ids = [...new Set(members.filter((id): id is string => typeof id === 'string' && /^[UW][A-Z0-9]+$/.test(id) && id !== auth.user_id))];
      if (ids.length > 40) result.limited = true;
      for (const id of ids.slice(0, 40)) {
        let response: Json;
        try { response = await request('users.info', { user: id }); }
        catch (error) {
          if (!(error instanceof SlackError && error.directoryUnavailable)) throw error;
          result.limited = true; break;
        }
        const user = response.user;
        if (!object(user) || user.id !== id || user.is_bot !== false || user.is_app_user === true || user.deleted === true
          || (user.team_id !== undefined && user.team_id !== auth.team_id)) continue;
        const profile = object(user.profile) ? user.profile : {};
        const name = label(profile.display_name, '', snapshot) || label(user.real_name, '', snapshot) || label(user.name, id, snapshot);
        result.users.push({ id, name });
      }
    }
    result.chats.sort((a, b) => a.name.localeCompare(b.name));
    result.users.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function createSlackTransport(config: SlackConfig): Promise<ChatTransport> {
  return createSlackTransportWithClient(config, { fetch: globalThis.fetch, webSocket: (url, options) => new WebSocket(url, options) });
}

/** Injected only at the IO boundary; no network connection or local session routing is hidden in tests. */
export async function createSlackTransportWithClient(config: SlackConfig, client: SlackClient): Promise<ChatTransport> {
  if (!validChatConfig('slack', config)) throw new SlackError('Slack configuration is invalid.', true);
  const snapshot = { ...config };
  const api = new SlackApi(snapshot, client);
  const auth = await api.request('auth.test');
  if (typeof auth.team_id !== 'string' || !/^T[A-Z0-9]+$/.test(auth.team_id)
    || typeof auth.bot_id !== 'string' || !/^B[A-Z0-9]+$/.test(auth.bot_id)
    || typeof auth.user_id !== 'string' || !/^[UW][A-Z0-9]+$/.test(auth.user_id)) {
    throw new SlackError('Slack auth.test did not verify a bot and workspace.', true);
  }
  const channel = (await api.request('conversations.info', { channel: snapshot.channel_id })).channel;
  if (!object(channel) || channel.id !== snapshot.channel_id || channel.is_im === true || channel.is_mpim === true
    || (channel.is_channel !== true && channel.is_group !== true) || channel.is_archived === true) {
    throw new SlackError('Slack returned an unavailable or unsupported channel.', true);
  }
  if (channel.is_member !== true) throw new SlackError('Invite the Slack bot to the configured public or private channel before connecting.', true);
  const user = (await api.request('users.info', { user: snapshot.user_id })).user;
  if (!object(user) || user.id !== snapshot.user_id || user.id === auth.user_id || user.is_bot !== false
    || user.is_app_user === true || user.deleted === true || (user.team_id !== undefined && user.team_id !== auth.team_id)) {
    throw new SlackError('Slack authorized user must be an active human in the verified workspace.', true);
  }
  const url = socketUrl((await api.request('apps.connections.open')).url, snapshot);
  const account = `Slack ${label(auth.team, auth.team_id, snapshot)} · @${label(auth.user, auth.user_id, snapshot)} · #${label(channel.name, snapshot.channel_id, snapshot)}`;
  return new SlackTransport(snapshot, api, client, `${auth.team_id}:${auth.bot_id}:${snapshot.channel_id}`, account, auth.team_id, url);
}
