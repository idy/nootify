import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createMacDmg } from './desktop.mjs';

const run = promisify(execFile);
const busyDiagnostic = 'hdiutil: create failed - Resource busy\n';

async function fixture(t) {
  const work = await mkdtemp(join(tmpdir(), 'nootify dmg packaging '));
  t.after(() => rm(work, { recursive: true, force: true }));
  const source = join(work, 'source with spaces');
  const output = join(work, 'output with spaces', 'Nootify_1.2.3_aarch64.dmg');
  await mkdir(source);
  await mkdir(dirname(output));
  await writeFile(join(source, 'payload.txt'), 'synthetic payload, never a desktop executable');
  await writeFile(output, 'previous complete installer');
  return { source, output };
}

async function assertUnpublished(f) {
  assert.equal(await readFile(f.output, 'utf8'), 'previous complete installer');
  assert.equal(await readFile(join(f.source, 'payload.txt'), 'utf8'), 'synthetic payload, never a desktop executable');
}

async function assertClean(f) {
  assert.deepEqual(await readdir(dirname(f.output)), ['Nootify_1.2.3_aarch64.dmg']);
}

test('DMG busy retries isolate partial images and publish only after signing succeeds', async t => {
  const f = await fixture(t);
  const images = []; const waits = []; let signs = 0;
  await createMacDmg(f.source, f.output, {
    wait: async ms => { await assertUnpublished(f); waits.push(ms); },
    execute: async (command, args, options) => {
      await assertUnpublished(f);
      const image = args.at(-1);
      assert.notEqual(image, f.output);
      assert.ok(options.timeout > 0 && options.timeout <= 120_000);
      if (command === '/usr/bin/hdiutil') {
        assert.equal(args[args.indexOf('-srcfolder') + 1], f.source);
        assert.ok(args.includes('-nospotlight'));
        assert.ok(!args.includes('-attach'));
        images.push(image);
        await writeFile(image, 'partial image');
        if (images.length === 1) throw Object.assign(new Error('generic native busy'), { code: 1, stderr: busyDiagnostic });
        if (images.length === 2) throw Object.assign(new Error('native EBUSY'), { code: 16, stderr: 'localized native diagnostic' });
        await writeFile(image, 'unsigned complete image');
      } else {
        assert.equal(command, '/usr/bin/codesign');
        assert.equal(args[args.indexOf('--sign') + 1], '-');
        assert.equal(await readFile(image, 'utf8'), 'unsigned complete image');
        signs++;
        await writeFile(image, 'signed complete image');
      }
    },
  });
  assert.equal(new Set(images).size, 3);
  assert.equal(signs, 1);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(await readFile(f.output, 'utf8'), 'signed complete image');
  await assertClean(f);
});

test('persistent DMG busy preserves the previous installer and returns the last native failure', async t => {
  const f = await fixture(t);
  let calls = 0; const waits = []; let last;
  await assert.rejects(createMacDmg(f.source, f.output, {
    wait: async ms => { waits.push(ms); },
    execute: async (command, args) => {
      assert.equal(command, '/usr/bin/hdiutil');
      calls++;
      await writeFile(args.at(-1), 'partial image');
      last = Object.assign(new Error(`native busy attempt ${calls}`), { code: 16, stderr: busyDiagnostic });
      throw last;
    },
  }), error => error === last);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
  await assertUnpublished(f);
  await assertClean(f);
});

test('DMG permission, disk, spawn, timeout and unrelated diagnostics fail without retry', async t => {
  for (const [name, values] of [
    ['permission', { code: 1, stderr: 'hdiutil: create failed - Permission denied\n' }],
    ['disk-full', { code: 28, stderr: 'hdiutil: create failed - No space left on device\n' }],
    ['spawn', { code: 'ENOENT', stderr: busyDiagnostic }],
    ['timeout', { code: 16, killed: true, signal: 'SIGTERM', stderr: busyDiagnostic }],
    ['signal', { code: 16, signal: 'SIGKILL', stderr: busyDiagnostic }],
    ['stdout-only', { code: 1, stdout: busyDiagnostic, stderr: 'unrelated failure' }],
    ['partial-match', { code: 1, stderr: 'payload contains hdiutil: create failed - Resource busy\n' }],
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t);
      const failure = Object.assign(new Error(name), values);
      let calls = 0;
      await assert.rejects(createMacDmg(f.source, f.output, {
        wait: async () => assert.fail('hard failures must not sleep or retry'),
        execute: async (command, args) => {
          assert.equal(command, '/usr/bin/hdiutil');
          calls++;
          await writeFile(args.at(-1), 'partial image');
          throw failure;
        },
      }), error => error === failure);
      assert.equal(calls, 1);
      await assertUnpublished(f);
      await assertClean(f);
    });
  }
});

test('DMG signing failure does not retry creation or replace the completed installer', async t => {
  const f = await fixture(t);
  const failure = Object.assign(new Error('signing failed'), { code: 16, stderr: busyDiagnostic });
  let creates = 0; let signs = 0;
  await assert.rejects(createMacDmg(f.source, f.output, {
    wait: async () => assert.fail('signing failure must not retry creation'),
    execute: async (command, args) => {
      if (command === '/usr/bin/hdiutil') { creates++; await writeFile(args.at(-1), 'unsigned image'); }
      else { assert.equal(command, '/usr/bin/codesign'); signs++; throw failure; }
    },
  }), error => error === failure);
  assert.equal(creates, 1); assert.equal(signs, 1);
  await assertUnpublished(f);
  await assertClean(f);
});

test('native DMG creation, signing and checksum verification stay headless', {
  skip: process.platform !== 'darwin' || process.env.NOOTIFY_TEST_NATIVE_DMG !== '1',
  timeout: 420_000,
}, async t => {
  const f = await fixture(t);
  await createMacDmg(f.source, f.output);
  await run('/usr/bin/hdiutil', ['verify', '-quiet', f.output], { timeout: 30_000 });
  await run('/usr/bin/codesign', ['--verify', '--strict', f.output], { timeout: 30_000 });
  const { stdout } = await run('/usr/bin/hdiutil', ['imageinfo', '-plist', f.output], { timeout: 30_000 });
  assert.match(stdout, /<string>UDZO<\/string>/);
  await assertClean(f);
});
