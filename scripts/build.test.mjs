import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildTarget } from './build-targets.mjs';
import { verifyWindowsX64 } from './bundle-utils.mjs';

const mac = buildTarget('aarch64-apple-darwin');
const windows = buildTarget('x86_64-pc-windows-msvc');

test('desktop target selection keeps supported Go platforms distinct', () => {
  assert.equal(buildTarget('', 'darwin', 'arm64'), mac);
  assert.equal(buildTarget('', 'win32', 'x64'), windows);
  assert.deepEqual(windows.bundles, ['nsis']);
  assert.deepEqual(mac.bundles, ['app', 'dmg']);
  assert.equal(windows.goos, 'windows');
  assert.equal(windows.goarch, 'amd64');
  assert.throws(() => buildTarget('', 'win32', 'arm64'), /Unsupported/);
  assert.throws(() => buildTarget('x86_64-unknown-linux-gnu'), /Unsupported/);
});

test('production targets contain no downloaded Node runtime or helper metadata', () => {
  for (const target of [mac, windows]) {
    assert.ok(!('nodeRelease' in target));
    assert.ok(!('nodeSha256' in target));
  }
});

test('PE validation rejects wrong architecture and truncated executables without running them', async t => {
  const work = await mkdtemp(join(tmpdir(), 'nootify-build-test-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const path = join(work, 'Nootify.exe');
  const pe = Buffer.alloc(134);
  pe.write('MZ');
  pe.writeUInt32LE(128, 60);
  pe.write('PE\0\0', 128);
  pe.writeUInt16LE(0x8664, 132);
  await writeFile(path, pe);
  await verifyWindowsX64(path);
  pe.writeUInt16LE(0xaa64, 132);
  await writeFile(path, pe);
  await assert.rejects(verifyWindowsX64(path), /x64/);
  await writeFile(path, pe.subarray(0, 133));
  await assert.rejects(verifyWindowsX64(path), /x64/);
  await writeFile(path, 'not an executable');
  await assert.rejects(verifyWindowsX64(path), /PE executable/);
});

test('the committed ICO contains multiple Windows icon sizes', async () => {
  const icon = await readFile(new URL('../desktop/icons/icon.ico', import.meta.url));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok(icon.readUInt16LE(4) >= 3);
  for (let i = 0; i < icon.readUInt16LE(4); i++) {
    const position = 6 + 16 * i;
    assert.ok(icon.readUInt32LE(position + 8) > 0);
    assert.ok(icon.readUInt32LE(position + 12) + icon.readUInt32LE(position + 8) <= icon.length);
  }
});
