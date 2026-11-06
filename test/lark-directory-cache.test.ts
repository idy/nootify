import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DIRECTORY_FRESH_MS, DIRECTORY_MAX_AGE_MS, LarkDirectoryCache } from '../src/lark-directory-cache.js';
import type { LarkDirectory } from '../src/lark-directory.js';
import { assertMode } from './platform-fixtures.js';

const credentials = { appId: 'cli_test', appSecret: 'test-secret-never-persist' };
const directory: LarkDirectory = { app_id: credentials.appId, users: [{ open_id: 'ou_test', name: 'Test', nickname: 'T', avatar_url: 'https://image.feishucdn.com/avatar' }], truncated: false, permission_limited: false };
const now = 2_000_000_000_000;
async function fixture(run: (path: string, file: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'nootify-directory-cache-'));
  try { await run(path, join(path, 'lark-directory-cache.json')); } finally { await rm(path, { recursive: true, force: true }); }
}

test('persists sanitized data privately across instances without credentials', async () => fixture(async (path, file) => {
  const cache = new LarkDirectoryCache(path, () => now);
  const source = { ...directory, users: [{ ...directory.users[0], email: 'private@example.invalid', avatar_url: 'https://example.invalid/image' }] };
  await cache.write(credentials, source);
  const stored = await readFile(file, 'utf8');
  await assertMode(file, 0o600);
  assert.ok(!stored.includes(credentials.appSecret)); assert.ok(!stored.includes('private@example.invalid'));
  const restored = await new LarkDirectoryCache(path, () => now).read(credentials);
  assert.deepEqual(restored, { at: now, directory: { ...directory, users: [{ open_id: 'ou_test', name: 'Test', nickname: 'T' }] } });
  restored!.directory.users.length = 0;
  assert.equal((await cache.read(credentials))!.directory.users.length, 1);
}));

test('isolates app IDs and rotated secrets in memory and on disk', async () => fixture(async path => {
  const cache = new LarkDirectoryCache(path, () => now);
  await cache.write(credentials, directory);
  for (const other of [{ ...credentials, appId: 'cli_other' }, { ...credentials, appSecret: 'rotated' }]) {
    assert.equal(await cache.read(other), undefined);
    assert.equal(await new LarkDirectoryCache(path, () => now).read(other), undefined);
  }
  assert.ok(await cache.read(credentials));
}));

test('retains stale entries for the caller but rejects expired and future timestamps', async () => fixture(async path => {
  let clock = now;
  const cache = new LarkDirectoryCache(path, () => clock);
  await cache.write(credentials, directory);
  clock = now + DIRECTORY_FRESH_MS + 1;
  assert.ok(await cache.read(credentials));
  clock = now + DIRECTORY_MAX_AGE_MS;
  assert.equal(await cache.read(credentials), undefined);
  clock = now - 1;
  assert.equal(await new LarkDirectoryCache(path, () => clock).read(credentials), undefined);
}));

test('rejects malformed, oversized, excessive-user and non-file cache files', async () => fixture(async (path, file) => {
  const cache = new LarkDirectoryCache(path, () => now);
  await cache.write(credentials, directory);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  for (const data of ['{bad', JSON.stringify({ ...saved, at: null }), JSON.stringify({ ...saved, directory: { ...directory, users: Array(5001).fill(directory.users[0]) } }), JSON.stringify({ ...saved, directory: { ...directory, users: [{ name: 'Invalid' }] } })]) {
    await writeFile(file, data);
    assert.equal(await new LarkDirectoryCache(path, () => now).read(credentials), undefined);
  }
  await writeFile(file, Buffer.alloc(32 * 1024 * 1024 + 1));
  assert.equal(await new LarkDirectoryCache(path, () => now).read(credentials), undefined);
  await rm(file); await mkdir(file);
  assert.equal(await new LarkDirectoryCache(path, () => now).read(credentials), undefined);
  await rm(file, { recursive: true });
}));

