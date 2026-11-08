export type MessageChannel = 'feishu';
export interface IncomingTextMessage {
  chat_id: string; message_id: string; thread_id?: string; sender_id: string; text: string;
}
/** Feishu event and history metadata survive normalization until the admission policy runs. */
export interface NormalizedIncomingMessage {
  channel: MessageChannel; chat_id: string; message_id: string; thread_id?: string; sender_id: string;
  sender_type: 'user' | 'bot' | 'unknown'; message_type: string; text?: string;
  edited: boolean; deleted: boolean; system: boolean;
}
export type MessageRejection = 'invalid_message' | 'sender_not_user' | 'unsupported_message' | 'invalid_content';
type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
function larkText(content: unknown): string | undefined {
  if (typeof content !== 'string') return;
  try { return string(object(JSON.parse(content))?.text); } catch { return; }
}

/** Decode the live-event and merged-history formats in one place. */
export function normalizeIncomingMessage(channel: MessageChannel, payload: unknown): NormalizedIncomingMessage | undefined {
  if (channel !== 'feishu') return;
  const input = object(payload);
  if (!input) return;
  const event = object(input.event ?? input);
  if (!event) return;
  const history = !('message' in event);
  const message = object(history ? event : event.message); const sender = object(event.sender);
  if (!message) return;
  const chat_id = string(message.chat_id); const message_id = string(message.message_id);
  if (!chat_id || !message_id) return;
  const sender_id = history ? sender?.id_type === 'open_id' ? string(sender.id) : undefined : string(object(sender?.sender_id)?.open_id);
  return { channel, chat_id, message_id, thread_id: string(message.thread_id), sender_id: sender_id ?? '',
    sender_type: sender?.sender_type === 'user' ? 'user' : sender?.sender_type === 'app' || sender?.sender_type === 'bot' ? 'bot' : 'unknown',
    message_type: string(history ? message.msg_type : message.message_type) ?? 'unknown',
    text: larkText(history ? object(message.body)?.content : message.content), edited: false, deleted: message.deleted === true, system: false };
}

/** The shared sender/content policy for Feishu events and chronological history. */
export function incomingMessageRejection(message: NormalizedIncomingMessage | undefined): MessageRejection | undefined {
  if (!message?.chat_id || !message.message_id) return 'invalid_message';
  if (message.sender_type !== 'user') return 'sender_not_user';
  if (!message.sender_id) return 'invalid_message';
  if (message.message_type !== 'text' || message.edited || message.deleted || message.system) return 'unsupported_message';
  if (typeof message.text !== 'string' || !message.text.trim()) return 'invalid_content';
}
export function selectIncomingMessage(message: NormalizedIncomingMessage | undefined): IncomingTextMessage | undefined {
  if (!message || incomingMessageRejection(message)) return;
  return { chat_id: message.chat_id, message_id: message.message_id, ...(message.thread_id ? { thread_id: message.thread_id } : {}),
    sender_id: message.sender_id, text: message.text! };
}
