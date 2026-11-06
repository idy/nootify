import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { inboxEnvironment, windowsInboxCommand, windowsInboxScript, writeWindowsInbox } from '../src/native-transport.js';
import { writeInbox } from '../src/sessions.js';

const request = { path: '\\\\.\\pipe\\nootify-transport-test', expectedPid: process.pid,
  frames: '{"type":"auth","token":"private-test-token"}\n{"type":"user","message":{"role":"user","content":"你好 🌍"}}\n', timeout: 200 };
async function fixture(t: TestContext, body: string, ready = true) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-inbox-helper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = join(directory, 'helper.mjs');
  await writeFile(helper, `${ready ? 'console.log(JSON.stringify({ready:true}));' : ''}\n${body}`);
  return { directory, command: { file: process.execPath, args: [helper] }, startupTimeout: 1000 };
}

test('Windows inbox writer uses the installed PowerShell script and a credential-free allowlisted environment', () => {
  const command = windowsInboxCommand();
  assert.ok(command.file.endsWith('\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
  assert.equal(command.args[command.args.indexOf('-File') + 1], windowsInboxScript());
  assert.ok(windowsInboxScript().endsWith(join('windows', 'inbox-auth.ps1')));
  assert.ok(command.args.includes('-NoProfile')); assert.ok(command.args.includes('-NonInteractive'));
  assert.ok(!command.args.includes('-Command'));
  assert.deepEqual(inboxEnvironment({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', LOCALAPPDATA: 'C:\\Local',
    PATH: 'untrusted', PSModulePath: 'injected', NODE_OPTIONS: '--require injected', DOTNET_STARTUP_HOOKS: 'injected',
    LARK_APP_SECRET: 'private', GH_TOKEN: 'private', NOOTIFY_TSNET_BIN: 'injected' }),
  { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', LOCALAPPDATA: 'C:\\Local' });
});

test('request paths, PIDs, auth tokens and Unicode frames use only private stdin after readiness', async t => {
  const runtime = await fixture(t, `import { writeFileSync } from 'node:fs';
    let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk=>input+=chunk);
    process.stdin.on('end',()=>{writeFileSync(new URL('./record.json',import.meta.url),JSON.stringify({args:process.argv.slice(2),env:process.env,request:JSON.parse(input)}));console.log(JSON.stringify({status:'socket_written'}));});`);
  t.mock.property(process, 'env', { ...process.env, PSModulePath: 'injected', GH_TOKEN: 'ambient-secret' });
  assert.deepEqual(await writeWindowsInbox({ ...request, timeout: 1000 }, runtime), { status: 'socket_written' });
  const record = JSON.parse(await readFile(join(runtime.directory, 'record.json'), 'utf8'));
  assert.deepEqual(record.request, { ...request, timeout: 1000 }); assert.deepEqual(record.args, []);
  assert.equal(record.env.GH_TOKEN, undefined); assert.equal(record.env.PSModulePath, undefined);
});

test('Windows delivery fails closed before launching without a valid live runtime PID or local pipe', async t => {
  const runtime = { command: { file: join(tmpdir(), 'never-launch-this-inbox-helper'), args: [] } };
  for (const expectedPid of [undefined, 0, -1, 1.5, NaN, Infinity, 0x100000000]) {
    await assert.rejects(writeWindowsInbox({ ...request, expectedPid }, runtime), /requires a live runtime PID/);
  }
  for (const path of ['\\\\remote\\pipe\\inbox', '\\\\.\\pipe\\inbox\n', '\\\\.\\pipe\\inbox\\nested']) {
    await assert.rejects(writeWindowsInbox({ ...request, path }, runtime), /local Windows named pipe/);
  }
  t.mock.property(process, 'platform', 'win32');
  await assert.rejects(writeInbox(request.path, 'private-message', 'private-test-token'), /requires a live runtime PID/);
});

test('helper errors, early exits and invalid success protocols never expose raw private output', async t => {
  for (const [body, ready] of [
    ['process.stderr.write("private-test-token");console.log(JSON.stringify({error:"private-test-token"}));', true],
    ['console.log("not JSON private-test-token");', true],
    ['console.log(JSON.stringify({status:"socket_written"}));', false],
    ['console.log(JSON.stringify({status:"socket_written"}));process.exitCode=1;', true],
    ['console.log(JSON.stringify({ready:true}));', true],
    ['console.log("x".repeat(5000));', true],
    ['process.exit(0);', true],
    ['process.exit(0);', false],
  ] as const) {
    const runtime = await fixture(t, body, ready);
    await assert.rejects(writeWindowsInbox(request, runtime), { message: 'Windows inbox authentication or write failed' });
  }
});

test('both helper startup and a hung write are bounded even if the child never exits', async t => {
  const startup = await fixture(t, 'setInterval(()=>{},1000);', false);
  await assert.rejects(writeWindowsInbox(request, { ...startup, startupTimeout: 100 }), /helper startup timed out/);
  const write = await fixture(t, 'process.stdin.resume();setInterval(()=>{},1000);');
  await assert.rejects(writeWindowsInbox({ ...request, timeout: 50 }, write), /socket write timed out/);
});
