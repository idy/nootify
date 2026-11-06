import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createTelegramTransport, type TelegramTransportOptions } from '../src/telegram.js';
import type { ChatMessage, TelegramConfig } from '../src/chat-transport.js';

const config: TelegramConfig = { bot_token: '123456:fixture_SECRET-token', chat_id: '-1001234567890', user_id: '987654321' };
const bot = { id: 123456, is_bot: true, username: 'nootify_fixture_bot', can_read_all_group_messages: false };
const human = { id: Number(config.user_id), is_bot: false, first_name: 'Owner' };
const chat = { id: Number(config.chat_id), type: 'supergroup', is_forum: true };
interface Call { method: string; body: Record<string, unknown>; signal: AbortSignal; init: RequestInit }
type Handler = (call: Call) => Response | Promise<Response> | undefined;
function ok(result: unknown): Response { return Response.json({ ok: true, result }); }
function failure(code: number, description = config.bot_token, parameters?: unknown): Response {
  return Response.json({ ok: false, error_code: code, description, parameters }, { status: code });
}
function gate<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await nextTurn(); }
  assert.fail('The expected fixture operation did not occur.');
}
function message(update_id: number, overrides: Record<string, unknown> = {}, thread = 51) {
  return { update_id, message: { message_id: update_id + 1000, from: human, chat, message_thread_id: thread, is_topic_message: true, text: `command ${update_id}`, ...overrides } };
}
function blocked(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new Error(`Raw fetch failure at https://api.telegram.org/bot${config.bot_token}/getUpdates`));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
async function fixture(t: TestContext, handler?: Handler, options: TelegramTransportOptions = {}) {
  const calls: Call[] = []; let sent = 2000;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const method = String(_input).split('/').at(-1)!;
    const call = { method, body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init!.signal!, init: init! };
    calls.push(call);
    const override = handler?.(call);
    if (override !== undefined) return override;
    switch (method) {
      case 'getMe': return ok(bot);
      case 'getChat': return ok(chat);
      case 'getChatMember': return ok(call.body.user_id === bot.id ? { status: 'administrator', can_manage_topics: true, user: bot } : { status: 'creator', user: human });
      case 'getWebhookInfo': return ok({ url: '' });
      case 'createForumTopic': return ok({ message_thread_id: 51, name: call.body.name });
      case 'sendMessage': return ok({ message_id: ++sent, chat, message_thread_id: call.body.message_thread_id });
      case 'getUpdates': return call.body.offset === -1 ? ok([]) : blocked(call.signal);
      default: throw new Error(`Unexpected fixture method ${method}`);
    }
  };
  const transport = await createTelegramTransport(config, { fetch, ...options });
  t.after(() => transport.stop());
  return { transport, calls, fetch };
}
function safeError(error: unknown, expected: RegExp): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, expected);
  assert.ok(!String(error.stack).includes(config.bot_token), 'errors must not reveal the token-bearing URL');
  assert.equal(error.cause, undefined);
  return true;
}

test('Telegram verifies the forum, bot administrator and human before polling', async t => {
  const { transport, calls } = await fixture(t);
  assert.equal(transport.identity, `telegram:${bot.id}:${config.chat_id}`);
  assert.equal(transport.account, '@nootify_fixture_bot');
  assert.deepEqual(calls.map(call => call.method), ['getMe', 'getChat', 'getChatMember', 'getChatMember', 'getWebhookInfo']);
  assert.deepEqual(calls[2].body, { chat_id: config.chat_id, user_id: bot.id });
  assert.deepEqual(calls[3].body, { chat_id: config.chat_id, user_id: human.id });
  assert.ok(calls.every(call => call.init.method === 'POST' && call.init.redirect === 'error'));
  // Administrators receive ordinary messages even when the bot's privacy-mode flag is false.
  const statuses: string[] = [];
  await transport.start(async () => {}, status => statuses.push(status));
  assert.deepEqual(statuses, ['ready']);
  assert.deepEqual(calls[5].body, { offset: -1, timeout: 0, limit: 1, allowed_updates: ['message'] });
  assert.deepEqual(calls[6].body, { offset: 0, timeout: 25, allowed_updates: ['message'] });
});

