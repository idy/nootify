import type { Adapter, LarkDelivery } from './types.js';

export type ChatChannel = 'slack' | 'telegram';
export const isNotificationChannel = (value: unknown): value is NotificationChannel => value === 'feishu' || value === 'slack' || value === 'telegram';
export interface ChatBinding extends ChatLocation {
  id: string; channel: ChatChannel; identity: string; adapter: Adapter; session_id: string; session_name: string; sender_id: string;
}
export interface ChatDelivery extends ChatBinding {
  message_id: string; created_at: string; transport_status: LarkDelivery['transport_status'];
  acknowledged_at?: string; replies: LarkDelivery['replies'];
}
export interface ChatSettingsPage {
  status: string; configured: boolean; saved: boolean; account?: string; chat_id?: string; user_id?: string; threads: number;
}
export type NotificationChannel = 'feishu' | ChatChannel;
export interface ChatDirectory { users: { id: string; name: string }[]; chats: { id: string; name: string }[]; limited: boolean }

export interface SlackConfig { bot_token: string; app_token: string; channel_id: string; user_id: string }
export interface TelegramConfig { bot_token: string; chat_id: string; user_id: string }
export interface ChatConfigs { slack: SlackConfig; telegram: TelegramConfig }
export interface ChatLocation { chat_id: string; thread_id: string }
export interface ChatMessage extends ChatLocation { message_id: string; sender_id: string; text: string }
export interface SentChatMessage { message_id: string }
/** An authenticated bot connection. Routing is stored locally; arbitrary remote messages cannot bind sessions. */
export interface ChatTransport {
  /** Includes the verified workspace/bot identity and configured room; contains no credentials. */
  readonly identity: string;
  readonly account: string;
  directoryTargets?(): ChatDirectory;
  start(receive: (message: ChatMessage) => Promise<void>, status: (status: 'ready' | 'reconnecting' | 'failed') => void): Promise<void>;
  stop(): Promise<void>;
  openThread(title: string): Promise<ChatLocation>;
  send(location: ChatLocation, text: string, replyTo?: string): Promise<SentChatMessage>;
  /** Add this provider's receipt reaction to the original incoming message. */
  react(location: ChatLocation, messageId: string): Promise<void>;
}
export type ChatFactory<C extends ChatChannel> = (config: ChatConfigs[C]) => Promise<ChatTransport>;
/** Only locally authored provider errors may cross the credential boundary into settings. */
export class ChatTransportError extends Error {}

/** Splits plain text without cutting UTF-16 surrogate pairs. Providers receive no formatting directives. */
export function textChunks(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let end = limit;
    const code = remaining.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    chunks.push(remaining.slice(0, end)); remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function validChatConfig<C extends ChatChannel>(channel: C, value: unknown): value is ChatConfigs[C] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (channel === 'slack') return typeof config.bot_token === 'string' && /^xoxb-[A-Za-z0-9-]+$/.test(config.bot_token)
    && typeof config.app_token === 'string' && /^xapp-[A-Za-z0-9-]+$/.test(config.app_token)
    && typeof config.channel_id === 'string' && /^[CG][A-Z0-9]+$/.test(config.channel_id)
    && typeof config.user_id === 'string' && /^[UW][A-Z0-9]+$/.test(config.user_id);
  return typeof config.bot_token === 'string' && /^\d+:[A-Za-z0-9_-]+$/.test(config.bot_token)
    && typeof config.chat_id === 'string' && /^-100\d+$/.test(config.chat_id)
    && typeof config.user_id === 'string' && /^[1-9]\d*$/.test(config.user_id) && Number.isSafeInteger(Number(config.user_id));
}
