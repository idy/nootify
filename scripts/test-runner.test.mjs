import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runTestFiles } from './test.mjs';

async function fixture(t, body) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'fixture.test.cjs');
  await writeFile(file, body);
  const reportPath = join(directory, 'results.xml');
  return { directory, file, reportPath };
}
async function execute(file, options) {
  const child = runTestFiles([file], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const [code, signal] = await once(child, 'close');
  return { code, signal, stdout, stderr };
}

test('the test runner executes a selected file and writes a machine-readable report', async t => {
  const f = await fixture(t, "require('node:test').test('known passing test', () => {});\n");
  const result = await execute(f.file, { reportPath: f.reportPath });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /known passing test/);
  assert.match(await readFile(f.reportPath, 'utf8'), /<testsuites|<testsuite/);
});
