import assert from 'node:assert/strict';
import test from 'node:test';
import { latestReleaseFlag, shouldPromoteRelease } from './release-policy.mjs';

const options = { version: '1.10.0', repository: 'idy/nootify', token: 'fixture-token' };
const response = (status, body) => ({ status, ok: status === 200, json: async () => body });

test('release precedence is numeric and rebuilding an older tag preserves latest', () => {
  assert.equal(shouldPromoteRelease('1.10.0', 'v1.9.99'), true);
  assert.equal(shouldPromoteRelease('1.9.99', 'v1.10.0'), false);
  assert.equal(shouldPromoteRelease('0.1.12', 'v0.1.13'), false);
  assert.equal(shouldPromoteRelease('1.0.0', 'v0.99.99'), true);
  assert.equal(shouldPromoteRelease('1.10.0', 'v1.10.0'), true);
  assert.equal(shouldPromoteRelease('1.10.0'), true);
  assert.equal(shouldPromoteRelease('1.10.0+new', 'v1.10.0+old'), false);
  assert.equal(shouldPromoteRelease('1.9007199254740993.0', 'v1.9007199254740992.0'), true);
});

test('serialized publication decisions remain monotonic when tag builds finish out of order', () => {
  let latest = 'v1.2.0';
  for (const version of ['1.4.0', '1.3.0', '1.2.0', '1.5.0', '1.4.0', '1.5.0']) {
    if (shouldPromoteRelease(version, latest)) latest = `v${version}`;
  }
  assert.equal(latest, 'v1.5.0');
});

test('latest lookup distinguishes no releases from authorization and network failures', async () => {
  assert.equal(await latestReleaseFlag({ ...options, request: async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/idy/nootify/releases/latest');
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    assert.ok(init.signal instanceof AbortSignal);
    return response(404);
  } }), true);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(latestReleaseFlag({ ...options, request: async () => response(status) }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(latestReleaseFlag({ ...options, request: async () => { throw new Error('network fixture'); } }), /network fixture/);
});

test('publication retains the actual current latest and refuses an unverifiable tag', async () => {
  for (const [tag_name, expected] of [['v1.11.0', false], ['v1.10.0', true], ['v1.9.0', true]]) {
    assert.equal(await latestReleaseFlag({ ...options, request: async () => response(200, { tag_name }) }), expected);
  }
  for (const body of [{}, { tag_name: 'release-unknown' }, { tag_name: 'v1.10.0', prerelease: true }]) {
    await assert.rejects(latestReleaseFlag({ ...options, request: async () => response(200, body) }));
  }
  for (const version of ['1.2', '1.02.3', '1.2.3-preview.1', 'bad']) assert.throws(() => shouldPromoteRelease(version));
});
