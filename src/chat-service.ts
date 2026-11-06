import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { State } from './state.js';
import type { SessionsService } from './sessions.js';
import { HttpError, SessionUnavailable, identifier, isAdapter, object, text, type Adapter, type RouteRequest, type RouteResponse, type ServiceModule, type ThreadInfo, type ThreadMessage } from './types.js';
import { ChatTransportError, isNotificationChannel, validChatConfig, type ChatBinding, type ChatChannel, type ChatConfigs, type ChatDelivery, type ChatFactory, type ChatMessage, type ChatSettingsPage, type ChatDirectory, type ChatTransport } from './chat-transport.js';

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
const providerName = (channel: ChatChannel): string => channel === 'slack' ? 'Slack' : 'Telegram';
const bindingKey = (binding: { identity: string; chat_id: string; thread_id: string }): string => JSON.stringify([binding.identity, binding.chat_id, binding.thread_id]);
const messageKey = (channel: ChatChannel, identity: string, message: { chat_id: string; message_id: string }): string => JSON.stringify([channel, identity, message.chat_id, message.message_id]);
const validText = (value: unknown): string => {
  const content = text(value, 'text');
  if (Buffer.byteLength(content) > 48000) throw new HttpError(413, 'Text exceeds 48,000 bytes');
  return content;
};

export function forwardedChatMessage(delivery: ChatDelivery, content: string, directory: string, port: number): string {
  const name = providerName(delivery.channel);
  const command = [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))].map(quote).join(' ');
  const args = `--state-dir ${quote(directory)} --port ${port} --message-id ${quote(delivery.id)}`;
  return [
    `【来自${name}用户的消息】`,
    `这条消息由 Nootify 从 ${name} 转发给你，请在方便时回复原消息。`,
    `目标会话：${delivery.session_id}`, `发送者：${delivery.sender_id}`, '', '用户原文：', content, '',
    '先执行回执命令，仅确认收到，不发送远程回复：', `${command} chat-ack ${args}`,
    '通过下面的命令回复原消息，替换占位文字；不要只在当前终端输出：', `${command} chat-reply ${args} --text '这里填写你的回复'`,
    '多行回复可用 --text-file <本地文件>，或 --text-file - 从标准输入读取。',
  ].join('\n');
}

