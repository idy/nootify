import { fileURLToPath } from 'node:url';
import type { LarkDelivery } from './types.js';
import { shellCommand, shellForClient, shellQuote } from './shell.js';

export interface ForwardingOptions { port?: number; command?: string[] }
function commands(adapter: string, platform: NodeJS.Platform, command?: string[]) {
  const shell = shellForClient(adapter, platform);
  return {
    base: shellCommand(command ?? [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))], platform, false, shell),
    quote: (value: string): string => shellQuote(value, platform, false, shell),
  };
}

export function forwardedLarkMessage(delivery: LarkDelivery, content: string, stateDir: string, port = 9417, command?: string[], platform: NodeJS.Platform = process.platform): string {
  const { base, quote } = commands(delivery.adapter, platform, command);
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
