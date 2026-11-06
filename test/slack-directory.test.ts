import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { SlackConfig } from '../src/chat-transport.js';
import { slackDirectory } from '../src/slack.js';

const config: SlackConfig = { bot_token: 'xoxb-fixture-secret', app_token: '', channel_id: 'CROOM', user_id: '' };
const json = (value: unknown) => new Response(JSON.stringify(value));
const auth = { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'TTEAM' };
const channel = (id: string, extra = {}) => ({ id, name: id.toLowerCase(), is_member: true, is_channel: true, ...extra });
const user = (id: string, extra = {}) => ({ id, name: id.toLowerCase(), is_bot: false, ...extra });
interface Call { method: string; url: URL; init: RequestInit }
function fixture(t: TestContext, respond: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call = { method: url.pathname.split('/').at(-1)!, url, init };
    calls.push(call);
    const response = respond(call);
    if (response) return response;
    if (call.method === 'auth.test') return json(auth);
    if (call.method === 'conversations.list') return json({ ok: true, channels: [] });
    if (call.method === 'conversations.members') return json({ ok: true, members: [] });
    if (call.method === 'users.info') return json({ ok: true, user: user(url.searchParams.get('user')!) });
    throw new Error('Unexpected request');
  });
  return calls;
}

test('Slack directory paginates member channels and room humans using only the bot token', async t => {
  const calls = fixture(t, ({ method, url }) => {
    const cursor = url.searchParams.get('cursor');
    if (method === 'conversations.list') return json(cursor
      ? { ok: true, channels: [channel('GPRIVATE', { is_channel: false, is_group: true }), channel('CPUBLIC')] }
      : { ok: true, channels: [channel('CPUBLIC'), channel('CARCHIVE', { is_archived: true }), channel('COTHER', { is_member: false }), channel('CDM', { is_im: true }), channel('CGROUPDM', { is_mpim: true })], response_metadata: { next_cursor: 'channels-next' } });
    if (method === 'conversations.members') return json(cursor
      ? { ok: true, members: ['UACTIVE', 'UBOTUSER', 'UAPP', 'UDELETED', 'UOTHERTEAM', 'UUNKNOWN', 'UACTIVE'] }
      : { ok: true, members: [], response_metadata: { next_cursor: 'members-next' } });
    if (method === 'users.info') {
      const id = url.searchParams.get('user')!;
      const extra = id === 'UACTIVE' ? { profile: { display_name: 'Alice', email: config.bot_token } }
        : id === 'UBOTUSER' ? { is_bot: true } : id === 'UAPP' ? { is_app_user: true }
        : id === 'UDELETED' ? { deleted: true } : id === 'UOTHERTEAM' ? { team_id: 'TOTHER' } : { is_bot: undefined };
      return json({ ok: true, user: user(id, extra) });
    }
    return;
  });
  const result = await slackDirectory(config);
  assert.deepEqual(result, { chats: [{ id: 'CPUBLIC', name: 'cpublic' }, { id: 'GPRIVATE', name: 'gprivate' }], users: [{ id: 'UACTIVE', name: 'Alice' }], limited: false });
  assert.equal(calls.filter(call => call.method === 'users.info').length, 6);
  for (const { method, url, init } of calls) {
    assert.equal(url.origin, 'https://slack.com');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${config.bot_token}`);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    assert.ok(!url.href.includes(config.bot_token));
    if (method !== 'auth.test') assert.equal(init.method, 'GET');
    if (method === 'conversations.list') {
      assert.equal(url.searchParams.get('exclude_archived'), 'true');
      assert.equal(url.searchParams.get('types'), 'public_channel,private_channel');
    }
    if (method === 'conversations.members') assert.equal(url.searchParams.get('channel'), 'CROOM');
    assert.ok(!url.searchParams.has('include_locale'));
  }
});

test('Slack directory allows initial setup without room, app token or authorized user', async t => {
  const calls = fixture(t, ({ method }) => method === 'conversations.list' ? json({ ok: true, channels: [channel('CROOM')] }) : undefined);
  assert.deepEqual(await slackDirectory({ ...config, channel_id: '' }), { chats: [{ id: 'CROOM', name: 'croom' }], users: [], limited: true });
  assert.deepEqual(calls.map(call => call.method), ['auth.test', 'conversations.list']);
});

test('Slack directory validates local token syntax and authenticated bot identity', async t => {
  const calls = fixture(t, () => undefined);
  for (const change of [{ bot_token: '' }, { bot_token: 'xoxp-secret' }, { channel_id: 'DROOM' }, { bot_token: `xoxb-${'a'.repeat(513)}` }]) {
    await assert.rejects(slackDirectory({ ...config, ...change }), /valid bot token/);
  }
  assert.equal(calls.length, 0);
  t.mock.restoreAll();
  fixture(t, ({ method }) => method === 'auth.test' ? json({ ...auth, bot_id: undefined }) : undefined);
  await assert.rejects(slackDirectory(config), /verify a bot/);
});

test('optional missing permissions and inaccessible members are explicit partial results', async t => {
  for (const method of ['conversations.list', 'conversations.members', 'users.info']) await t.test(method, async sub => {
    fixture(sub, call => {
      if (call.method === method) return json({ ok: false, error: 'missing_scope', needed: config.bot_token });
      if (call.method === 'conversations.list') return json({ ok: true, channels: [channel('CROOM')] });
      if (call.method === 'conversations.members') return json({ ok: true, members: ['UONE'] });
      return;
    });
    const result = await slackDirectory(config);
    assert.equal(result.limited, true);
    assert.equal(result.chats.length, method === 'conversations.list' ? 0 : 1);
    assert.ok(!JSON.stringify(result).includes(config.bot_token));
  });
  await t.test('room inaccessible', async sub => {
    fixture(sub, ({ method }) => method === 'conversations.members' ? json({ ok: false, error: 'not_in_channel' }) : undefined);
    assert.equal((await slackDirectory(config)).limited, true);
  });
});

test('provider errors, revoked tokens and rate limits are sanitized, never silently partial', async t => {
  for (const kind of ['network', 'json', 'api', 'revoked', 'scope-auth', 'rate']) await t.test(kind, async sub => {
    fixture(sub, ({ method }) => {
      if (method !== (kind === 'scope-auth' ? 'auth.test' : 'conversations.list')) return;
      if (kind === 'network') throw new Error(`secret ${config.bot_token}`);
      if (kind === 'json') { const response = json({}); response.json = async () => { throw new Error(config.bot_token); }; return response; }
      if (kind === 'rate') return new Response(config.bot_token, { status: 429 });
      return json({ ok: false, error: kind === 'revoked' ? 'token_revoked' : kind === 'scope-auth' ? 'missing_scope' : config.bot_token });
    });
    await assert.rejects(slackDirectory(config), error => {
      assert.ok(!String(error).includes(config.bot_token));
      assert.equal((error as Error & { cause?: unknown }).cause, undefined);
      assert.match(String(error), kind === 'rate' ? /rate limit/ : kind === 'revoked' ? /invalid or expired/ : kind === 'scope-auth' ? /permissions/ : /request failed/);
      return true;
    });
  });
});

test('directory labels redact tokens even when app credentials are blank', async t => {
  fixture(t, ({ method }) => method === 'conversations.list' ? json({ ok: true, channels: [channel('CROOM', { name: config.bot_token })] })
    : method === 'conversations.members' ? json({ ok: true, members: ['UBOT', 'UONE'] })
      : method === 'users.info' ? json({ ok: true, user: user('UONE', { name: 'owner', real_name: config.bot_token, profile: { display_name: 'xapp-private' } }) }) : undefined);
  assert.deepEqual(await slackDirectory(config), { chats: [{ id: 'CROOM', name: 'CROOM' }], users: [{ id: 'UONE', name: 'owner' }], limited: false });
});

test('pagination and user lookups have fixed bounds and report truncation', async t => {
  let page = 0;
  const calls = fixture(t, ({ method }) => method === 'conversations.list'
    ? json({ ok: true, channels: [], response_metadata: { next_cursor: `page-${++page}` } })
    : method === 'conversations.members' ? json({ ok: true, members: Array.from({ length: 100 }, (_, i) => `U${i}`) }) : undefined);
  const result = await slackDirectory(config);
  assert.equal(result.limited, true);
  assert.equal(calls.filter(call => call.method === 'conversations.list').length, 5);
  assert.equal(calls.filter(call => call.method === 'users.info').length, 40);
  assert.equal(result.users.length, 40);
});

test('repeated cursors stop promptly, malformed pagination fails safely', async t => {
  const calls = fixture(t, ({ method }) => method === 'conversations.list' ? json({ ok: true, channels: [], response_metadata: { next_cursor: 'same' } }) : undefined);
  assert.equal((await slackDirectory(config)).limited, true);
  assert.equal(calls.filter(call => call.method === 'conversations.list').length, 2);
  t.mock.restoreAll();
  fixture(t, ({ method }) => method === 'conversations.list' ? json({ ok: true, channels: [], response_metadata: { next_cursor: { secret: config.bot_token } } }) : undefined);
  await assert.rejects(slackDirectory(config), /invalid directory pagination/);
});

test('directory enforces request timeouts and an overall deadline while aborting IO', async t => {
  for (const phase of ['fetch', 'json', 'overall']) await t.test(phase, async sub => {
    sub.mock.timers.enable({ apis: ['setTimeout'] });
    let release!: (response: Response) => void;
    const calls = fixture(sub, ({ method }) => {
      if (phase === 'overall' && (method === 'auth.test' || method === 'conversations.list')) return new Promise<Response>(resolve => { release = resolve; });
      if (phase === 'json') { const response = json({}); response.json = () => new Promise(() => {}); return response; }
      return new Promise<Response>(() => {});
    });
    const rejected = assert.rejects(slackDirectory(config), phase === 'overall' ? /operation cancelled/ : /request timed out/);
    await nextTurn();
    if (phase === 'overall') {
      sub.mock.timers.tick(14_000); release(json(auth)); await nextTurn();
      sub.mock.timers.tick(14_000); release(json({ ok: true, channels: [] })); await nextTurn();
      sub.mock.timers.tick(2_000);
    }
    else sub.mock.timers.tick(15_000);
    await rejected;
    assert.ok(calls.at(-1)!.init.signal?.aborted);
  });
});