test('rejects a symlink cache file', { skip: process.platform === 'win32' ? 'File symlinks require Windows Developer Mode; native service tests cover Windows DACLs and directory redirection' : false }, async () => fixture(async (path, file) => {
  const cache = new LarkDirectoryCache(path, () => now); await cache.write(credentials, directory);
  const target = join(path, 'target.json'); await writeFile(target, await readFile(file)); await rm(file);
  await symlink(target, file);
  assert.equal(await new LarkDirectoryCache(path, () => now).read(credentials), undefined);
}));

test('clear does not resurrect disk data when deleting the file temporarily fails', async () => {
  await fixture(async (path, file) => {
    let attempts = 0;
    const cache = new LarkDirectoryCache(path, () => now, async () => { attempts++; throw Object.assign(new Error('Fixture delete denied'), { code: 'EACCES' }); });
    await cache.write(credentials, directory);
    await cache.clear();
    assert.equal(attempts, 1);
    assert.ok(await readFile(file, 'utf8'));
    assert.equal(await cache.read(credentials), undefined);
  });
});

test('IO failures are best effort and memory still works', async () => fixture(async (path, file) => {
  await writeFile(file, 'not a directory');
  const cache = new LarkDirectoryCache(file, () => now);
  await cache.write(credentials, directory);
  assert.deepEqual(await cache.read(credentials), { directory, at: now });
  await cache.clear();
  assert.equal(await cache.read(credentials), undefined);
}));

test('sanitizes optional fields, permission metadata and matching official links', async () => fixture(async path => {
  const cache = new LarkDirectoryCache(path, () => now);
  await cache.write(credentials, { ...directory, permission: { scopes: ['contact:user:readonly', 'secret', 'contact:user:readonly'], url: 'https://example.invalid/auth' },
    users: [{ ...directory.users[0], en_name: '  English  ', nickname: 7 as unknown as string }] });
  const restored = await new LarkDirectoryCache(path, () => now).read(credentials);
  assert.deepEqual(restored!.directory.permission, { scopes: ['contact:user:readonly'] });
  assert.deepEqual(restored!.directory.users[0], { open_id: 'ou_test', name: 'Test', en_name: 'English', avatar_url: directory.users[0].avatar_url });
  const permission = { scopes: ['contact:user:readonly'], url: 'https://open.feishu.cn/app/cli_test/auth' };
  await cache.write(credentials, { ...directory, permission });
  assert.deepEqual((await new LarkDirectoryCache(path, () => now).read(credentials))!.directory.permission, permission);
}));

test('serializes concurrent snapshots, clones reads and removes temporary files', async () => fixture(async path => {
  const cache = new LarkDirectoryCache(path, () => now);
  const source = structuredClone(directory);
  const first = cache.write(credentials, source);
  source.users[0].name = 'Second';
  const second = cache.write(credentials, source);
  source.users[0].name = 'Unwritten';
  await Promise.all([first, second]);
  const restored = await cache.read(credentials);
  assert.equal(restored!.directory.users[0].name, 'Second');
  restored!.directory.users.length = 0;
  assert.equal((await cache.read(credentials))!.directory.users.length, 1);
  assert.equal((await new LarkDirectoryCache(path, () => now).read(credentials))!.directory.users[0].name, 'Second');
  assert.deepEqual(await readdir(path), ['lark-directory-cache.json']);
}));

test('clear serializes after outstanding writes and prevents resurrection', async () => fixture(async path => {
  const cache = new LarkDirectoryCache(path, () => now);
  const write = cache.write(credentials, directory);
  const clear = cache.clear();
  await Promise.all([write, clear]);
  assert.equal(await cache.read(credentials), undefined);
  assert.equal(await new LarkDirectoryCache(path, () => now).read(credentials), undefined);
  await cache.write(credentials, directory);
  assert.ok(await cache.read(credentials));
}));