/** A local, account-qualified route ledger shared by the two outbound-only bot transports. */
export class ChatService<C extends ChatChannel> implements ServiceModule {
  readonly name: C;
  private transport?: ChatTransport;
  private currentStatus = 'disabled';
  private active = false;
  private generation = 0;
  private pending = Promise.resolve();
  private queued = 0;
  private readonly opening = new Map<string, Promise<ThreadInfo>>();
  private readonly replying = new Map<string, Promise<unknown>>();
  private readonly seen = new Set<string>();
  private retry?: ReturnType<typeof setTimeout>;
  private lifecycle: Promise<unknown> = Promise.resolve();
  constructor(readonly channel: C, private readonly state: State, private readonly sessions: Pick<SessionsService, 'send'>,
    private readonly factory: ChatFactory<C>, private readonly report: (record: Record<string, unknown>) => void = () => {}, private readonly port = 9417) { this.name = channel; }
  status(): string { return this.currentStatus; }
  page(): ChatSettingsPage {
    const config = this.state.settings[this.channel];
    return { status: this.currentStatus, configured: !!config, saved: !!config, account: this.transport?.account,
      chat_id: config && ('channel_id' in config ? config.channel_id : config.chat_id), user_id: config?.user_id,
      threads: [...this.state.chatBindings.values()].filter(binding => binding.channel === this.channel && binding.identity === this.transport?.identity).length };
  }
  directoryTargets(): ChatDirectory { return this.transport?.directoryTargets?.() ?? { users: [], chats: [], limited: true }; }
  private outcome(status: string): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.report({ source: this.channel, status: `${this.channel}_${status}` });
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.lifecycle.catch(() => {}).then(operation); this.lifecycle = work; return work;
  }
  start(): Promise<void> { return this.serialized(async () => { this.active = true; await this.connect(); }); }
  private async connect(): Promise<void> {
    const config = this.state.settings[this.channel];
    if (!config || !this.active) { this.outcome('disabled'); return; }
    this.outcome('connecting');
    try { await this.attach(await this.factory(config as ChatConfigs[C])); }
    catch {
      this.outcome('failed');
      this.scheduleReconnect();
    }
  }
  private scheduleReconnect(): void {
    if (!this.active || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.serialized(() => this.connect()); }, 30000);
    this.retry.unref();
  }
  private async attach(transport: ChatTransport): Promise<void> {
    const generation = ++this.generation;
    this.transport = transport;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.start(message => generation === this.generation ? this.receive(transport, message) : Promise.resolve(),
          status => { if (generation === this.generation) this.outcome(status); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ChatTransportError(`${providerName(this.channel)} connection timed out.`)), 15000); }),
      ]);
    } catch (error) {
      if (this.transport === transport) { this.transport = undefined; ++this.generation; }
      await transport.stop(); throw error;
    } finally { clearTimeout(timer); }
  }
  private async detach(): Promise<void> {
    clearTimeout(this.retry); this.retry = undefined;
    ++this.generation;
    const transport = this.transport; this.transport = undefined;
    await transport?.stop();
    await this.pending;
    await Promise.allSettled([...this.opening.values(), ...this.replying.values()]);
  }
  stop(): Promise<void> { return this.serialized(async () => { this.active = false; await this.detach(); this.outcome('stopped'); }); }
  /** Verify first, then replace. A failed verification leaves the old credentials and connection intact. */
  configure(value: unknown): Promise<void> {
    return this.serialized(async () => {
      const saved = this.state.settings[this.channel];
      if (value === undefined) {
        await this.detach(); delete this.state.settings[this.channel]; await this.state.save(); this.outcome('disabled'); return;
      }
      const input = object(value);
      const candidate = { ...input };
      for (const field of this.channel === 'slack' ? ['bot_token', 'app_token'] : ['bot_token']) {
        if (candidate[field] === '' || candidate[field] === undefined) candidate[field] = saved && (saved as unknown as Record<string, unknown>)[field];
      }
      if (!validChatConfig(this.channel, candidate)) throw new HttpError(400, `Invalid ${providerName(this.channel)} credentials, destination or trusted user`);
      let next: ChatTransport;
      try { next = await this.factory(candidate); }
      catch (error) { throw new HttpError(400, error instanceof ChatTransportError ? error.message : `${providerName(this.channel)} verification failed`); }
      await this.detach();
      const config = this.channel === 'slack' ? { bot_token: candidate.bot_token, app_token: (candidate as ChatConfigs['slack']).app_token, channel_id: (candidate as ChatConfigs['slack']).channel_id, user_id: candidate.user_id }
        : { bot_token: candidate.bot_token, chat_id: (candidate as ChatConfigs['telegram']).chat_id, user_id: candidate.user_id };
      Object.assign(this.state.settings, { [this.channel]: config });
      try { await this.state.save(); }
      catch (error) { Object.assign(this.state.settings, { [this.channel]: saved }); await next.stop(); throw error; }
      this.outcome('connecting');
      try { await this.attach(next); } catch { this.outcome('failed'); this.scheduleReconnect(); throw new HttpError(502, `${providerName(this.channel)} connection failed; settings were saved and will retry`); }
    });
  }
  private connection(): ChatTransport {
    if (!this.transport) throw new HttpError(409, `${providerName(this.channel)} is not connected; configure it in Settings`);
    return this.transport;
  }
  private binding(adapter: Adapter, session: string, transport: ChatTransport): ChatBinding | undefined {
    return [...this.state.chatBindings.values()].find(binding => binding.channel === this.channel && binding.identity === transport.identity
      && binding.adapter === adapter && binding.session_id === session && binding.sender_id === this.state.settings[this.channel]?.user_id);
  }
  open(adapter: Adapter, session: string, title: string): Promise<ThreadInfo> {
    const key = `${adapter}:${session}`;
    const prior = this.opening.get(key); if (prior) return prior;
    const operation = this.openNew(adapter, session, title).finally(() => { if (this.opening.get(key) === operation) this.opening.delete(key); });
    this.opening.set(key, operation); return operation;
  }
  private async openNew(adapter: Adapter, session: string, title: string): Promise<ThreadInfo> {
    const transport = this.connection();
    const name = title.trim();
    if (!name || name.length > 200) throw new HttpError(400, 'Session name must be 1 to 200 characters');
    let binding = this.binding(adapter, session, transport);
    const created = !binding;
    if (!binding) {
      const sender_id = this.state.settings[this.channel]!.user_id;
      const location = await transport.openThread(`${name} · ${session.slice(-8)}`);
      binding = { id: randomUUID(), channel: this.channel, identity: transport.identity, adapter, session_id: session, session_name: name, sender_id, ...location };
      this.state.chatBindings.set(binding.id, binding); await this.state.save();
    }
    this.report({ source: this.channel, status: created ? 'thread_created' : 'thread_reused', chat_id: binding.chat_id, session_id: session, session_name: binding.session_name });
    return { channel: this.channel, chat_id: binding.chat_id, thread_id: binding.thread_id, session_id: session, adapter, session_name: binding.session_name, created };
  }
  async send(session: string, content: string, adapter?: Adapter): Promise<ThreadMessage> {
    const transport = this.connection();
    const matches = [...this.state.chatBindings.values()].filter(binding => binding.channel === this.channel && binding.identity === transport.identity
      && binding.sender_id === this.state.settings[this.channel]?.user_id && binding.session_id === session && (!adapter || binding.adapter === adapter));
    if (matches.length !== 1) throw new HttpError(409, 'Open exactly one channel thread for this session first');
    const binding = matches[0];
    const sent = await transport.send(binding, `[${binding.session_name}] ${validText(content)}`);
    this.report({ source: this.channel, status: 'thread_message', chat_id: binding.chat_id, session_id: session, session_name: binding.session_name });
    return { channel: this.channel, chat_id: binding.chat_id, thread_id: binding.thread_id, message_id: sent.message_id };
  }
  private receive(transport: ChatTransport, message: ChatMessage): Promise<void> {
    const key = messageKey(this.channel, transport.identity, message);
    if (this.seen.has(key) || [...this.state.chatDeliveries.values()].some(delivery => messageKey(delivery.channel, delivery.identity, delivery) === key)) return Promise.resolve();
    if (message.sender_id !== this.state.settings[this.channel]?.user_id || !message.text?.trim() || Buffer.byteLength(message.text) > 48000) return Promise.resolve();
    const binding = [...this.state.chatBindings.values()].find(binding => binding.channel === this.channel && bindingKey(binding) === bindingKey({ ...message, identity: transport.identity })
      && binding.sender_id === message.sender_id);
    if (!binding) return Promise.resolve();
    if (this.queued >= 100) { this.report({ source: this.channel, status: 'queue_full' }); return Promise.resolve(); }
    this.seen.add(key); if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    this.queued++;
    const work = this.pending.then(async () => {
      const delivery: ChatDelivery = { ...binding, id: randomUUID(), message_id: message.message_id, created_at: new Date().toISOString(), transport_status: 'pending', replies: [] };
      this.state.chatDeliveries.set(delivery.id, delivery);
      if (this.state.chatDeliveries.size > 2000) this.state.chatDeliveries.delete(this.state.chatDeliveries.keys().next().value!);
      await this.state.save();
      this.report({ source: this.channel, status: 'received', message_id: delivery.id, chat_id: delivery.chat_id, session_id: delivery.session_id, session_name: delivery.session_name });
      try {
        const result = await this.sessions.send(delivery.session_id, forwardedChatMessage(delivery, message.text, this.state.directory, this.port), delivery.adapter);
        delivery.transport_status = result.status;
      } catch (error) {
        delivery.transport_status = error instanceof SessionUnavailable ? 'ignored' : 'delivery_failed';
        this.report({ source: this.channel, status: delivery.transport_status, reason: error instanceof SessionUnavailable ? error.reason : 'delivery_failed', message_id: delivery.id, session_id: delivery.session_id });
      }
      await this.state.save();
      if (delivery.transport_status === 'socket_written' || delivery.transport_status === 'input_accepted') this.report({ source: this.channel, status: delivery.transport_status, message_id: delivery.id, chat_id: delivery.chat_id, session_id: delivery.session_id });
    }).finally(() => { this.queued--; });
    this.pending = work.catch(() => { this.report({ source: this.channel, status: 'delivery_failed', reason: 'state_write_failed' }); });
    return this.pending;
  }
  private delivery(id: string): ChatDelivery {
    const delivery = this.state.chatDeliveries.get(id);
    if (!delivery || delivery.channel !== this.channel) throw new HttpError(404, 'No forwarded channel message with this ID');
    if (delivery.transport_status === 'ignored' || delivery.transport_status === 'delivery_failed') throw new HttpError(409, 'This message was not delivered');
    return delivery;
  }
  async acknowledge(id: string): Promise<unknown> {
    const delivery = this.delivery(id);
    if (!delivery.acknowledged_at) {
      delivery.acknowledged_at = new Date().toISOString(); await this.state.save();
      this.report({ source: this.channel, status: 'session_acknowledged', message_id: id, chat_id: delivery.chat_id, session_id: delivery.session_id });
    }
    return { status: 'session_acknowledged', message_id: id, acknowledged_at: delivery.acknowledged_at };
  }
  reply(id: string, content: string): Promise<unknown> {
    const operation = (this.replying.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const delivery = this.delivery(id);
      const transport = this.connection();
      if (delivery.identity !== transport.identity || delivery.sender_id !== this.state.settings[this.channel]?.user_id) throw new HttpError(409, 'The bot account or trusted user has changed');
      const value = validText(content); const digest = createHash('sha256').update(value).digest('hex');
      let previous = delivery.replies.find(reply => reply.digest === digest);
      if (!previous) {
        await this.acknowledge(id);
        const sent = await transport.send(delivery, `[${delivery.session_name}] ${value}`, delivery.message_id);
        previous = { digest, message_id: sent.message_id, time: new Date().toISOString() };
        delivery.replies.push(previous); if (delivery.replies.length > 20) delivery.replies.shift(); await this.state.save();
        this.report({ source: this.channel, status: 'replied', message_id: id, reply_id: sent.message_id, chat_id: delivery.chat_id, session_id: delivery.session_id });
      }
      return { status: 'replied', message_id: id, reply_id: previous.message_id };
    });
    this.replying.set(id, operation);
    void operation.finally(() => { if (this.replying.get(id) === operation) this.replying.delete(id); }).catch(() => {});
    return operation;
  }
  async handle(request: RouteRequest): Promise<RouteResponse | undefined> {
    const receipt = /^\/v1\/chat\/messages\/([^/]+)\/(ack|reply)$/.exec(request.path);
    if (receipt && request.method === 'POST') {
      const id = identifier(decodeURIComponent(receipt[1]), 'message_id');
      if (this.state.chatDeliveries.get(id)?.channel !== this.channel) return;
      return { body: receipt[2] === 'ack' ? await this.acknowledge(id) : await this.reply(id, validText(object(request.body).text)) };
    }
    const send = /^\/v1\/threads\/([^/]+)\/messages$/.exec(request.path);
    if (request.method !== 'POST' || (request.path !== '/v1/threads' && !send)) return;
    const body = object(request.body); const channel = body.channel ?? this.state.settings.notification_channel ?? 'feishu';
    if (!isNotificationChannel(channel)) throw new HttpError(400, 'Unsupported notification channel');
    if (channel !== this.channel) return;
    if (body.adapter !== undefined && !isAdapter(body.adapter)) throw new HttpError(400, 'Unsupported session adapter');
    if (send) return { body: await this.send(identifier(decodeURIComponent(send[1]), 'session_id'), validText(body.text), body.adapter as Adapter | undefined) };
    if (!isAdapter(body.adapter)) throw new HttpError(400, 'Unsupported session adapter');
    return { status: 200, body: await this.open(body.adapter, identifier(body.session_id, 'session_id'), text(body.session_name, 'session_name')) };
  }
}
