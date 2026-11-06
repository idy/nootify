import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, BackendConnection, LarkBinding, LarkDelivery, PublicSession, SessionRecord, StoredInboxMessage } from './types.js';
import { HttpError } from './types.js';
import { isNotificationChannel, validChatConfig, type ChatBinding, type ChatDelivery, type NotificationChannel, type SlackConfig, type TelegramConfig } from './chat-transport.js';

/** Owner choices that are not tied to one session or binding. */
export interface Settings {
  lark_recipient_open_id?: string; lark_app_id?: string; lark_app_secret?: string; github_token?: string; tailscale_enabled?: boolean;
  notification_channel?: NotificationChannel; slack?: SlackConfig; telegram?: TelegramConfig;
}
interface StoredState { version: 1; sessions: SessionRecord[]; lark_bindings: LarkBinding[]; backends?: [Adapter, BackendConnection][]; lark_deliveries?: LarkDelivery[]; chat_bindings?: ChatBinding[]; chat_deliveries?: ChatDelivery[]; inbox_messages?: StoredInboxMessage[]; settings?: Settings }
export const defaultStateDir = () => join(homedir(), '.local/state/nootify');
export class State {
  readonly sessions = new Map<string, SessionRecord>();
  readonly bindings = new Map<string, LarkBinding>();
  readonly backends = new Map<Adapter, BackendConnection>();
  readonly deliveries = new Map<string, LarkDelivery>();
  readonly chatBindings = new Map<string, ChatBinding>();
  readonly chatDeliveries = new Map<string, ChatDelivery>();
  readonly inboxMessages = new Map<string, StoredInboxMessage>();
  readonly settings: Settings = {};
  private writes: Promise<void> = Promise.resolve();
  private constructor(readonly directory: string, readonly token: string) {}
  static async open(directory = defaultStateDir()): Promise<State> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const tokenPath = join(directory, 'auth-token');
    try { await writeFile(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const token = (await readFile(tokenPath, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid private service authentication file');
    const state = new State(directory, token);
    try {
      const data = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as StoredState;
      if (data.version !== 1 || !Array.isArray(data.sessions) || !Array.isArray(data.lark_bindings)) throw new Error('Invalid service state');
      for (const session of data.sessions) state.sessions.set(session.session_id, session);
      for (const binding of data.lark_bindings) state.bindings.set(binding.chat_id, binding);
      for (const [adapter, backend] of data.backends ?? []) state.backends.set(adapter, backend);
      for (const delivery of data.lark_deliveries ?? []) state.deliveries.set(delivery.message_id, delivery);
      for (const binding of data.chat_bindings ?? []) state.chatBindings.set(binding.id, binding);
      for (const delivery of data.chat_deliveries ?? []) state.chatDeliveries.set(delivery.id, delivery);
      for (const message of data.inbox_messages ?? []) state.inboxMessages.set(message.id, message);
      if (isNotificationChannel(data.settings?.notification_channel)) state.settings.notification_channel = data.settings.notification_channel;
      if (validChatConfig('slack', data.settings?.slack)) state.settings.slack = data.settings.slack;
      if (validChatConfig('telegram', data.settings?.telegram)) state.settings.telegram = data.settings.telegram;
      if (typeof data.settings?.tailscale_enabled === 'boolean') state.settings.tailscale_enabled = data.settings.tailscale_enabled;
      for (const field of ['lark_recipient_open_id', 'lark_app_id', 'lark_app_secret', 'github_token'] as const) {
        const value = data.settings?.[field];
        if (typeof value === 'string') state.settings[field] = value;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return state;
  }
  session(id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, 'Session is not registered');
    return session;
  }
  publicSessions(): PublicSession[] {
    return [...this.sessions.values()].map(({ session_id, host_id, adapter, session_name }) => ({ session_id, host_id, adapter, session_name }));
  }
  async save(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, sessions: [...this.sessions.values()], lark_bindings: [...this.bindings.values()], backends: [...this.backends.entries()], lark_deliveries: [...this.deliveries.values()], chat_bindings: [...this.chatBindings.values()], chat_deliveries: [...this.chatDeliveries.values()], inbox_messages: [...this.inboxMessages.values()], settings: this.settings }, null, 2) + '\n';
    const pending = this.writes.catch(() => {}).then(async () => {
      const temp = join(this.directory, `.state-${randomUUID()}.tmp`);
      await writeFile(temp, snapshot, { flag: 'wx', mode: 0o600 });
      await rename(temp, join(this.directory, 'state.json'));
    });
    this.writes = pending;
    await pending;
  }
}
