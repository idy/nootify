import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { launchdLabel } from '../src/launchd.js';
import { assertLaunchdOwnership, manageService, windowsPowerShell, type ServiceExecutor } from '../src/service.js';

const exec = promisify(execFile);
const absentLaunchdJob = () => Object.assign(new Error('fixture missing service'), {
  code: 113, killed: false, signal: null, stdout: '',
  stderr: `Bad request.\nCould not find service "${launchdLabel}" in domain for user gui: 501\n`,
});

async function listener(t: TestContext) {
  let service = 'another-service';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ service }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const close = async () => {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
  };
  t.after(close);
  return { port, close, setService: (value: string) => { service = value; } };
}

async function fixture(t: TestContext, loaded = true, port = 9417) {
  const home = await mkdtemp(join(tmpdir(), 'nootify-service-management-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, 'Library', 'LaunchAgents'); await mkdir(directory, { recursive: true });
  const plist = join(directory, `${launchdLabel}.plist`); await writeFile(plist, 'fixture-owned-plist');
  const stateDir = join(home, 'state');
  const data = { Label: launchdLabel, ProgramArguments: [process.execPath, fileURLToPath(new URL('../src/server.js', import.meta.url)), '--state-dir', stateDir, '--port', String(port)],
    WorkingDirectory: stateDir, StandardOutPath: join(stateDir, 'stdout.log'), StandardErrorPath: join(stateDir, 'stderr.log') };
  const calls: [string, string[]][] = [];
  const execute: ServiceExecutor = async (file, args, options) => {
    calls.push([file, args]);
    if (file === '/usr/bin/plutil') return { stdout: JSON.stringify(data) };
    assert.equal(file, '/bin/launchctl');
    if (args[0] === 'print') {
      assert.equal(options?.timeout, 5000);
      assert.equal(options?.env?.LC_ALL, 'C');
      if (!loaded) throw absentLaunchdJob();
    }
    return { stdout: '' };
  };
  return { home, plist, data, calls, options: { stateDir, port }, runtime: { platform: 'darwin' as const, uid: 501, home, execute } };
}

test('mac service-start kickstarts a loaded job without restarting its live process', async t => {
  const { calls, options, runtime } = await fixture(t);
  await manageService('start', options, runtime);
  await manageService('start', options, runtime);
  assert.deepEqual(calls.filter(([file]) => file === '/bin/launchctl').map(([, args]) => args), [
    ['print', `gui/501/${launchdLabel}`], ['kickstart', `gui/501/${launchdLabel}`],
    ['print', `gui/501/${launchdLabel}`], ['kickstart', `gui/501/${launchdLabel}`],
  ]);
});

test('mac start loads an unloaded owned job, while restart only forces an already loaded job', async t => {
  const free = await listener(t); await free.close();
  const unloaded = await fixture(t, false, free.port);
  await manageService('start', unloaded.options, unloaded.runtime);
  assert.deepEqual(unloaded.calls.filter(([file]) => file === '/bin/launchctl').map(([, args]) => args), [
    ['print', `gui/501/${launchdLabel}`], ['bootstrap', 'gui/501', unloaded.plist], ['kickstart', `gui/501/${launchdLabel}`],
  ]);
  const loaded = await fixture(t);
  await manageService('restart', loaded.options, loaded.runtime);
  assert.deepEqual(loaded.calls.at(-1), ['/bin/launchctl', ['kickstart', '-k', `gui/501/${launchdLabel}`]]);
});

test('mac management uses absolute launchctl paths with an empty PATH', async t => {
  const f = await fixture(t);
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  const previous = process.env[pathKey];
  try {
    process.env[pathKey] = '';
    const execute: ServiceExecutor = async (file, args, options) => {
      if (file === '/bin/launchctl' && args[0] === 'print') {
        // Windows preserves the original key casing and may omit empty variables.
        const paths = Object.entries(options?.env ?? {}).filter(([key]) => key.toUpperCase() === 'PATH');
        assert.ok(paths.every(([, value]) => !value), 'the scheduler must run without any usable PATH');
      }
      return f.runtime.execute(file, args, options);
    };
    assert.equal((await manageService('stop', f.options, { ...f.runtime, execute })).status, 'stopped');
    assert.deepEqual(f.calls.map(([file]) => file), ['/usr/bin/plutil', '/bin/launchctl', '/bin/launchctl']);
    await stat(f.plist);
  } finally {
    if (previous === undefined) delete process.env[pathKey]; else process.env[pathKey] = previous;
  }
});

test('mac management retains the plist and performs no action when scheduler state is unknown', async t => {
  const f = await fixture(t);
  const failures = [
    Object.assign(new Error('missing executable'), { code: 'ENOENT' }),
    Object.assign(new Error('denied executable'), { code: 'EACCES' }),
    Object.assign(new Error('scheduler unavailable'), { code: 1, stderr: 'Operation not permitted' }),
    Object.assign(absentLaunchdJob(), { killed: true }),
    Object.assign(absentLaunchdJob(), { signal: 'SIGTERM' }),
    Object.assign(absentLaunchdJob(), { stderr: 'Could not find domain for user gui: 501' }),
    Object.assign(absentLaunchdJob(), { stderr: 'Could not find service "another.service" in domain for user gui: 501' }),
    Object.assign(absentLaunchdJob(), { stderr: `Could not find service "${launchdLabel}" in domain for user gui: 502` }),
    Object.assign(absentLaunchdJob(), { stdout: 'partial scheduler snapshot' }),
    new Error('unknown scheduler failure'),
  ];
  for (const action of ['start', 'restart', 'stop', 'uninstall'] as const) for (const failure of failures) {
    f.calls.length = 0;
    const execute: ServiceExecutor = async (file, args, options) => {
      const result = await f.runtime.execute(file, args, options);
      if (file === '/bin/launchctl' && args[0] === 'print') throw failure;
      return result;
    };
    await assert.rejects(manageService(action, f.options, { ...f.runtime, execute }), /Cannot query.*plist was retained/);
    assert.deepEqual(f.calls.filter(([file]) => file === '/bin/launchctl').map(([, args]) => args), [['print', `gui/501/${launchdLabel}`]]);
    assert.equal(await readFile(f.plist, 'utf8'), 'fixture-owned-plist');
  }
});

test('mac management accepts only the explicit absent-job result before deleting an unloaded plist', async t => {
  for (const prefix of ['', 'Bad request.\n']) {
    const f = await fixture(t);
    const execute: ServiceExecutor = async (file, args, options) => {
      const result = await f.runtime.execute(file, args, options);
      if (file === '/bin/launchctl' && args[0] === 'print') throw Object.assign(absentLaunchdJob(), {
        stderr: `${prefix}Could not find service "${launchdLabel}" in domain for user gui: 501\n`,
      });
      return result;
    };
    assert.equal((await manageService('stop', f.options, { ...f.runtime, execute })).status, 'stopped');
    await stat(f.plist);
    assert.equal((await manageService('uninstall', f.options, { ...f.runtime, execute })).status, 'uninstalled');
    await assert.rejects(stat(f.plist), { code: 'ENOENT' });
    assert.ok(f.calls.filter(([file]) => file === '/bin/launchctl').every(([, args]) => args[0] === 'print'));
  }
});

test('new mac management commands reject other install paths, altered arguments and unrelated plists before launchctl or deletion', async t => {
  const { data, calls, options, runtime, plist } = await fixture(t);
  for (const change of [
    (value: typeof data) => { value.Label = 'another.application'; },
    (value: typeof data) => { value.ProgramArguments[0] += '-another-node'; },
    (value: typeof data) => { value.ProgramArguments[1] += '-another-server'; },
    (value: typeof data) => { value.ProgramArguments[3] += '-another-state'; },
    (value: typeof data) => { value.ProgramArguments.push('--injected'); },
    (value: typeof data) => { value.ProgramArguments.push('--mcp-config', 'relative-config.json'); },
  ]) {
    const changed = structuredClone(data); change(changed);
    assert.throws(() => assertLaunchdOwnership(changed, options), /Refusing to control/);
  }
  data.ProgramArguments[1] += '-another-install';
  for (const action of ['stop', 'uninstall', 'status'] as const) await assert.rejects(manageService(action, options, runtime), /another installation/);
  assert.ok(calls.every(([file]) => file === '/usr/bin/plutil'));
  assert.equal(await readFile(plist, 'utf8'), 'fixture-owned-plist');
});

test('mac stop retains an owned plist; uninstall removes only that plist and is idempotent when absent', async t => {
  const { calls, options, runtime, plist } = await fixture(t);
  assert.deepEqual(await manageService('stop', options, runtime), { installed: true, status: 'stopped', plist });
  await stat(plist);
  assert.deepEqual(calls.at(-1), ['/bin/launchctl', ['bootout', `gui/501/${launchdLabel}`]]);
  assert.deepEqual(await manageService('uninstall', options, runtime), { installed: false, status: 'uninstalled', plist });
  await assert.rejects(stat(plist), { code: 'ENOENT' });
  calls.length = 0;
  assert.deepEqual(await manageService('status', options, runtime), { installed: false });
  assert.deepEqual(await manageService('uninstall', options, runtime), { installed: false, status: 'uninstalled' });
  assert.deepEqual(await manageService('stop', options, runtime), { installed: false, status: 'stopped' });
  assert.deepEqual(calls, []);
});

test('mac start and restart refuse occupied ports before bootstrapping an unloaded job', async t => {
  const occupied = await listener(t);
  const f = await fixture(t, false, occupied.port);
  for (const service of ['another-service', 'nootify']) {
    occupied.setService(service);
    for (const action of ['start', 'restart'] as const) {
      f.calls.length = 0;
      await assert.rejects(manageService(action, f.options, f.runtime), /stop the existing service/);
      assert.deepEqual(f.calls.filter(([file]) => file === '/bin/launchctl').map(([, args]) => args), [['print', `gui/501/${launchdLabel}`]]);
      assert.equal(await readFile(f.plist, 'utf8'), 'fixture-owned-plist');
      const response = await fetch(`http://127.0.0.1:${occupied.port}/health`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(1000) });
      assert.deepEqual(await response.json(), { service }, 'the unmanaged listener remains alive');
    }
  }
});

test('mac unloaded uninstall leaves an unrelated occupied listener running', async t => {
  const occupied = await listener(t); const f = await fixture(t, false, occupied.port);
  await manageService('uninstall', f.options, f.runtime);
  assert.deepEqual(f.calls.filter(([file]) => file === '/bin/launchctl').map(([, args]) => args), [['print', `gui/501/${launchdLabel}`]]);
  await assert.rejects(stat(f.plist), { code: 'ENOENT' });
  const response = await fetch(`http://127.0.0.1:${occupied.port}/health`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(await response.json(), { service: 'another-service' });
});

for (const action of ['stop', 'uninstall'] as const) {
  test(`mac ${action} waits for the owned process after bootout and listener closure`, { skip: process.platform !== 'darwin', timeout: 10_000 }, async t => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createServer } from 'node:http';
      const server = createServer();
      process.on('SIGTERM', () => {
        server.closeAllConnections();
        server.close(() => process.send({ stage: 'listener-closed' }));
      });
      process.on('message', message => { if (message === 'exit') process.exit(0); });
      server.listen(0, '127.0.0.1', () => process.send({ stage: 'ready', port: server.address().port }));
    `], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = ''; child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
      }
    });
    const [ready] = await once(child, 'message'); assert.equal(ready.stage, 'ready');
    const f = await fixture(t, true, Number(ready.port));
    let bootedOut = false; let checked!: () => void;
    const checkedAfterBootout = new Promise<void>(resolveChecked => { checked = resolveChecked; });
    const execute: ServiceExecutor = async (file, args, options) => {
      if (file === '/bin/ps') {
        assert.deepEqual(args, ['-p', String(child.pid), '-o', 'lstart=']);
        assert.equal(options?.timeout, 1000); assert.equal(options?.env?.LC_ALL, 'C');
        const result = await exec(file, args, { ...options, encoding: 'utf8' });
        if (bootedOut) checked();
        return result;
      }
      const result = await f.runtime.execute(file, args, options);
      if (args[0] === 'print') return { stdout: `fixture = {\n  pid = ${child.pid}\n}\n` };
      if (args[0] === 'bootout') { assert.equal(child.kill('SIGTERM'), true); bootedOut = true; }
      return result;
    };
    const listenerClosed = once(child, 'message');
    let settled = false;
    const outcome = manageService(action, f.options, { ...f.runtime, execute }).then(
      value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    const beforeCompletion = (phase: Promise<unknown>) => Promise.race([phase, outcome.then(result => {
      if ('error' in result) throw result.error;
      throw new Error('Management completed before the fixture process exited');
    })]);
    const [closedMessage] = await beforeCompletion(listenerClosed) as [Record<string, unknown>];
    assert.equal(closedMessage.stage, 'listener-closed');
    await beforeCompletion(checkedAfterBootout);
    assert.equal(settled, false, 'listener closure is not process exit');
    await stat(f.plist);
    const exited = once(child, 'exit'); child.send('exit');
    assert.deepEqual(await exited, [0, null], errors);
    const result = await outcome; if ('error' in result) throw result.error;
    assert.equal(result.value.status, action === 'stop' ? 'stopped' : 'uninstalled');
    if (action === 'stop') await stat(f.plist);
    else await assert.rejects(stat(f.plist), { code: 'ENOENT' });
  });
}

test('mac shutdown times out without success or plist deletion while the owned identity remains alive', async t => {
  const f = await fixture(t); let bootedOut = false;
  const execute: ServiceExecutor = async (file, args, options) => {
    if (file === '/bin/ps') return { stdout: 'Sat Nov  7 12:00:00 2026\n' };
    const result = await f.runtime.execute(file, args, options);
    if (args[0] === 'print') return { stdout: `pid = ${process.pid}\n` };
    if (args[0] === 'bootout') bootedOut = true;
    return result;
  };
  for (const action of ['stop', 'uninstall'] as const) {
    await assert.rejects(manageService(action, f.options, { ...f.runtime, execute, shutdownTimeout: 10 }), /not finished shutting down/);
    assert.equal(bootedOut, true);
    assert.equal(await readFile(f.plist, 'utf8'), 'fixture-owned-plist');
  }
});

test('mac shutdown fails closed on denied or empty identity queries before or after bootout', async t => {
  const f = await fixture(t);
  for (const afterBootout of [false, true]) for (const denied of [false, true]) {
    let queries = 0; let bootedOut = false;
    const execute: ServiceExecutor = async (file, args, options) => {
      if (file === '/bin/ps') {
        queries++;
        if (afterBootout && queries === 1) return { stdout: 'Sat Nov  7 12:00:00 2026\n' };
        if (denied) throw Object.assign(new Error('fixture denial'), { code: 'EACCES' });
        return { stdout: '' };
      }
      const result = await f.runtime.execute(file, args, options);
      if (args[0] === 'print') return { stdout: `pid = ${process.pid}\n` };
      if (args[0] === 'bootout') bootedOut = true;
      return result;
    };
    await assert.rejects(manageService('uninstall', f.options, { ...f.runtime, execute }), /Cannot verify.*identity/);
    assert.equal(bootedOut, afterBootout);
    await stat(f.plist);
  }
});

test('mac shutdown recognizes PID reuse by start time without waiting on the replacement', async t => {
  const f = await fixture(t); let queries = 0;
  const execute: ServiceExecutor = async (file, args, options) => {
    if (file === '/bin/ps') return { stdout: ++queries === 1 ? 'Sat Nov  7 12:00:00 2026\n' : 'Sat Nov  7 12:00:01 2026\n' };
    const result = await f.runtime.execute(file, args, options);
    return args[0] === 'print' ? { stdout: `pid = ${process.pid}\n` } : result;
  };
  assert.equal((await manageService('uninstall', f.options, { ...f.runtime, execute })).status, 'uninstalled');
  assert.equal(queries, 2);
  await assert.rejects(stat(f.plist), { code: 'ENOENT' });
});

test('mac shutdown rejects malformed launchd PIDs before bootout or deletion', async t => {
  const f = await fixture(t);
  for (const pid of ['0', '-1', 'NaN', '9007199254740992']) {
    f.calls.length = 0;
    const execute: ServiceExecutor = async (file, args, options) => {
      const result = await f.runtime.execute(file, args, options);
      return args[0] === 'print' ? { stdout: `pid = ${pid}\n` } : result;
    };
    await assert.rejects(manageService('uninstall', f.options, { ...f.runtime, execute }), /Cannot verify.*process ID/);
    assert.ok(f.calls.every(([, args]) => args[0] !== 'bootout'));
    await stat(f.plist);
  }
});

test('Windows status reads management JSON without an auth file, hides its console and bounds the lookup', async () => {
  const result = await manageService('status', { port: 9417 }, { platform: 'win32', execute: async (file, args, options) => {
    assert.equal(file, windowsPowerShell());
    assert.equal(args[args.indexOf('-Action') + 1], 'Status');
    assert.equal(options?.windowsHide, true);
    assert.equal(options?.timeout, 5000);
    return { stdout: '﻿{"installed":false}\n' };
  } });
  assert.deepEqual(result, { installed: false });
});

test('Windows ownership and management errors propagate before any HTTP access', async () => {
  await assert.rejects(manageService('uninstall', { port: 9417 }, { platform: 'win32', execute: async () => {
    throw Object.assign(new Error('command with arguments'), { stderr: 'Refusing an unrelated Scheduled Task' });
  } }), { message: 'Refusing an unrelated Scheduled Task' });
});