test('Telegram rejects invalid or unsafe config before making any request', async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; return ok(bot); };
  for (const invalid of [
    { ...config, bot_token: 'not-a-token' }, { ...config, chat_id: '-123' },
    { ...config, chat_id: '-1009007199254740993' }, { ...config, user_id: '9007199254740993' },
    { ...config, user_id: '01' }, { ...config, user_id: '0' }, { ...config, user_id: '1.5' },
  ]) await assert.rejects(createTelegramTransport(invalid, { fetch }), error => safeError(error, /Invalid Telegram configuration/));
  assert.equal(requests, 0);
});

test('Telegram validates all setup response boundaries and never removes webhooks', async t => {
  const cases: { name: string; handler: Handler; error: RegExp }[] = [
    { name: 'getMe is a human', handler: call => call.method === 'getMe' ? ok({ ...bot, is_bot: false }) : undefined, error: /identify a bot/ },
    { name: 'unsafe bot id', handler: call => call.method === 'getMe' ? ok({ ...bot, id: Number.MAX_SAFE_INTEGER + 1 }) : undefined, error: /identify a bot/ },
    { name: 'wrong forum chat', handler: call => call.method === 'getChat' ? ok({ ...chat, id: -100999 }) : undefined, error: /forum supergroup/ },
    { name: 'regular group', handler: call => call.method === 'getChat' ? ok({ ...chat, type: 'group' }) : undefined, error: /forum supergroup/ },
    { name: 'topics disabled', handler: call => call.method === 'getChat' ? ok({ ...chat, is_forum: false }) : undefined, error: /forum supergroup/ },
    { name: 'not administrator', handler: call => call.method === 'getChatMember' && call.body.user_id === bot.id ? ok({ status: 'member', user: bot }) : undefined, error: /administrator/ },
    { name: 'cannot manage topics', handler: call => call.method === 'getChatMember' && call.body.user_id === bot.id ? ok({ status: 'administrator', can_manage_topics: false, user: bot }) : undefined, error: /manage topics/ },
    { name: 'wrong administrator identity', handler: call => call.method === 'getChatMember' && call.body.user_id === bot.id ? ok({ status: 'creator', user: { ...bot, id: bot.id + 1 } }) : undefined, error: /administrator/ },
    { name: 'trusted account is a bot', handler: call => call.method === 'getChatMember' && call.body.user_id === human.id ? ok({ status: 'member', user: { ...human, is_bot: true } }) : undefined, error: /verified human/ },
    { name: 'wrong human identity', handler: call => call.method === 'getChatMember' && call.body.user_id === human.id ? ok({ status: 'member', user: { ...human, id: human.id + 1 } }) : undefined, error: /verified human/ },
    { name: 'existing webhook', handler: call => call.method === 'getWebhookInfo' ? ok({ url: `https://example.com/${config.bot_token}` }) : undefined, error: /already has a webhook/ },
    { name: 'missing webhook info', handler: call => call.method === 'getWebhookInfo' ? ok({}) : undefined, error: /invalid webhook information/ },
  ];
  for (const item of cases) await t.test(item.name, async child => {
    const methods: string[] = [];
    await assert.rejects(fixture(child, call => { methods.push(call.method); return item.handler(call); }), error => safeError(error, item.error));
    assert.ok(!methods.includes('deleteWebhook'));
    assert.ok(!methods.includes('getUpdates'));
  });
  await t.test('creator has implicit topic permissions', async child => {
    const { transport } = await fixture(child, call => call.method === 'getChatMember' && call.body.user_id === bot.id ? ok({ status: 'creator', user: bot }) : undefined);
    assert.equal(transport.account, '@nootify_fixture_bot');
  });
});

test('Telegram creates Unicode-safe forum names and normalizes topic IDs', async t => {
  const { transport, calls } = await fixture(t);
  const location = await transport.openThread('  ' + '😀'.repeat(129) + '  ');
  assert.deepEqual(location, { chat_id: config.chat_id, thread_id: '51' });
  const call = calls.find(call => call.method === 'createForumTopic')!;
  assert.deepEqual(call.body, { chat_id: config.chat_id, name: '😀'.repeat(128) });
  assert.equal(Array.from(String(call.body.name)).length, 128);
  await transport.openThread('   ');
  assert.equal(calls.at(-1)?.body.name, 'Nootify');
});

