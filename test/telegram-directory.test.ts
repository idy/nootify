import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTelegramTransport, telegramDirectory } from '../src/telegram.js';

const config = { bot_token: '123:fixture_SECRET', chat_id: '-100123456', user_id: '42' };
const chat = { id: -100123456, type: 'supergroup', is_forum: true, title: 'Forum' };

test('directory merges human administrators and known candidates without polling', async t => {
  const calls: { method: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').at(-1)!;
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    assert.equal(init?.redirect, 'error');
    return Response.json({ ok: true, result: method === 'getChat' ? chat : [
      { status: 'creator', user: { id: 42, is_bot: false, first_name: 'Alice', last_name: 'Smith' } },
      { status: 'administrator', user: { id: 43, is_bot: false, first_name: 'Bob' } },
      { status: 'administrator', user: { id: 44, is_bot: true, first_name: 'Bot' } },
      { status: 'member', user: { id: 45, is_bot: false, first_name: 'Other' } },
      { status: 'administrator', user: { id: 9007199254740992, is_bot: false, first_name: 'Invalid' } },
    ] });
  });
  const result = await telegramDirectory(config, { users: [{ id: '42', name: 'Old' }, { id: '46', name: 'Known' }], chats: [{ id: '-100789', name: 'Known chat' }] });
  assert.deepEqual(result, { users: [{ id: '42', name: 'Alice Smith' }, { id: '46', name: 'Known' }, { id: '43', name: 'Bob' }], chats: [{ id: '-100789', name: 'Known chat' }, { id: config.chat_id, name: 'Forum' }], limited: true });
  assert.deepEqual(calls, [{ method: 'getChat', body: { chat_id: config.chat_id } }, { method: 'getChatAdministrators', body: { chat_id: config.chat_id } }]);
});

test('directory safely handles network, API and malformed responses', async t => {
  for (const response of [
    () => { throw new Error(`https://api.telegram.org/bot${config.bot_token}/getChat`); },
    () => Response.json({ ok: false, error_code: 403, description: config.bot_token }, { status: 403 }),
    () => Response.json({ ok: true, result: 'invalid' }),
  ]) await t.test('safe error', async child => {
    child.mock.method(globalThis, 'fetch', async () => response());
    await assert.rejects(telegramDirectory(config), error => {
      assert.ok(error instanceof Error);
      assert.ok(!String(error.stack).includes(config.bot_token));
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});

test('directory accepts token-only setup and rejects unsafe IDs before fetching', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unexpected'); });
  assert.deepEqual(await telegramDirectory({ ...config, chat_id: '', user_id: '' }, { users: [{ id: '42', name: 'Known' }], chats: [] }), { users: [{ id: '42', name: 'Known' }], chats: [], limited: true });
  await assert.rejects(telegramDirectory({ ...config, chat_id: '-1009007199254740993' }), /Invalid Telegram configuration/);
  assert.equal(requests, 0);
});


test('live candidate capture precedes routing filters, skips backlog and remains bounded', async t => {
  let polls = 0;
  const human = { id: 42, is_bot: false, first_name: 'Owner' };
  const bot = { id: 123, is_bot: true, username: 'fixture_bot' };
  const update = (update_id: number, userId: number, extra = {}) => ({ update_id, message: { from: { ...human, id: userId }, chat, ...extra } });
  const transport = await createTelegramTransport(config, { fetch: async (input, init) => {
    const method = String(input).split('/').at(-1);
    const body = JSON.parse(String(init?.body));
    let result: unknown;
    switch (method) {
      case 'getMe': result = bot; break;
      case 'getChat': result = chat; break;
      case 'getChatMember': result = body.user_id === bot.id ? { status: 'administrator', can_manage_topics: true, user: bot } : { status: 'member', user: human }; break;
      case 'getWebhookInfo': result = { url: '' }; break;
      case 'getUpdates':
        if (++polls === 1) result = [update(1, 999)];
        else if (polls === 2) result = [
          update(2, 888, { from: { id: 888, is_bot: true } }),
          update(3, 887, { sender_chat: chat }),
          ...Array.from({ length: 205 }, (_, i) => update(i + 4, i + 1000)),
        ];
        else return new Promise<Response>(() => {});
        break;
      default: throw new Error('Unexpected API method');
    }
    return Response.json({ ok: true, result });
  } });
  t.after(() => transport.stop());
  let routed = 0;
  await transport.start(async () => { routed++; }, () => {});
  for (let i = 0; polls < 3 && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(polls, 3);
  assert.equal(routed, 0, 'messages without topics must not be routed');
  const targets = transport.directoryTargets!();
  assert.equal(targets.users.length, 200);
  assert.deepEqual(targets.users[0], { id: '1000', name: 'Owner' });
  assert.deepEqual(targets.chats, [{ id: config.chat_id, name: 'Forum' }]);
  assert.equal(targets.limited, true);
  targets.users.length = 0;
  assert.equal(transport.directoryTargets!().users.length, 200, 'returns a detached snapshot');
});
