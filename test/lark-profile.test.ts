import assert from 'node:assert/strict';
import { test } from 'node:test';
import { larkAvatarURL, recipientDisplayName } from '../src/lark-profile.js';

test('nickname and default name display together without inventing or duplicating names', () => {
  assert.equal(recipientDisplayName({ nickname: '小云', name: '林舟' }), '小云（林舟）');
  assert.equal(recipientDisplayName({ nickname: '小云', name: '小云（林舟）' }), '小云（林舟）');
  assert.equal(recipientDisplayName({ nickname: 'Mao', name: 'Mao (Dong)' }), 'Mao (Dong)');
  assert.equal(recipientDisplayName({ nickname: 'Yan', name: 'Yan' }), 'Yan');
  assert.equal(recipientDisplayName({ name: '小云（林舟）' }), '小云（林舟）');
  assert.equal(recipientDisplayName({ name: '', nickname: '小云' }), '小云');
  assert.equal(recipientDisplayName({ nickname: '  小云 ', name: ' 林舟 ' }), '小云（林舟）');
});

test('avatars accept only untouched HTTPS Feishu image CDN URLs', () => {
  const url = 'https://s1-imfile.feishucdn.com/static-resource/avatar.png?token=opaque';
  assert.equal(larkAvatarURL(url), url);
  for (const unsafe of [null, '', 'http://s1-imfile.feishucdn.com/avatar', 'https://s1-imfile.feishucdn.com.attacker.test/avatar', 'https://127.0.0.1/avatar', 'https://name:secret@s1-imfile.feishucdn.com/avatar', 'https://s1-imfile.feishucdn.com:123/avatar', 'data:image/png;base64,xxx']) assert.equal(larkAvatarURL(unsafe), undefined);
});