test('Telegram sends plaintext chunks in the topic and validates immutable reply destinations', async t => {
  const { transport, calls } = await fixture(t);
  const location = await transport.openThread('Session');
  const first = await transport.send(location, '*literal* <tag>');
  assert.deepEqual(first, { message_id: '2001' });
  const text = 'a'.repeat(3499) + '😀' + 'b'.repeat(3500);
  const result = await transport.send(location, text, first.message_id);
  const outgoing = calls.filter(call => call.method === 'sendMessage');
  assert.deepEqual(result, { message_id: '2004' });
  assert.equal(outgoing.length, 4);
  assert.deepEqual(outgoing[0].body, { chat_id: config.chat_id, message_thread_id: 51, text: '*literal* <tag>' });
  const chunks = outgoing.slice(1);
  assert.equal(chunks.map(call => call.body.text).join(''), text);
  assert.deepEqual(chunks.map(call => String(call.body.text).length), [3499, 3500, 2]);
  assert.deepEqual(chunks[0].body.reply_parameters, { message_id: 2001, allow_sending_without_reply: false });
  assert.ok(chunks.slice(1).every(call => !('reply_parameters' in call.body)));
  assert.ok(outgoing.every(call => !('parse_mode' in call.body) && !('entities' in call.body) && call.body.chat_id === config.chat_id && call.body.message_thread_id === 51));
  // A persisted original message need not have been observed by this transport instance.
  await transport.send(location, 'reply after restart', '999999');
  assert.deepEqual(calls.at(-1)?.body.reply_parameters, { message_id: 999999, allow_sending_without_reply: false });
  const count = calls.length;
  await assert.rejects(transport.send(location, 'unsafe reply', '9007199254740993'), /Invalid Telegram reply message ID/);
  await assert.rejects(transport.send(location, 'non-numeric reply', 'not-an-id'), /Invalid Telegram reply message ID/);
  await assert.rejects(transport.send({ ...location, chat_id: '-100999' }, 'wrong chat'), /destination/);
  await assert.rejects(transport.send({ ...location, thread_id: '9007199254740993' }, 'unsafe topic'), /destination/);
  await assert.rejects(transport.send({ ...location, thread_id: '0' }, 'unthreaded'), /destination/);
  await assert.rejects(transport.send(location, ''), /contain text/);
  assert.equal(calls.length, count, 'invalid destinations and replies must not reach Telegram');
});

test('Telegram skips the startup backlog and advances offsets across every ignored update', async t => {
  const received: ChatMessage[] = []; const statuses: string[] = [];
  let polls = 0;
  const batch = [
    message(42, { from: { ...human, id: human.id + 1 } }), message(43, { from: { ...human, is_bot: true } }),
    message(44, { chat: { ...chat, id: -100777 } }), message(45, { sender_chat: chat }),
    { update_id: 46, edited_message: message(46).message }, message(47, { message_thread_id: undefined }),
    message(48, { is_topic_message: undefined }), message(49, { message_id: Number.MAX_SAFE_INTEGER + 1 }),
    message(50, { message_thread_id: '9007199254740993' }), message(51, { from: { ...human, id: '9007199254740993' } }),
    message(52, { message_id: '3052', message_thread_id: '51', from: { ...human, id: config.user_id }, chat: { ...chat, id: config.chat_id } }),
    message(53), message(53), message(54, { text: '  ' }), message(55, { text: undefined, caption: 'not text' }),
    message(56, { edit_date: 123 }), message(57, { chat: { ...chat, type: 'group' } }),
    message(Number.MAX_SAFE_INTEGER), message(-1),
  ];
  const { transport, calls } = await fixture(t, call => {
    if (call.method !== 'getUpdates') return;
    polls++;
    if (polls === 1) return ok([message(41)]);
    if (polls === 2) return ok(batch);
  });
  await transport.start(async incoming => { received.push(incoming); }, status => statuses.push(status));
  await until(() => polls === 3);
  assert.deepEqual(received, [
    { chat_id: config.chat_id, thread_id: '51', message_id: '3052', sender_id: config.user_id, text: 'command 52' },
    { chat_id: config.chat_id, thread_id: '51', message_id: '1053', sender_id: config.user_id, text: 'command 53' },
  ]);
  assert.deepEqual(calls.filter(call => call.method === 'getUpdates').map(call => call.body.offset), [-1, 42, 58]);
  assert.deepEqual(statuses, ['ready']);
  assert.deepEqual(await transport.send({ chat_id: config.chat_id, thread_id: '51' }, 'ack', '1053'), { message_id: '2001' });
});

