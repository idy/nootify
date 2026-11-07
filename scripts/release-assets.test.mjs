import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectReleaseAssets, mergeReleaseAssets, validateTag } from './release-assets.mjs';

const version = '1.2.3';
const mac = 'aarch64-apple-darwin';
const windows = 'x86_64-pc-windows-msvc';

async function fixture(t, targets = [windows, mac]) {
  const work = await mkdtemp(join(tmpdir(), 'nootify release test-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const input = join(work, 'input');
  await mkdir(input);
  for (const triple of targets) {
    const directory = join(work, triple, triple === mac ? 'macos' : 'nsis');
    await mkdir(directory, { recursive: true });
    const name = triple === mac ? 'Nootify.app.tar.gz' : `Nootify_${version}_x64-setup.exe`;
    await writeFile(join(directory, name), `installer ${triple}`);
    await writeFile(join(directory, `${name}.sig`), `signature-${triple}\n`);
    if (triple === mac) {
      await mkdir(join(work, triple, 'dmg'));
      await writeFile(join(work, triple, 'dmg', `Nootify_${version}_aarch64.dmg`), 'dmg');
    }
    await collectReleaseAssets({ triple, bundles: join(work, triple), output: join(input, triple), version });
  }
  return { work, input, output: join(work, 'publish'), version, repository: 'idy/nootify', notes: 'Release notes' };
}

test('one finalization combines macOS and Windows signatures, URLs and all installers', async t => {
  const options = await fixture(t);
  const manifest = await mergeReleaseAssets({ ...options, pubDate: '2026-11-06T00:00:00.000Z' });
  assert.equal(manifest.version, version);
  assert.equal(manifest.notes, 'Release notes');
  assert.equal(manifest.pub_date, '2026-11-06T00:00:00.000Z');
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-aarch64', 'windows-x86_64', 'windows-x86_64-nsis']);
  assert.equal(manifest.platforms['darwin-aarch64'].signature, `signature-${mac}`);
  assert.equal(manifest.platforms['windows-x86_64-nsis'].signature, `signature-${windows}`);
  assert.equal(manifest.platforms['windows-x86_64-nsis'].url, 'https://github.com/idy/nootify/releases/download/v1.2.3/Nootify_1.2.3_x64-setup.exe');
  assert.deepEqual(manifest.platforms['windows-x86_64'], manifest.platforms['windows-x86_64-nsis']);
  assert.deepEqual((await readdir(options.output)).sort(), [
    'Nootify.app.tar.gz', 'Nootify.app.tar.gz.sig', 'Nootify_1.2.3_aarch64.dmg',
    'Nootify_1.2.3_x64-setup.exe', 'Nootify_1.2.3_x64-setup.exe.sig', 'latest.json',
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(options.output, 'latest.json'), 'utf8')), manifest);
});

test('finalization refuses a missing platform instead of publishing a partial update', async t => {
  const options = await fixture(t, [mac]);
  await assert.rejects(mergeReleaseAssets(options), /Missing release targets: x86_64-pc-windows-msvc/);
});

test('finalization refuses a mismatched version and altered build artifact', async t => {
  const options = await fixture(t);
  await assert.rejects(mergeReleaseAssets({ ...options, version: '1.2.4' }), /version mismatch/);
  await writeFile(join(options.input, windows, 'Nootify_1.2.3_x64-setup.exe'), 'corrupt download');
  await assert.rejects(mergeReleaseAssets(options), /checksum mismatch/);
});

test('collection requires the signed updater artifact', async t => {
  const options = await fixture(t);
  await rm(join(options.work, windows, 'nsis', 'Nootify_1.2.3_x64-setup.exe.sig'));
  await assert.rejects(collectReleaseAssets({ triple: windows, bundles: join(options.work, windows), output: join(options.work, 'unsigned'), version }), /ENOENT/);
});

test('finalization refuses duplicate platforms and stale output files', async t => {
  const options = await fixture(t);
  await mkdir(options.output);
  await writeFile(join(options.output, 'old-installer.exe'), 'stale');
  await assert.rejects(mergeReleaseAssets(options), /must be empty/);
  const duplicate = join(options.input, 'duplicate');
  await mkdir(duplicate);
  await writeFile(join(duplicate, 'release.json'), await readFile(join(options.input, windows, 'release.json')));
  // The duplicate folder sorts before Windows, so copy its assets to exercise target detection.
  for (const name of await readdir(join(options.input, windows))) {
    await writeFile(join(duplicate, name), await readFile(join(options.input, windows, name)));
  }
  await assert.rejects(mergeReleaseAssets({ ...options, output: join(options.work, 'other') }), /duplicate release target/);
});

test('releases require the exact version tag, including manual workflow dispatches', () => {
  validateTag(version, 'tag', 'v1.2.3');
  assert.throws(() => validateTag(version, 'branch', 'main'), /Release from the tag/);
  assert.throws(() => validateTag(version, 'tag', 'v1.2.4'), /Release from the tag/);
});
