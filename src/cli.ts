import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NootifyClient } from './client.js';
import { defaultStateDir } from './state.js';
import { installLaunchd } from './launchd.js';
import { manageService, SERVICE_ACTIONS, type ServiceAction } from './service.js';
import type { Adapter, SessionRegistration } from './types.js';
import { isAdapter, isPolledAdapter } from './types.js';
import { AGENT_IDS, agentSession, isAgent } from './agents.js';
import { isNotificationChannel } from './chat-transport.js';

export async function main(argv = process.argv.slice(2), serviceManager = manageService): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'state-dir': { type: 'string' }, 'mcp-config': { type: 'string' }, port: { type: 'string', default: '9417' },
    'session-id': { type: 'string' }, 'session-name': { type: 'string' }, adapter: { type: 'string' }, agent: { type: 'string' }, 'open-id': { type: 'string' },
    'chat-id': { type: 'string' }, 'sender-id': { type: 'string' }, pin: { type: 'boolean', default: false },
    metadata: { type: 'string', default: 'announcement' }, text: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    url: { type: 'string' }, directory: { type: 'string' },
    'message-id': { type: 'string' }, 'text-file': { type: 'string' }, channel: { type: 'string' },
  } });
  const command = positionals[0];
  if (values.help) { console.log('Usage: cli.js <service-install|service-start|service-restart|service-stop|service-uninstall|service-status|launchd-install|health|register|sessions|send|thread-open|thread-send|thread-receive|thread-ack|chat-ack|chat-reply|lark-bind|lark-ack|lark-reply|lark-recipient|backend-set> [options] [--channel feishu|slack|telegram]'); return; }
  if (values.channel !== undefined && !isNotificationChannel(values.channel)) throw new Error('Use --channel feishu, slack or telegram');
  const channel = isNotificationChannel(values.channel) ? values.channel : undefined;
  const adapter = values.adapter ?? 'claude-desktop';
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (command === 'launchd-install') {
    console.log(JSON.stringify({ status: 'installed', plist: await installLaunchd({ stateDir: values['state-dir'], port, mcpConfig: values['mcp-config'] }) }));
    return;
  }
  const serviceAction = command?.startsWith('service-') ? command.slice('service-'.length) : undefined;
  if (serviceAction) {
    if (!(SERVICE_ACTIONS as readonly string[]).includes(serviceAction)) throw new Error('Use --help for supported service commands');
    console.log(JSON.stringify(await serviceManager(serviceAction as ServiceAction, { stateDir: values['state-dir'], port, mcpConfig: values['mcp-config'] })));
    return;
  }
  const token = (await readFile(join(values['state-dir'] ?? defaultStateDir(), 'auth-token'), 'utf8')).trim();
  const client = new NootifyClient({ token, baseUrl: `http://127.0.0.1:${port}` });
  const required = (name: 'session-id' | 'session-name' | 'chat-id' | 'sender-id' | 'text' | 'message-id'): string => {
    const value = values[name]; if (!value) throw new Error(`Missing --${name}`); return value;
  };
  async function readText(): Promise<string | undefined> {
    if (values.text !== undefined && values['text-file'] !== undefined) throw new Error('Use --text or --text-file, not both');
    if (values['text-file'] === '-') {
      const parts: Buffer[] = []; let bytes = 0;
      for await (const chunk of process.stdin) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += part.length; if (bytes > 48000) throw new Error('Text is too large'); parts.push(part);
      }
      return Buffer.concat(parts).toString('utf8');
    }
    if (values['text-file']) return readFile(values['text-file'], 'utf8');
    return values.text;
  }
  /** Native IDs come from the client. Polled clients allocate one Nootify ID on thread-open and explicitly reuse it. */
  function threadTarget(): { adapter: Adapter; session_id: string } {
    if (values.agent !== undefined && !isAgent(values.agent)) throw new Error(`Use --agent ${AGENT_IDS.join(', ')}`);
    const detected = values.agent ? agentSession(values.agent) : undefined;
    const target = values.adapter ?? detected?.adapter;
    if (!isAdapter(target)) throw new Error(`Pass --agent ${AGENT_IDS.join('|')}, or --adapter with --session-id`);
    const session_id = values['session-id'] || detected?.session_id || (command === 'thread-open' && isPolledAdapter(target) ? randomUUID() : undefined);
    if (!session_id) throw new Error(isPolledAdapter(target) ? 'Pass --session-id returned by thread-open for this conversation'
      : values.agent === 'opencode' ? 'Pass --session-id with this OpenCode session ID (ses_…)' : 'This session ID is not in the environment; pass --session-id');
    return { adapter: target, session_id };
  }
  let result: unknown;
  switch (command) {
    case 'health': result = await client.health(); break;
    case 'sessions': result = await client.listSessions(); break;
    case 'register': {
      if (!isAdapter(adapter)) throw new Error('Unsupported adapter');
      const claude = adapter === 'claude-code' || adapter === 'claude-desktop';
      const socket_path = claude ? process.env.CLAUDE_CODE_MESSAGING_SOCKET : undefined;
      if (claude && !socket_path) throw new Error('Register from the target session: its inbox environment is missing');
      const registration: SessionRegistration = { adapter, session_name: required('session-name'), socket_path,
        ...(claude && process.env.CLAUDE_CODE_MESSAGING_TOKEN ? { socket_token: process.env.CLAUDE_CODE_MESSAGING_TOKEN } : {}) };
      result = await client.registerSession(required('session-id'), registration);
      break;
    }
    case 'send': {
      if (!isAdapter(adapter)) throw new Error('Unsupported adapter');
      result = await client.sendMessage(required('session-id'), required('text'), adapter); break;
    }
    case 'thread-open': {
      const target = threadTarget();
      const session_name = required('session-name');
      try { result = await client.openThread({ ...target, session_name, ...(channel ? { channel } : {}) }); }
      catch (error) {
        if (isPolledAdapter(target.adapter)) throw new Error(`${(error as Error).message}; retry thread-open with --agent ${target.adapter} --session-id ${target.session_id}`);
        throw error;
      }
      break;
    }
    case 'thread-send': {
      const target = threadTarget();
      const message = await readText();
      if (!message?.trim()) throw new Error('Provide --text or --text-file for the message');
      result = await client.sendThread(target.session_id, message, target.adapter, channel); break;
    }
    case 'thread-receive':
    case 'thread-ack': {
      const target = threadTarget();
      if (!isPolledAdapter(target.adapter)) throw new Error('Use thread-receive/thread-ack with --agent trae or workbuddy');
      result = command === 'thread-receive' ? await client.receiveThread(target.session_id, target.adapter)
        : await client.acknowledgeThread(target.session_id, target.adapter, required('message-id'));
      break;
    }
    case 'lark-recipient': result = values['open-id'] ? await client.setLarkRecipient(values['open-id']) : await client.larkRecipient(); break;
    case 'backend-set': {
      if (values.adapter !== 'codex' && values.adapter !== 'opencode') throw new Error('Choose --adapter codex or opencode');
      if (!values.url) throw new Error('Missing --url');
      result = await client.configureBackend(values.adapter, { url: values.url, directory: values.directory,
        ...(values.adapter === 'codex' ? { token: process.env.CODEX_APP_SERVER_TOKEN } : {
          username: process.env.OPENCODE_SERVER_USERNAME, password: process.env.OPENCODE_SERVER_PASSWORD,
        }),
      }); break;
    }
    case 'chat-ack': result = await client.acknowledgeChat(required('message-id')); break;
    case 'chat-reply': {
      const replyText = await readText();
      if (!replyText?.trim()) throw new Error('Provide --text or --text-file for the reply');
      result = await client.replyChat(required('message-id'), replyText); break;
    }
    case 'lark-ack': result = await client.acknowledgeLark(required('message-id')); break;
    case 'lark-reply': {
      const replyText = await readText();
      if (!replyText?.trim()) throw new Error('Provide --text or --text-file for the Feishu reply');
      result = await client.replyLark(required('message-id'), replyText); break;
    }
    case 'lark-bind': {
      if (values.metadata !== 'message' && values.metadata !== 'announcement') throw new Error('Invalid --metadata');
      if (!isAdapter(adapter)) throw new Error('Unsupported adapter');
      result = await client.bindLark(required('chat-id'), { session_id: required('session-id'), sender_open_id: required('sender-id'), adapter, session_name: values['session-name'], pin: values.pin, metadata: values.metadata });
      break;
    }
    default: throw new Error('Use --help for supported commands');
  }
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error: (error as Error).message })); process.exitCode = 1; });
}