test('Telegram serializes receive callbacks and contains callback/status failures', async t => {
  const first = gate<void>(); const entered: string[] = []; const statuses: string[] = []; let polls = 0;
  const { transport } = await fixture(t, call => {
    if (call.method === 'getUpdates') {
      polls++;
      if (polls === 1) return ok([]);
      if (polls === 2) return ok([message(1), message(2)]);
    }
  });
  await transport.start(async incoming => {
    entered.push(incoming.message_id);
    if (entered.length === 1) { await first.promise; throw new Error(config.bot_token); }
  }, status => { statuses.push(status); throw new Error(config.bot_token); });
  await until(() => entered.length === 1);
  assert.deepEqual(entered, ['1001']);
  assert.equal(polls, 2, 'the next poll waits for the entire receive batch');
  first.resolve();
  await until(() => polls === 3);
  assert.deepEqual(entered, ['1001', '1002']);
  assert.ok(statuses.includes('failed'));
});

test('Telegram stop aborts a poll promptly, suppresses late responses and preserves its offset on restart', { timeout: 1000 }, async t => {
  const late = gate<Response>(); const received: ChatMessage[] = []; const statuses: string[] = []; let polls = 0;
  const { transport, calls } = await fixture(t, call => {
    if (call.method !== 'getUpdates') return;
    polls++;
    if (polls === 1) return ok([message(71)]);
    if (polls === 2) return late.promise; // Deliberately ignores cancellation.
  });
  const start = transport.start(async incoming => { received.push(incoming); }, status => statuses.push(status));
  await Promise.all([start, transport.start(async () => assert.fail('duplicate start'), () => assert.fail('duplicate status'))]);
  await until(() => polls === 2);
  const polling = calls.find(call => call.method === 'getUpdates' && call.body.timeout === 25)!;
  await transport.stop();
  assert.ok(polling.signal.aborted);
  const count = statuses.length;
  late.resolve(ok([message(72)])); await nextTurn();
  assert.equal(received.length, 0); assert.equal(statuses.length, count);
  await transport.start(async incoming => { received.push(incoming); }, status => statuses.push(status));
  await until(() => polls === 3);
  assert.deepEqual(calls.filter(call => call.method === 'getUpdates').map(call => call.body.offset), [-1, 72, 72]);
});

test('Telegram stop during delivery does not wait for the callback or start another delivery', { timeout: 1000 }, async t => {
  const pending = gate<void>(); let delivered = 0; let polls = 0;
  const { transport } = await fixture(t, call => {
    if (call.method === 'getUpdates') {
      if (++polls === 1) return ok([]);
      if (polls === 2) return ok([message(1), message(2)]);
    }
  });
  await transport.start(async () => { delivered++; await pending.promise; }, () => {});
  await until(() => delivered === 1);
  await transport.stop();
  pending.reject(new Error(config.bot_token)); await nextTurn();
  assert.equal(delivered, 1); assert.equal(polls, 2);
});

test('Telegram retries transient errors with capped exponential delay and resets after recovery', async t => {
  const delays: number[] = []; const statuses: string[] = []; const received: ChatMessage[] = []; let polls = 0;
  const { transport, calls } = await fixture(t, call => {
    if (call.method !== 'getUpdates') return;
    polls++;
    if (polls === 1) return ok([]);
    if (polls === 2) throw new Error(`fetch failed https://api.telegram.org/bot${config.bot_token}/getUpdates`);
    if (polls === 3 || polls === 4) return failure(503);
    if (polls === 5) return failure(429, config.bot_token, { retry_after: 999_999 });
    if (polls === 6) return ok([message(9)]);
    if (polls === 7) return failure(500);
  }, { retryBaseMs: 2, retryMaxMs: 8, wait: async delay => { delays.push(delay); } });
  await transport.start(async incoming => { received.push(incoming); }, status => statuses.push(status));
  await until(() => polls === 8);
  assert.deepEqual(delays, [2, 4, 8, 8, 2]);
  assert.deepEqual(statuses, ['ready', 'reconnecting', 'ready', 'reconnecting']);
  assert.equal(received[0]?.message_id, '1009');
  assert.deepEqual(calls.filter(call => call.method === 'getUpdates').map(call => call.body.offset), [-1, 0, 0, 0, 0, 0, 10, 10]);
});

