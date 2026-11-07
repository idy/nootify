// Expand test filenames in Node: npm uses cmd.exe on Windows, which does not expand globs.
import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_TEST_TIMEOUT = 180_000;

/** Set the test deadline and report output; CI also bounds the step if a cleanup hook never finishes. */
export function runTestFiles(tests, { timeout = DEFAULT_TEST_TIMEOUT, reportPath, cwd = root, stdio = 'inherit' } = {}) {
  if (!tests.length) throw new Error('No tests found');
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Invalid test timeout');
  const args = ['--test', `--test-timeout=${timeout}`, '--test-reporter=spec', '--test-reporter-destination=stdout'];
  // FULL-sync SQLite fixtures and native compiler children share the hosted Windows
  // disk/CPU budget. Keep file-level work serial; tests retain their own concurrency.
  if (process.platform === 'win32') args.push('--test-concurrency=1');
  if (reportPath) args.push('--test-reporter=junit', `--test-reporter-destination=${reportPath}`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This is a new runner, even when exercised from a runner regression test.
  return spawn(process.execPath, [...args, ...tests], { cwd, stdio, env });
}

async function main() {
  const tests = [];
  for (const [directory, suffix] of [['dist/test', '.test.js'], ['test', '.test.cjs'], ['scripts', '.test.mjs']]) {
    for (const name of (await readdir(join(root, directory))).sort()) {
      if (name.endsWith(suffix)) tests.push(join(root, directory, name));
    }
  }
  await mkdir(join(root, '.cache'), { recursive: true });
  const child = runTestFiles(tests, { reportPath: join(root, '.cache', 'test-results.xml') });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
