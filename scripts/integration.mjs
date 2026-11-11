// Exercise the installed Go CLI and HTTP host against the synthetic upstream.
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const active = new Set();
let interrupted;
const stop = signal => {
  interrupted = signal;
  for (const child of active) child.kill(signal);
};
const onInterrupt = () => stop('SIGINT');
const onTerminate = () => stop('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);

function run(file, args, env = process.env) {
  if (interrupted) return Promise.reject(new Error(`Integration interrupted by ${interrupted}`));
  return new Promise((resolve, reject) => {
    // npm is a command script on Windows; every argument here is a fixed build command.
    const child = spawn(file, args, { cwd: root, env, stdio: 'inherit', windowsHide: true,
      shell: process.platform === 'win32' && file === 'npm.cmd' });
    active.add(child);
    child.once('error', error => { active.delete(child); reject(error); });
    child.once('close', (code, signal) => {
      active.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${file} ${args.join(' ')} failed (${signal ?? code})`));
    });
  });
}

let work;
try {
  const cache = join(root, '.cache');
  const report = join(cache, 'headless-integration.xml');
  await mkdir(cache, { recursive: true });
  await rm(report, { force: true });
  // Keep standalone invocation equivalent to npm run test:integration: embedded
  // assets must exist before building the actual desktop/CLI executable.
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
  work = await realpath(await mkdtemp(join(cache, 'headless-integration-')));
  await chmod(work, 0o700);
  const binaryDir = join(work, 'bin');
  await mkdir(binaryDir, { mode: 0o700 });
  const executable = name => join(binaryDir, name + (process.platform === 'win32' ? '.exe' : ''));
  const service = executable('service-test');
  const cli = executable('nootify');
  const upstream = executable('upstream-test');
  // This is an executing integration suite even in a cross-packaging shell.
  const buildEnv = { ...process.env };
  delete buildEnv.GOOS; delete buildEnv.GOARCH;
  await run('go', ['test', '-c', '-o', service, './internal/host'], buildEnv);
  await run('go', ['build', '-o', cli, './desktop'], buildEnv);
  await run('go', ['test', '-c', '-o', upstream, './native/core'], buildEnv);
  const env = {
    ...process.env,
    NOOTIFY_INTEGRATION_ROOT: work,
    NOOTIFY_INTEGRATION_SERVICE_BIN: service,
    NOOTIFY_INTEGRATION_CLI_BIN: cli,
    NOOTIFY_INTEGRATION_UPSTREAM_BIN: upstream,
  };
  delete env.NODE_TEST_CONTEXT;
  await run(process.execPath, ['--test', '--test-timeout=120000',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=junit', `--test-reporter-destination=${report}`,
    join(root, 'integration', 'headless.test.mjs')], env);
} catch (error) {
  console.error(error.message);
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
} finally {
  if (work) await rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