test('Telegram startup retries the seek without dispatching stale commands', async t => {
  const delays: number[] = []; const received: ChatMessage[] = []; const statuses: string[] = []; let polls = 0;
  const { transport, calls } = await fixture(t, call => {
    if (call.method !== 'getUpdates') return;
    polls++;
    if (polls === 1) return failure(503);
    if (polls === 2) return ok([message(88)]);
  }, { retryBaseMs: 1, wait: async delay => { delays.push(delay); } });
  await transport.start(async incoming => { received.push(incoming); }, status => statuses.push(status));
  await until(() => polls === 3);
  assert.deepEqual(delays, [1]); assert.deepEqual(received, []);
  assert.deepEqual(statuses, ['reconnecting', 'ready']);
  assert.deepEqual(calls.filter(call => call.method === 'getUpdates').map(call => call.body.offset), [-1, -1, 89]);
});

test('Telegram reports webhook/poller conflicts explicitly without retrying', async t => {
  for (const duringStartup of [true, false]) await t.test(duringStartup ? 'startup' : 'running', async child => {
    const statuses: string[] = []; const delays: number[] = []; let polls = 0;
    const { transport } = await fixture(child, call => {
      if (call.method !== 'getUpdates') return;
      polls++;
      if (!duringStartup && polls === 1) return ok([]);
      return failure(409);
    }, { wait: async delay => { delays.push(delay); } });
    const starting = transport.start(async () => assert.fail('conflict cannot deliver'), status => statuses.push(status));
    if (duringStartup) await assert.rejects(starting, error => safeError(error, /polling conflict.*webhook or another getUpdates poller/));
    else { await starting; await until(() => statuses.includes('failed')); }
    assert.equal(polls, duringStartup ? 1 : 2); assert.deepEqual(delays, []);
    assert.equal(statuses.at(-1), 'failed');
  });
});

test('Telegram stop interrupts pending startup and backoff, including injected waits ignoring abort', { timeout: 1000 }, async t => {
  const waiting = gate<void>(); let enteredWait = false;
  const { transport } = await fixture(t, call => call.method === 'getUpdates' ? failure(500) : undefined,
    { wait: () => { enteredWait = true; return waiting.promise; } });
  const started = transport.start(async () => {}, () => {});
  await until(() => enteredWait);
  await transport.stop(); await started;
  waiting.reject(new Error(config.bot_token)); await nextTurn();
});

test('Telegram request deadlines abort hung fetches and expose only safe errors', async t => {
  let signal: AbortSignal | undefined;
  await assert.rejects(createTelegramTransport(config, {
    requestTimeoutMs: 2,
    fetch: async (_input, init) => { signal = init!.signal!; return new Promise<Response>(() => {}); },
  }), error => safeError(error, /getMe request timed out/));
  assert.ok(signal?.aborted);
  const waiting = gate<void>(); let enteredWait = false; const statuses: string[] = [];
  const { transport, calls } = await fixture(t, undefined, {
    pollTimeoutMs: 2, wait: () => { enteredWait = true; return waiting.promise; },
  });
  await transport.start(async () => {}, status => statuses.push(status));
  await until(() => enteredWait);
  assert.deepEqual(statuses, ['ready', 'reconnecting']);
  assert.ok(calls.find(call => call.method === 'getUpdates' && call.body.timeout === 25)?.signal.aborted);
  await transport.stop(); waiting.resolve();
});

test('Telegram scrubs raw fetch, API and malformed-body errors without retrying outgoing posts', async t => {
  const errors: Handler[] = [
    call => { if (call.method === 'sendMessage') throw new Error(`https://api.telegram.org/bot${config.bot_token}/sendMessage`); },
    call => call.method === 'sendMessage' ? failure(400) : undefined,
    call => call.method === 'sendMessage' ? new Response(config.bot_token, { status: 200 }) : undefined,
    call => call.method === 'sendMessage' ? ok({ message_id: Number.MAX_SAFE_INTEGER + 1, chat, message_thread_id: 51 }) : undefined,
    call => call.method === 'sendMessage' ? ok({ message_id: 1, chat, message_thread_id: 52 }) : undefined,
  ];
  for (const handler of errors) {
    const { transport, calls } = await fixture(t, handler);
    await assert.rejects(transport.send({ chat_id: config.chat_id, thread_id: '51' }, 'test'), error => safeError(error, /^Telegram /));
    assert.equal(calls.filter(call => call.method === 'sendMessage').length, 1);
  }
});

test('Telegram configuration is captured after verification', async t => {
  const { fetch } = await fixture(t);
  const mutable = { ...config };
  const transport = await createTelegramTransport(mutable, { fetch });
  t.after(() => transport.stop());
  mutable.chat_id = '-100999'; mutable.user_id = '999'; mutable.bot_token = '123:changed';
  assert.equal((await transport.openThread('Session')).chat_id, config.chat_id);
});
