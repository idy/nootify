import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { LarkApi } from './lark-metadata.js';
import type { State } from './state.js';
import { HttpError } from './types.js';
import type { LarkDelivery, LarkReceipt, LarkReply } from './types.js';
import { shellCommand, shellQuote } from './shell.js';

export function forwardedLarkMessage(delivery: LarkDelivery, content: string, stateDir: string, port = 9417): string {
  const command = shellCommand([process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))]);
  const context = `--state-dir ${shellQuote(stateDir)} --port ${port} --message-id ${shellQuote(delivery.message_id)}`;
  return [
    '【来自飞书用户的消息】',
    '这条消息由 Nootify 从飞书转发给你。请在方便时回复原飞书消息；如果正在处理其他工作，可以稍后回复。',
    `发送者 open_id：${delivery.sender_open_id}`,
    `原群 chat_id：${delivery.chat_id}`,
    `原消息 message_id：${delivery.message_id}`,
    `目标会话：${delivery.session_id}`,
    '',
    '用户原文：',
    content,
    '',
    '回复指引：',
    '1. 看到后先执行下面的回执命令。它只确认你已收到，不会向飞书发送回复：',
    `${command} lark-ack ${context}`,
    '2. 方便时通过下面的命令回复，回复会由机器人发回原飞书消息。将占位文字替换成你的回复，不要只在当前终端输出：',
    `${command} lark-reply ${context} --text '这里填写你的回复'`,
    '多行回复也可用 --text-file <本地文件>；--text-file - 可从标准输入读取。',
    '如果无法执行回执或回复命令，请在当前会话说明原因；不要声称已经回复飞书。',
  ].join('\n');
}
export class LarkReplies {
  private readonly pending = new Map<string, Promise<LarkReply>>();
  constructor(private readonly state: State, private readonly api: LarkApi,
    private readonly report: (record: Record<string, unknown>) => void) {}
  private delivery(id: string): LarkDelivery {
    const delivery = this.state.deliveries.get(id);
    if (!delivery) throw new HttpError(404, 'No forwarded Feishu message with this ID');
    if (delivery.transport_status === 'ignored') throw new HttpError(409, 'This message was not forwarded');
    return delivery;
  }
  async acknowledge(id: string): Promise<LarkReceipt> {
    const delivery = this.delivery(id);
    if (!delivery.acknowledged_at) {
      delivery.acknowledged_at = new Date().toISOString();
      await this.state.save();
      this.report({ status: 'session_acknowledged', source: 'lark', message_id: id, chat_id: delivery.chat_id,
        session_id: delivery.session_id, session_name: delivery.session_name });
    }
    return { status: 'session_acknowledged', message_id: id, acknowledged_at: delivery.acknowledged_at };
  }
  async reply(id: string, text: string): Promise<LarkReply> {
    this.delivery(id);
    const prior = this.pending.get(id) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(() => this.send(id, text));
    this.pending.set(id, operation);
    try { return await operation; }
    finally { if (this.pending.get(id) === operation) this.pending.delete(id); }
  }
  private async send(id: string, text: string): Promise<LarkReply> {
    const delivery = this.delivery(id);
    const digest = createHash('sha256').update(`${id}\n${text}`).digest('hex');
    const previous = delivery.replies.find(reply => reply.digest === digest);
    if (previous) return { status: 'replied', message_id: id, reply_id: previous.message_id };
    await this.acknowledge(id);
    try {
      const result = await this.api.request<{ message_id: string; chat_id: string }>('POST',
        `/open-apis/im/v1/messages/${encodeURIComponent(id)}/reply`, {
          msg_type: 'text', content: JSON.stringify({ text: `[${delivery.session_name}] ${text}` }),
          reply_in_thread: Boolean(delivery.thread_id), uuid: digest.slice(0, 40),
        });
      if (!result.message_id || result.chat_id !== delivery.chat_id) throw new Error('Feishu returned an unexpected reply destination');
      delivery.replies.push({ digest, message_id: result.message_id, time: new Date().toISOString() });
      if (delivery.replies.length > 20) delivery.replies.shift();
      await this.state.save();
      this.report({ status: 'replied', source: 'lark', message_id: id, reply_id: result.message_id,
        chat_id: delivery.chat_id, session_id: delivery.session_id, session_name: delivery.session_name, preview: text });
      return { status: 'replied', message_id: id, reply_id: result.message_id };
    } catch (error) {
      this.report({ status: 'reply_failed', source: 'lark', message_id: id, chat_id: delivery.chat_id,
        session_id: delivery.session_id, error: (error as Error).message });
      throw error;
    }
  }
}
