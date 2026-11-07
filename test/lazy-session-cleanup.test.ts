import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

// Run the actual fixture in a child: a leaked listener must fail within seconds,
// rather than keeping this test file (and the rest of CI) alive indefinitely.
const fixtureHarness = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
const sqlite = createRequire(import.meta.url)('node:sqlite');
const OriginalDatabase = sqlite.DatabaseSync;
const databases = new Map();
sqlite.DatabaseSync = class extends OriginalDatabase {
  constructor(path, ...options) {
    super(path, ...options);
    databases.set(this, dirname(path));
  }
  close() {
    super.close();
    databases.delete(this);
  }
};
const remove = fs.rm;
fs.rm = async (path, options) => {
  // SQLite's Windows file handle prevents unlinking an open database. Emulate
  // that on every platform so the teardown ordering is covered on macOS too.
  const locked = [...databases.values()].includes(path);
  if (locked || process.argv[2] === 'assertion') {
    console.error('simulated Windows EPERM during fixture cleanup');
    throw Object.assign(new Error('EPERM: cannot remove the SQLite fixture'), { code: 'EPERM' });
  }
  return remove(path, options);
};
if (process.argv[2] === 'assertion') {
  const equal = assert.equal;
  assert.equal = (actual, expected, ...options) => {
    if (expected === 'input_accepted') {
      console.error('forced assertion after opening the Codex WebSocket');
      assert.fail('forced Codex delivery assertion');
    }
    return equal(actual, expected, ...options);
  };
}
syncBuiltinESMExports();
await import(process.argv[1]);
`;

async function runFixture(t: TestContext, fault: 'lock' | 'assertion') {
  const directory = await mkdtemp(join(tmpdir(), 'ws-lazy-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Do not inherit the outer test runner's binary IPC reporter in this child.
  const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
  const result = spawnSync(process.execPath, [
    '--test-name-pattern=^Codex uses one indexed lookup', '--input-type=module', '-e', fixtureHarness,
    new URL('./lazy-sessions.test.js', import.meta.url).href, fault,
  ], {
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', windowsHide: true,
    env: { ...environment, TMPDIR: directory, TMP: directory, TEMP: directory },
  });
  const output = [result.stdout, result.stderr, result.error?.message ?? ''].join('\n');
  assert.equal(result.error, undefined, output);
  assert.equal(result.signal, null, output);
  return { status: result.status, output };
}

test('Codex fixture closes SQLite before deleting its directory on Windows', async t => {
  const result = await runFixture(t, 'lock');
  assert.equal(result.status, 0, result.output);
});

test('failed Codex assertions and directory cleanup still release backend sockets', async t => {
  const result = await runFixture(t, 'assertion');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /forced assertion after opening the Codex WebSocket/);
  assert.match(result.output, /simulated Windows EPERM during fixture cleanup/);
});
