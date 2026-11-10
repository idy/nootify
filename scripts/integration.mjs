// Headless process integration: build only the notification core and its
// synthetic upstream fixture, never the MyGo desktop or platform installers.
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'nootify-headless-'));
const suffix = process.platform === 'win32' ? '.exe' : '';
const core = join(work, `nootify-core${suffix}`);
const upstream = join(work, `upstream-fixture.test${suffix}`);
let child;
const controller = new AbortController();
const stop = () => { controller.abort(); if (child && child.exitCode === null) child.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  await mkdir(join(root, '.cache'), { recursive: true });
  await rm(join(root, '.cache/headless-integration.xml'), { force: true });
  await chmod(work, 0o700);
  const buildEnv = { ...process.env, CGO_ENABLED: '0' };
  // Compile for this host even when a cross-package CI target is selected.
  delete buildEnv.GOOS; delete buildEnv.GOARCH;
  const buildOptions = { cwd: root, env: buildEnv, timeout: 120_000, signal: controller.signal, maxBuffer: 8 << 20, windowsHide: true };
  await run('go', ['-C', 'native/core', 'build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-o', core, '.'], buildOptions);
  await run('go', ['-C', 'native/core', 'test', '-c', '-mod=readonly', '-o', upstream], buildOptions);
  const env = { ...process.env, NOOTIFY_INTEGRATION_ROOT: work, NOOTIFY_INTEGRATION_CORE_BIN: core, NOOTIFY_INTEGRATION_UPSTREAM_BIN: upstream };
  delete env.NODE_TEST_CONTEXT;
  controller.signal.throwIfAborted();
  child = spawn(process.execPath, ['--test', '--test-timeout=120000',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=junit', `--test-reporter-destination=${join(root, '.cache/headless-integration.xml')}`,
    join(root, 'integration/headless.test.mjs')], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
} catch (error) {
  console.error(`Headless integration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  await rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  console.log('Headless integration: temporary workspace removed; no desktop or system service was started.');
}
