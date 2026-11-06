import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchdLabel } from '../src/launchd.js';
import { assertLaunchdOwnership, manageService, windowsPowerShell, type ServiceExecutor } from '../src/service.js';

async function fixture(t: TestContext, loaded = true) {
  const home = await mkdtemp(join(tmpdir(), 'nootify-service-management-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, 'Library', 'LaunchAgents'); await mkdir(directory, { recursive: true });
  const plist = join(directory, `${launchdLabel}.plist`); await writeFile(plist, 'fixture-owned-plist');
  const stateDir = join(home, 'state');
  const data = { Label: launchdLabel, ProgramArguments: [process.execPath, fileURLToPath(new URL('../src/server.js', import.meta.url)), '--state-dir', stateDir, '--port', '9417'],
    WorkingDirectory: stateDir, StandardOutPath: join(stateDir, 'stdout.log'), StandardErrorPath: join(stateDir, 'stderr.log') };
  const calls: [string, string[]][] = [];
  const execute: ServiceExecutor = async (file, args) => {
    calls.push([file, args]);
    if (file === '/usr/bin/plutil') return { stdout: JSON.stringify(data) };
    assert.equal(file, 'launchctl');
    if (args[0] === 'print' && !loaded) throw new Error('not loaded');
    return { stdout: '' };
  };
  return { home, plist, data, calls, options: { stateDir, port: 9417 }, runtime: { platform: 'darwin' as const, uid: 501, home, execute } };
}

test('mac service-start kickstarts a loaded job without restarting its live process', async t => {
  const { calls, options, runtime } = await fixture(t);
  await manageService('start', options, runtime);
  await manageService('start', options, runtime);
  assert.deepEqual(calls.filter(([file]) => file === 'launchctl').map(([, args]) => args), [
    ['print', `gui/501/${launchdLabel}`], ['kickstart', `gui/501/${launchdLabel}`],
    ['print', `gui/501/${launchdLabel}`], ['kickstart', `gui/501/${launchdLabel}`],
  ]);
});

test('mac start loads an unloaded owned job, while restart only forces an already loaded job', async t => {
  const unloaded = await fixture(t, false);
  await manageService('start', unloaded.options, unloaded.runtime);
  assert.deepEqual(unloaded.calls.filter(([file]) => file === 'launchctl').map(([, args]) => args), [
    ['print', `gui/501/${launchdLabel}`], ['bootstrap', 'gui/501', unloaded.plist], ['kickstart', `gui/501/${launchdLabel}`],
  ]);
  const loaded = await fixture(t);
  await manageService('restart', loaded.options, loaded.runtime);
  assert.deepEqual(loaded.calls.at(-1), ['launchctl', ['kickstart', '-k', `gui/501/${launchdLabel}`]]);
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
  assert.deepEqual(calls.at(-1), ['launchctl', ['bootout', `gui/501/${launchdLabel}`]]);
  assert.deepEqual(await manageService('uninstall', options, runtime), { installed: false, status: 'uninstalled', plist });
  await assert.rejects(stat(plist), { code: 'ENOENT' });
  calls.length = 0;
  assert.deepEqual(await manageService('status', options, runtime), { installed: false });
  assert.deepEqual(await manageService('uninstall', options, runtime), { installed: false, status: 'uninstalled' });
  assert.deepEqual(await manageService('stop', options, runtime), { installed: false, status: 'stopped' });
  assert.deepEqual(calls, []);
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
