import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { main } from '../src/cli.js';
import { conversationSessions } from '../src/conversations.js';
import { checkSocket, isNamedPipe } from '../src/inbox.js';
import { LocalSessions } from '../src/local-sessions.js';
import { desktopSessionRoots, isAbsolutePath, serviceStateDir } from '../src/runtime-paths.js';
import { SERVICE_ACTIONS, serviceEnvironment, windowsPowerShell, windowsServiceArgs, windowsServiceScript } from '../src/service.js';
import { writeInbox } from '../src/sessions.js';
import { shellCommand, shellQuote } from '../src/shell.js';
import { embeddedBinaryCandidates, embeddedEnvironment } from '../src/tsnet-client.js';

const exec = promisify(execFile);

test('Windows defaults use per-user AppData, including explicit redirects and fallback home', () => {
  const env = { APPDATA: 'D:\\Roaming User', LOCALAPPDATA: 'E:\\Local User' };
  assert.deepEqual(desktopSessionRoots(env, 'win32', 'C:\\Users\\Someone'), [
    'D:\\Roaming User\\Claude-3p\\claude-code-sessions', 'D:\\Roaming User\\Claude\\claude-code-sessions',
  ]);
  assert.equal(serviceStateDir(env, 'win32'), 'E:\\Local User\\Nootify\\state');
  assert.equal(serviceStateDir({}, 'win32', 'C:\\Users\\Someone'), 'C:\\Users\\Someone\\AppData\\Local\\Nootify\\state');
  assert.deepEqual(desktopSessionRoots({}, 'darwin', '/Users/someone'), ['Claude-3p', 'Claude'].map(app => `/Users/someone/Library/Application Support/${app}/claude-code-sessions`));
  assert.equal(serviceStateDir({}, 'darwin', '/Users/someone'), '/Users/someone/.local/state/nootify');
  assert.equal(serviceStateDir({}, 'linux', '/home/someone'), '/home/someone/.local/state/nootify');
});

