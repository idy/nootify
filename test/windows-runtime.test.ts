import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { main } from '../src/cli.js';
import { conversationSessions } from '../src/conversations.js';
import { checkSocket, isNamedPipe } from '../src/inbox.js';
import { LocalSessions } from '../src/local-sessions.js';
import { inboxEnvironment, windowsInboxCommand, windowsInboxScript } from '../src/native-transport.js';
import { desktopSessionRoots, isAbsolutePath, serviceStateDir } from '../src/runtime-paths.js';
import { SERVICE_ACTIONS, serviceEnvironment, windowsPowerShell, windowsServiceArgs, windowsServiceScript } from '../src/service.js';
import { SessionsService, writeInbox } from '../src/sessions.js';
import { State } from '../src/state.js';
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
  for (const path of ['\\\\remote\\pipe\\inbox', '\\\\localhost\\pipe\\inbox', 'C:\\temp\\inbox.sock', '/tmp/inbox.sock', '\\\\.\\pipe\\', '\\\\.\\pipe\\inbox\nother', '\\\\.\\pipe\\inbox\n']) await assert.rejects(checkSocket(path, 'win32'), /local Windows named pipe/);
  const directory = await mkdtemp(join(tmpdir(), 'nootify-win-inbox-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'regular-file'); await writeFile(file, '');
  await assert.rejects(checkSocket(file, 'darwin'), /not a socket/);
});

test('Windows runtime discovery reads a live named-pipe record without filesystem stat on the pipe', async t => {
  const registryDir = await mkdtemp(join(tmpdir(), 'nootify-win-registry-')); t.after(() => rm(registryDir, { recursive: true, force: true }));
  const pipe = '\\\\.\\pipe\\claude-nootify-runtime-test';
  await writeFile(join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'win-session', messagingSocketPath: pipe }));
  t.mock.property(process, 'platform', 'win32');
  const session = await new LocalSessions({ registryDir }).inspect('win-session', 'claude-code');
  assert.equal(session?.socket_path, pipe); assert.equal(session?.runtime_pid, process.pid);
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

for (const fixture of [
  { name: 'rejects malformed JSON', input: '{"frames":"private-parse-test 你好 🌍"\n',
    output: '{"error":"inbox_startup_failed"}\n', phases: ['inbox:started', 'inbox:reading', 'inbox:input'] },
  { name: 'compiles and rejects an invalid pipe', input: JSON.stringify({ path: 'not-a-local-pipe', expectedPid: process.pid,
    frames: 'private-compile-test 你好 🌍', timeout: 200 }) + '\n',
    output: '{"ready":true}\n{"error":"inbox_write_failed"}\n',
    phases: ['inbox:started', 'inbox:reading', 'inbox:input', 'inbox:compile', 'inbox:ready'] },
]) {
  test(`hidden Windows PowerShell ${fixture.name} without waiting for stdin EOF`, { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
    const command = windowsInboxCommand();
    const child = spawn(command.file, [...command.args, '-Diagnostics'], {
      windowsHide: true, env: inboxEnvironment(process.env), cwd: dirname(windowsInboxScript()), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const deadline = setTimeout(() => child.kill(), 15_000).unref();
    t.after(() => { clearTimeout(deadline); child.stdin.destroy(); child.kill(); });
    child.stdin.on('error', () => {});
    const closed = once(child, 'close');
    let output = ''; let diagnostic = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { diagnostic += chunk; });
    child.stdin.write(fixture.input); // Deliberately keep stdin open: the request is newline-framed.
    const [code] = await closed;
    const lines = diagnostic.trim().split(/\r?\n/).filter(Boolean);
    const phases = lines.filter(line => /^inbox:(started|reading|input|compile|ready)$/.test(line));
    assert.equal(code, 1, `Known startup phases: ${phases.join(',')}; unexpected stderr lines: ${lines.length - phases.length}`);
    assert.ok(output.replace(/\r\n/g, '\n') === fixture.output, 'only fixed protocol frames may reach stdout');
    assert.deepEqual(phases, fixture.phases);
    assert.equal(lines.length, phases.length, 'raw input and PowerShell errors must not appear in diagnostics');
  });
}

test('Windows named pipes deliver authenticated Unicode frames after checking the connected server', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const pipe = `\\\\.\\pipe\\nootify-test-${randomUUID()}`;
  let frames = ''; let delivered!: () => void;
  const received = new Promise<void>(resolve => { delivered = resolve; });
  const server = createServer(socket => {
    socket.setEncoding('utf8'); socket.on('data', data => { frames += data; });
    socket.on('end', () => { socket.end(); delivered(); });
  });
  server.listen(pipe); await once(server, 'listening'); t.after(() => server.close());
  assert.deepEqual(await writeInbox(pipe, 'Windows 你好 🌍', 'pipe-token', 5000, process.pid), { status: 'socket_written' });
  await received;
  assert.deepEqual(frames.trim().split('\n').map(line => JSON.parse(line)), [{ type: 'auth', token: 'pipe-token' }, { type: 'user', message: { role: 'user', content: 'Windows 你好 🌍' } }]);
});

