import { fileURLToPath } from 'node:url';
import type { ChatDelivery } from './chat-transport.js';
import type { LarkDelivery } from './types.js';

export interface ForwardingOptions { port?: number; command?: string[] }
const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
const cli = (command?: string[]): string => (command ?? [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))]).map(quote).join(' ');

export function forwardedLarkMessage(delivery: LarkDelivery, content: string, stateDir: string, port = 9417, command?: string[]): string {
  const base = cli(command);
  const context = `--state-dir ${quote(stateDir)} --port ${port} --message-id ${quote(delivery.message_id)}`;
  return [
    '【来自飞书用户的消息】',
    '这条消息由 Nootify 从飞书转发给你。请在方便时回复原飞书消息；如果正在处理其他工作，可以稍后回复。',
    `发送者 open_id：${delivery.sender_open_id}`,
    `原群 chat_id：${delivery.chat_id}`,
    `原消息 message_id：${delivery.message_id}`,
    `目标会话：${delivery.session_id}`,
    '', '用户原文：', content, '', '回复指引：',
    '1. 看到后先执行下面的回执命令。它只确认你已收到，不会向飞书发送回复：',
    `${base} lark-ack ${context}`,
    '2. 方便时通过下面的命令回复，回复会由机器人发回原飞书消息。将占位文字替换成你的回复，不要只在当前终端输出：',
    `${base} lark-reply ${context} --text '这里填写你的回复'`,
    '多行回复也可用 --text-file <本地文件>；--text-file - 可从标准输入读取。',
    '如果无法执行回执或回复命令，请在当前会话说明原因；不要声称已经回复飞书。',
  ].join('\n');
}

export function forwardedChatMessage(delivery: ChatDelivery, content: string, directory: string, port = 9417, command?: string[]): string {
  const name = delivery.channel === 'slack' ? 'Slack' : 'Telegram';
  const base = cli(command);
  const args = `--state-dir ${quote(directory)} --port ${port} --message-id ${quote(delivery.id)}`;
  return [
    `【来自${name}用户的消息】`,
    `这条消息由 Nootify 从 ${name} 转发给你，请在方便时回复原消息。`,
    `目标会话：${delivery.session_id}`, `发送者：${delivery.sender_id}`, '', '用户原文：', content, '',
    '先执行回执命令，仅确认收到，不发送远程回复：', `${base} chat-ack ${args}`,
    '通过下面的命令回复原消息，替换占位文字；不要只在当前终端输出：', `${base} chat-reply ${args} --text '这里填写你的回复'`,
    '多行回复可用 --text-file <本地文件>，或 --text-file - 从标准输入读取。',
  ].join('\n');
}
