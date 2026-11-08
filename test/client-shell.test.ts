import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { promptBlock } from '../src/agents.js';
import { forwardedLarkMessage } from '../src/forwarded-messages.js';
import { shellCommand, shellForClient } from '../src/shell.js';
import type { LarkDelivery } from '../src/types.js';

const exec = promisify(execFile);
const stateDir = "C:\\Users\\O'Brien\\状态 ‘literal’ $value; (data)";
const lark: LarkDelivery = { message_id: '/fixture/message', chat_id: 'fixture-chat', sender_open_id: 'fixture-user', session_id: 'fixture-session',
  session_name: 'Fixture', adapter: 'claude-code', created_at: '2026-11-07T00:00:00Z', transport_status: 'socket_written', replies: [] };
async function capture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nootify-client-shell-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "O'Brien ‘用户’ (literal) $value"); await mkdir(directory);
  const node = join(directory, 'node.exe'); const cli = join(directory, 'capture.cjs');
  if (process.platform === 'win32') await copyFile(process.execPath, node); else await symlink(process.execPath, node);
  await writeFile(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NODE_.*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS)$/i.test(key)));
  const run = async (command: string): Promise<string[]> => {
    const { stdout, stderr } = await exec(bash, ['--noprofile', '--norc', '-c', command], { env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.equal(stderr, ''); return JSON.parse(stdout) as string[];
  };
  return { command: [node, cli], run };
}
function assertOption(args: string[], name: string, value: string) {
  const index = args.indexOf(name); assert.ok(index >= 0, `missing ${name}`); assert.equal(args[index + 1], value);
}
test('Windows Claude shell selection is separate from the host OS and other clients', () => {
  for (const client of ['claude', 'claude-code', 'claude-desktop']) assert.equal(shellForClient(client, 'win32'), 'posix');
  for (const client of ['codex', 'opencode', 'trae', 'workbuddy']) assert.equal(shellForClient(client, 'win32'), 'powershell');
  assert.equal(shellForClient('codex', 'darwin'), 'posix');
  const command = shellCommand(['\\\\?\\C:\\Program Files\\Nootify\\node.exe', 'C:\\state\\cli.js'], 'win32', false, 'posix');
  assert.equal(command, "MSYS2_ARG_CONV_EXCL='*' 'C:/Program Files/Nootify/node.exe' 'C:\\state\\cli.js'");
  const unc = shellCommand(['\\\\?\\UNC\\server\\share\\node.exe'], 'win32', false, 'posix');
  assert.equal(unc, "MSYS2_ARG_CONV_EXCL='*' '//server/share/node.exe'");
  const options = { stateDir, port: 9517, command: ['C:\\Nootify\\node.exe', 'C:\\Nootify\\cli.js'], platform: 'win32' as const };
  assert.match(promptBlock('claude', options), /MSYS2_ARG_CONV_EXCL='\*' C:\/Nootify\/node\.exe/);
  assert.ok(promptBlock('codex', options).includes("& 'C:\\Nootify\\node.exe' 'C:\\Nootify\\cli.js'"));
});
test('Windows Bash commands preserve native paths, apostrophes, Unicode and literal shell syntax', { timeout: 40_000 }, async t => {
  const f = await capture(t); const values = [stateDir, '/literal/message/path', '$(not-a-command); `literal` & $value', "O'Brien", '多行\n回复'];
  assert.deepEqual(await f.run(shellCommand([...f.command, ...values], 'win32', false, 'posix')), values);
});
test('Windows Claude prompt and Feishu callback commands execute in Bash with exact context', { timeout: 90_000 }, async t => {
  const f = await capture(t); const block = promptBlock('claude', { stateDir, port: 9517, command: f.command, platform: 'win32' });
  const commands = [...block.matchAll(/`(MSYS2_ARG_CONV_EXCL=[^`]+)`/g)].map(match => match[1]); assert.equal(commands.length, 2);
  for (const [index, command] of commands.entries()) {
    const args = await f.run(command); assert.equal(args[0], index === 0 ? 'thread-open' : 'thread-send');
    assertOption(args, '--agent', 'claude'); assertOption(args, '--state-dir', stateDir); assertOption(args, '--port', '9517');
  }
  const forwarded = forwardedLarkMessage(lark, 'untrusted $(content)', stateDir, 9517, f.command, 'win32');
  const lines = forwarded.split('\n').filter(line => line.startsWith("MSYS2_ARG_CONV_EXCL='*' ")); assert.equal(lines.length, 2);
  for (const [action, command] of lines.entries()) {
    assert.ok(!command.includes('untrusted $(content)')); const args = await f.run(command);
    assert.equal(args[0], `lark-${action === 0 ? 'ack' : 'reply'}`);
    assertOption(args, '--state-dir', stateDir); assertOption(args, '--port', '9517'); assertOption(args, '--message-id', '/fixture/message');
    if (action === 1) assertOption(args, '--text', '这里填写你的回复');
  }
});