test('Windows rejects a claimed pipe with zero token/message bytes even when the stale runtime PID is live', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-pipe-peer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // This live process represents an unrelated occupant of the stale record's PID. No account changes.
  const unrelated = spawn(process.execPath, ['-e', 'process.stdin.resume();'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  await once(unrelated, 'spawn'); t.after(() => { unrelated.stdin.end(); unrelated.kill(); });
  process.kill(unrelated.pid!, 0);
  const pipe = `\\\\.\\pipe\\nootify-claimed-${randomUUID()}`;
  let bytes = 0; let connections = 0; let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const server = createServer(socket => {
    connections++; socket.on('data', data => { bytes += data.length; }); socket.on('error', () => {});
    socket.on('end', () => socket.end()); socket.on('close', () => disconnected());
  });
  server.listen(pipe); await once(server, 'listening'); t.after(() => server.close());
  const registryDir = join(directory, 'registry'); await mkdir(registryDir);
  await writeFile(join(registryDir, `${unrelated.pid}.json`), JSON.stringify({ pid: unrelated.pid, sessionId: 'claimed', messagingSocketPath: pipe }));
  const catalog = new LocalSessions({ registryDir });
  assert.equal((await catalog.inspect('claimed', 'claude-code'))?.availability, 'active', 'kill(pid, 0) cannot authenticate a pipe');
  const state = await State.open(join(directory, 'private'));
  state.sessions.set('claimed', { session_id: 'claimed', adapter: 'claude-code', host_id: 'local', session_name: 'Claimed', socket_path: pipe, socket_token: 'must-not-leak-token' });
  const sessions = new SessionsService(state, catalog);
  await assert.rejects(sessions.send('claimed', 'must-not-leak-message', 'claude-code'),
    { name: 'UnconfirmedDeliveryError', message: 'Windows inbox authentication or write failed' });
  await closed;
  assert.equal(connections, 1, 'verification and write must share one connection'); assert.equal(bytes, 0);
  const observed = JSON.stringify((await sessions.handle({ method: 'GET', path: '/v1/sessions', body: undefined }))?.body);
  assert.ok(observed.includes('delivery_unconfirmed'));
  for (const privateField of ['runtime_pid', 'socket_path', 'socket_token', 'must-not-leak']) assert.ok(!observed.includes(privateField));
});

test('Windows native peer policy rejects foreign SIDs including reused expected PIDs', { skip: process.platform !== 'win32' }, async () => {
  const { stdout } = await exec(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('../../windows/inbox-auth.test.ps1', import.meta.url))], { windowsHide: true, timeout: 30_000 });
  assert.match(stdout, /Windows inbox peer policy tests passed/);
});

test('PowerShell ownership, task configuration, idempotence and nested job tests', { skip: process.platform !== 'win32' }, async () => {
  const { stdout } = await exec(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('../../windows/service.test.ps1', import.meta.url)), '-NodePath', process.execPath], { windowsHide: true, timeout: 60_000 });
  assert.match(stdout, /Windows service tests passed/);
});
