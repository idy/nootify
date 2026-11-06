import assert from 'node:assert/strict';
import { test } from 'node:test';
import { larkAvatarURL, recipientDisplayName } from '../src/lark-profile.js';
import { larkDirectory } from '../src/lark-directory.js';

test('nickname and default name display together without inventing or duplicating names', () => {
  assert.equal(recipientDisplayName({ nickname: '小云', name: '林舟' }), '小云（林舟）');
  assert.equal(recipientDisplayName({ nickname: '小云', name: '小云（林舟）' }), '小云（林舟）');
  assert.equal(recipientDisplayName({ nickname: 'Mao', name: 'Mao (Dong)' }), 'Mao (Dong)');
  assert.equal(recipientDisplayName({ nickname: 'Yan', name: 'Yan' }), 'Yan');
  assert.equal(recipientDisplayName({ name: '小云（林舟）' }), '小云（林舟）');
  assert.equal(recipientDisplayName({ name: '', nickname: '小云' }), '小云');
  assert.equal(recipientDisplayName({ nickname: '  小云 ', name: ' 林舟 ' }), '小云（林舟）');
});

test('directory retains nickname and preferred avatar without exposing unrelated profile fields', async () => {
  const avatar = 'https://s1-imfile.feishucdn.com/avatar72.png';
  const page = await larkDirectory({ appId: 'cli_0123456789abcdef', async request<T>(_method: string, path: string): Promise<T> {
    return (path.includes('/scopes') ? { user_ids: ['ou_person'] } : { items: [{ open_id: 'ou_person', name: '林舟', nickname: '小云', avatar: { avatar_72: avatar, avatar_240: 'https://s1-imfile.feishucdn.com/avatar240.png' }, email: 'private@example.com' }] }) as T;
  } });
  assert.deepEqual(page.users, [{ open_id: 'ou_person', name: '林舟', nickname: '小云', avatar_url: avatar }]);
  assert.ok(!JSON.stringify(page).includes('private@example.com'));
});

test('a later avatar for an existing user reaches progressive snapshots', async () => {
  let release!: () => void; const first = new Promise<void>(resolve => { release = resolve; });
  const seen: (string | undefined)[] = [];
  const avatar = 'https://s1-imfile.feishucdn.com/new-avatar.png';
  const page = await larkDirectory({ appId: 'cli_0123456789abcdef', async request<T>(_method: string, path: string): Promise<T> {
    if (path.includes('/scopes')) return { user_ids: ['ou_person'], department_ids: ['od-root'] } as T;
    if (path.includes('/children')) return {} as T;
    if (path.includes('/find_by_department')) { await first; return { items: [{ open_id: 'ou_person', name: 'Name', avatar: { avatar_72: avatar } }] } as T; }
    return { items: [{ open_id: 'ou_person', name: 'Name' }] } as T;
  } }, undefined, snapshot => { seen.push(snapshot.users[0]?.avatar_url); release(); });
  assert.deepEqual(seen, [undefined, avatar]);
  assert.equal(page.users[0]?.avatar_url, avatar);
});

test('avatars accept only untouched HTTPS Feishu image CDN URLs', () => {
  const url = 'https://s1-imfile.feishucdn.com/static-resource/avatar.png?token=opaque';
  assert.equal(larkAvatarURL(url), url);
  for (const unsafe of [null, '', 'http://s1-imfile.feishucdn.com/avatar', 'https://s1-imfile.feishucdn.com.attacker.test/avatar', 'https://127.0.0.1/avatar', 'https://name:secret@s1-imfile.feishucdn.com/avatar', 'https://s1-imfile.feishucdn.com:123/avatar', 'data:image/png;base64,xxx']) assert.equal(larkAvatarURL(unsafe), undefined);
});
