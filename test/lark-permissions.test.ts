import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permissionDetails } from '../src/lark-metadata.js';
import { larkPermissionHelp } from '../src/lark-permissions.js';

const appId = 'cli_0123456789abcdef';
const url = `https://open.feishu.cn/app/${appId}/auth?q=contact%3Auser.base%3Areadonly&op_from=openapi`;

test('permission metadata preserves the official provider link and requested scopes', () => {
  assert.deepEqual(permissionDetails({ code: 99991672, msg: 'Missing scope contact:user.base:readonly', error: {
    permission_violations: [{ subject: 'contact:user.base:readonly' }], helps: [{ url }],
  } }, appId), { url, scopes: ['contact:user.base:readonly'] });
  assert.deepEqual(permissionDetails({ code: 99991672, msg: `Enable contact:contact.base:readonly at ${url}` }, appId), { url, scopes: ['contact:contact.base:readonly'] });
});

test('permission URLs must belong to the same app on the official HTTPS console', () => {
  for (const link of [url.replace('open.feishu.cn', 'attacker.test'), url.replace(appId, 'cli_fedcba9876543210'), url.replace('https:', 'http:'), `https://user:password@open.feishu.cn/app/${appId}/auth`]) {
    const permission = permissionDetails({ code: 99991672, console_url: link }, appId);
    assert.equal(permission?.url, undefined);
  }
  assert.equal(permissionDetails({ code: 10014, msg: 'Invalid credentials' }, appId), undefined);
  assert.doesNotThrow(() => permissionDetails({ code: 99991672, error: { permission_violations: 'malformed', helps: [null] } }, appId));
});

test('QR codes are generated locally and retain the exact verified destination', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('QR creation must not make network requests'); });
  const help = await larkPermissionHelp(appId, { url, scopes: ['contact:user.base:readonly'] });
  assert.equal(help.url, url);
  assert.deepEqual(help.scopes, ['contact:user.base:readonly']);
  assert.match(help.qr, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(help.qr.split(',')[1]!, 'base64').subarray(1, 4).toString(), 'PNG');
});

test('untrusted QR destinations fall back to this app’s official permission page', async () => {
  const help = await larkPermissionHelp(appId, { url: 'https://attacker.test/authorize', scopes: ['contact:group:readonly', 'not-a-scope'] });
  const target = new URL(help.url);
  assert.equal(target.origin, 'https://open.feishu.cn');
  assert.equal(target.pathname, `/app/${appId}/auth`);
  assert.equal(target.searchParams.get('q'), 'contact:group:readonly');
  assert.deepEqual(help.scopes, ['contact:group:readonly']);
});
