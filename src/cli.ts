import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NootifyClient } from './client.js';
import { defaultStateDir } from './state.js';
import { installLaunchd } from './launchd.js';
import type { SessionRegistration } from './types.js';
import { isAdapter } from './types.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'state-dir': { type: 'string' }, 'mcp-config': { type: 'string' }, port: { type: 'string', default: '9417' },
    'session-id': { type: 'string' }, 'session-name': { type: 'string' }, adapter: { type: 'string', default: 'claude-desktop' },
    'chat-id': { type: 'string' }, 'sender-id': { type: 'string' }, pin: { type: 'boolean', default: false },
    metadata: { type: 'string', default: 'announcement' }, text: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    url: { type: 'string' }, directory: { type: 'string' },
    'message-id': { type: 'string' }, 'text-file': { type: 'string' },
  } });
  const command = positionals[0];
  if (values.help) { console.log('Usage: cli.js <launchd-install|health|register|sessions|send|lark-bind|lark-ack|lark-reply|backend-set> [options]'); return; }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (command === 'launchd-install') {
    console.log(JSON.stringify({ status: 'installed', plist: await installLaunchd({ stateDir: values['state-dir'], port, mcpConfig: values['mcp-config'] }) }));
    return;
  }
  const token = (await readFile(join(values['state-dir'] ?? defaultStateDir(), 'auth-token'), 'utf8')).trim();
  const client = new NootifyClient({ token, baseUrl: `http://127.0.0.1:${port}` });
  const required = (name: 'session-id' | 'session-name' | 'chat-id' | 'sender-id' | 'text' | 'message-id'): string => {
    const value = values[name]; if (!value) throw new Error(`Missing --${name}`); return value;
  };
  let result: unknown;
  switch (command) {
    case 'health': result = await client.health(); break;
    case 'sessions': result = await client.listSessions(); break;
    case 'register': {
      if (!isAdapter(values.adapter)) throw new Error('Unsupported adapter');
      const claude = values.adapter === 'claude-code' || values.adapter === 'claude-desktop';
      const socket_path = claude ? process.env.CLAUDE_CODE_MESSAGING_SOCKET : undefined;
      if (claude && !socket_path) throw new Error('Register from the target session: its inbox environment is missing');
      const registration: SessionRegistration = { adapter: values.adapter, session_name: required('session-name'), socket_path,
        ...(claude && process.env.CLAUDE_CODE_MESSAGING_TOKEN ? { socket_token: process.env.CLAUDE_CODE_MESSAGING_TOKEN } : {}) };
      result = await client.registerSession(required('session-id'), registration);
      break;
    }
    case 'send': {
      if (!isAdapter(values.adapter)) throw new Error('Unsupported adapter');
      result = await client.sendMessage(required('session-id'), required('text'), values.adapter); break;
    }
    case 'backend-set': {
      if (values.adapter !== 'codex' && values.adapter !== 'opencode') throw new Error('Choose --adapter codex or opencode');
      if (!values.url) throw new Error('Missing --url');
      result = await client.configureBackend(values.adapter, { url: values.url, directory: values.directory,
        ...(values.adapter === 'codex' ? { token: process.env.CODEX_APP_SERVER_TOKEN } : {
          username: process.env.OPENCODE_SERVER_USERNAME, password: process.env.OPENCODE_SERVER_PASSWORD,
        }),
      }); break;
    }
    case 'lark-ack': result = await client.acknowledgeLark(required('message-id')); break;
    case 'lark-reply': {
      if (values.text !== undefined && values['text-file'] !== undefined) throw new Error('Use --text or --text-file, not both');
      let replyText = values.text;
      if (values['text-file'] === '-') {
        const parts: Buffer[] = []; let bytes = 0;
        for await (const chunk of process.stdin) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += part.length; if (bytes > 48000) throw new Error('Reply text is too large'); parts.push(part);
        }
        replyText = Buffer.concat(parts).toString('utf8');
      } else if (values['text-file']) replyText = await readFile(values['text-file'], 'utf8');
      if (!replyText?.trim()) throw new Error('Provide --text or --text-file for the Feishu reply');
      result = await client.replyLark(required('message-id'), replyText); break;
    }
    case 'lark-bind': {
      if (values.metadata !== 'message' && values.metadata !== 'announcement') throw new Error('Invalid --metadata');
      if (!isAdapter(values.adapter)) throw new Error('Unsupported adapter');
      result = await client.bindLark(required('chat-id'), { session_id: required('session-id'), sender_open_id: required('sender-id'), adapter: values.adapter, session_name: values['session-name'], pin: values.pin, metadata: values.metadata });
      break;
    }
    default: throw new Error('Use --help for supported commands');
  }
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error: (error as Error).message })); process.exitCode = 1; });
}