test('session metadata accepts absolute drive and UNC paths without accepting drive-relative paths', async t => {
  for (const path of ['C:\\Users\\Someone\\Repo', 'd:/repo', '\\\\server\\share\\repo', '/work/repo']) assert.ok(isAbsolutePath(path), path);
  for (const path of ['C:repo', '\\repo', 'relative/repo', '..\\repo', '']) assert.ok(!isAbsolutePath(path), path);
  const directory = await mkdtemp(join(tmpdir(), 'nootify-win-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = join(directory, 'desktop', 'account', 'profile'); await mkdir(profile, { recursive: true });
  const cwd = 'C:\\Users\\Someone\\My Repo'; const origin = '\\\\server\\share\\repo';
  await writeFile(join(profile, 'local_windows.json'), JSON.stringify({ sessionId: 'local_windows', cwd, originCwd: origin, gitAnchors: [{ gitRoot: 'C:relative' }], isArchived: false }));
  const project = join(directory, 'claude', 'projects', 'C--Users-Someone-Repo'); await mkdir(project, { recursive: true });
  await writeFile(join(project, 'cli-windows.jsonl'), JSON.stringify({ cwd, gitBranch: 'windows' }) + '\n');
  const { sessions, warnings } = await conversationSessions({ desktopRoots: [join(directory, 'desktop')], claudeDir: join(directory, 'claude') });
  assert.deepEqual(warnings, []);
  assert.deepEqual(sessions.find(session => session.id === 'local_windows')?.directories, [cwd, origin]);
  assert.equal(sessions.find(session => session.id === 'cli-windows')?.directory, cwd);
});

test('Windows endpoints require local named pipes, while Unix endpoints still require a real socket', async t => {
  for (const path of ['\\\\.\\pipe\\claude-inbox-123', '\\\\?\\pipe\\claude-inbox-123']) { assert.ok(isNamedPipe(path)); await checkSocket(path, 'win32'); }
  for (const path of ['\\\\remote\\pipe\\inbox', '\\\\localhost\\pipe\\inbox', 'C:\\temp\\inbox.sock', '/tmp/inbox.sock', '\\\\.\\pipe\\', '\\\\.\\pipe\\inbox\nother']) await assert.rejects(checkSocket(path, 'win32'), /local Windows named pipe/);
  const directory = await mkdtemp(join(tmpdir(), 'nootify-win-inbox-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'regular-file'); await writeFile(file, '');
  await assert.rejects(checkSocket(file, 'darwin'), /not a socket/);
});

test('Windows runtime discovery reads a live named-pipe record without filesystem stat on the pipe', async t => {
  const registryDir = await mkdtemp(join(tmpdir(), 'nootify-win-registry-')); t.after(() => rm(registryDir, { recursive: true, force: true }));
  const pipe = '\\\\.\\pipe\\claude-nootify-runtime-test';
  await writeFile(join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'win-session', messagingSocketPath: pipe }));
  t.mock.property(process, 'platform', 'win32');
  assert.equal((await new LocalSessions({ registryDir }).inspect('win-session', 'claude-code'))?.socket_path, pipe);
});

test('lifecycle commands dispatch before the first auth token exists', async t => {
  const stateDir = join(tmpdir(), `nootify-never-created-${randomUUID()}`);
  const results: string[] = []; t.mock.method(console, 'log', (value: string) => { results.push(value); });
  for (const action of SERVICE_ACTIONS) {
    await main([`service-${action}`, '--state-dir', stateDir, '--port', '9517', '--mcp-config', 'mcp.json'], async (actual, options) => {
      assert.equal(actual, action); assert.deepEqual(options, { stateDir, port: 9517, mcpConfig: 'mcp.json' });
      return { installed: action !== 'uninstall' };
    });
  }
  assert.equal(results.length, SERVICE_ACTIONS.length);
  for (const result of results) assert.equal(typeof JSON.parse(result).installed, 'boolean');
});

test('Windows management uses fixed PowerShell and the service-root script with explicit paths', () => {
  const args = windowsServiceArgs('install', { stateDir: './private state', port: 9517, mcpConfig: './MCP account.json' });
  assert.equal(windowsPowerShell({ SystemRoot: 'D:\\Windows' }), 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(args[args.indexOf('-File') + 1], windowsServiceScript());
  assert.ok(windowsServiceScript().endsWith(join('windows', 'service.ps1')));
  assert.equal(args[args.indexOf('-NodePath') + 1], process.execPath);
  assert.ok(args[args.indexOf('-ServerPath') + 1].endsWith(join('src', 'server.js')));
  assert.equal(args[args.indexOf('-StateDir') + 1], resolve('./private state'));
  assert.equal(args[args.indexOf('-McpConfig') + 1], resolve('./MCP account.json'));
  assert.equal(args[args.indexOf('-Port') + 1], '9517');
  assert.ok(!args.includes('-Command'), 'paths are argument values, never PowerShell expressions');
});

test('service and embedded helper environments keep Windows OS paths while discarding ambient accounts', () => {
  const env = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Someone', LOCALAPPDATA: 'C:\\Local', APPDATA: 'C:\\Roaming', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', PATH: 'C:\\Windows', Node_Options: '--require injected', NODE_PATH: 'injected', LARK_APP_SECRET: 'secret', SLACK_BOT_TOKEN: 'secret', TELEGRAM_BOT_TOKEN: 'secret', GITHUB_TOKEN: 'secret', GH_TOKEN: 'secret', CODEX_APP_SERVER_TOKEN: 'secret', OPENCODE_SERVER_PASSWORD: 'secret', TS_AUTHKEY: 'secret', TAILSCALE_AUTH_KEY: 'secret', NOOTIFY_TSNET_BIN: 'untrusted-helper' };
  const expected = { SystemRoot: env.SystemRoot, USERPROFILE: env.USERPROFILE, LOCALAPPDATA: env.LOCALAPPDATA, APPDATA: env.APPDATA, TEMP: env.TEMP, TMP: env.TMP, PATH: env.PATH };
  assert.deepEqual(embeddedEnvironment(env), expected);
  assert.deepEqual(serviceEnvironment(env), expected);
  assert.ok(embeddedBinaryCandidates('win32', 'x64').every(path => path.endsWith('.exe')));
  assert.ok(embeddedBinaryCandidates('win32', 'arm64')[1].endsWith('nootify-tsnet-aarch64-pc-windows-msvc.exe'));
  assert.ok(embeddedBinaryCandidates('darwin', 'arm64')[1].endsWith('nootify-tsnet-aarch64-apple-darwin'));
});

test('generated commands quote Windows paths for PowerShell, and retain POSIX quoting', () => {
  assert.equal(shellQuote("C:\\O'Brien\\state", 'win32'), "'C:\\O''Brien\\state'");
  assert.equal(shellCommand(['C:\\Program Files\\Nootify\\node.exe', 'C:\\Nootify\\cli.js'], 'win32'), "& 'C:\\Program Files\\Nootify\\node.exe' 'C:\\Nootify\\cli.js'");
  assert.equal(shellCommand(['/opt/node', '/a b/cli.js'], 'darwin', true), "/opt/node '/a b/cli.js'");
  assert.equal(shellQuote("/O'Brien/state", 'linux'), `'/O'"'"'Brien/state'`);
});

test('Windows named pipes deliver the same authenticated frames as Unix inboxes', { skip: process.platform !== 'win32' }, async t => {
  const pipe = `\\\\.\\pipe\\nootify-test-${randomUUID()}`;
  let frames = '';
  const server = createServer(socket => { socket.on('data', data => { frames += data.toString(); }); socket.on('end', () => socket.end()); });
  server.listen(pipe); await once(server, 'listening'); t.after(() => server.close());
  assert.deepEqual(await writeInbox(pipe, 'Windows message', 'pipe-token'), { status: 'socket_written' });
  assert.deepEqual(frames.trim().split('\n').map(line => JSON.parse(line)), [{ type: 'auth', token: 'pipe-token' }, { type: 'user', message: { role: 'user', content: 'Windows message' } }]);
});

test('PowerShell ownership, task configuration, idempotence and nested job tests', { skip: process.platform !== 'win32' }, async () => {
  const { stdout } = await exec(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('../../windows/service.test.ps1', import.meta.url)), '-NodePath', process.execPath], { windowsHide: true, timeout: 60_000 });
  assert.match(stdout, /Windows service tests passed/);
});
