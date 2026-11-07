import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { assertMode } from './platform-fixtures.js';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { EventLog } from '../src/events.js';
import { GitHubAuth } from '../src/github-auth.js';
import { LARK_REGISTRATION_URL, LarkRegistration, inspectLarkSetup, type LarkRegistrationOptions, type LarkSetup } from '../src/lark-registration.js';
import type { Credentials, LarkApi } from '../src/lark-metadata.js';
import { createServiceHost, type HostOptions } from '../src/server.js';
import { SettingsService, type LarkControl } from '../src/settings.js';
import { State } from '../src/state.js';
import { StateDatabase, type StateRows } from '../src/state-database.js';
import { LarkService } from '../src/lark.js';
import { SessionsService } from '../src/sessions.js';
import type { TailnetAccess } from '../src/tailnet.js';

const appId = 'cli_0123456789abcdef';
const complete = { client_id: appId, client_secret: 'private-app-secret', user_info: { open_id: 'ou_scanningUser', tenant_brand: 'feishu' } };
const ready: LarkSetup = { app_id: appId, status: 'ready', missing: [], mention_only: false };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
async function until<T>(read: () => T | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 1000; attempt++) { const value = read(); if (value) return value; await tick(); }
  throw new Error('Timed out waiting for registration');
}
function provider() {
  const calls: { url: string; fields: URLSearchParams }[] = [];
  const replies: (() => unknown | Promise<unknown>)[] = [];
  let device: Record<string, unknown> = { device_code: 'private-device-code', user_code: 'ABCD-1234', expire_in: 600, interval: 1 };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const fields = new URLSearchParams(String(init?.body)); calls.push({ url: String(input), fields });
    assert.equal(String(input), LARK_REGISTRATION_URL);
    assert.equal(init?.redirect, 'error');
    if (fields.get('action') === 'begin') return Response.json(device);
    return Response.json(await (replies.shift()?.() ?? { error: 'authorization_pending' }));
  };
  const options: LarkRegistrationOptions = { fetch, wait: async (_milliseconds, signal) => { await tick(); signal.throwIfAborted(); } };
  return { calls, replies, options, setDevice: (value: Record<string, unknown>) => { device = value; } };
}

test('registration starts only explicitly, joins duplicate starts and exposes only a local QR', async t => {
  const remote = provider(); const accepted: unknown[] = []; const reports: unknown[] = [];
  const flow = new LarkRegistration(async result => { accepted.push(result); return ready; }, record => reports.push(record), remote.options);
  t.after(() => flow.stop());
  assert.deepEqual(flow.page(), { status: 'idle' }); assert.equal(remote.calls.length, 0);
  assert.equal(flow.start().status, 'starting'); assert.equal(flow.start().status, 'starting');
  const waiting = await until(() => flow.page().status === 'waiting' && flow.page());
  assert.equal(waiting.url, 'https://open.feishu.cn/page/cli?user_code=ABCD-1234');
  assert.match(waiting.qr!, /^data:image\/png;base64,/);
  assert.equal(remote.calls.filter(call => call.fields.get('action') === 'begin').length, 1);
  assert.deepEqual(Object.fromEntries(remote.calls[0]!.fields), { action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id tenant_brand' });
  remote.replies.push(() => complete);
  const done = await until(() => flow.page().status === 'complete' && flow.page());
  assert.deepEqual(accepted, [{ credentials: { appId, appSecret: complete.client_secret }, recipient: complete.user_info.open_id }]);
  assert.deepEqual(done, { status: 'complete', app_id: appId, setup: ready });
  assert.ok(!JSON.stringify([done, waiting, reports]).includes('private-'));
});

test('cancellation prevents a late successful poll from replacing the active app', async t => {
  const remote = provider(); let release!: (value: unknown) => void; let accepted = 0;
  remote.replies.push(() => new Promise(resolve => { release = resolve; }));
  const flow = new LarkRegistration(async () => { accepted++; return ready; }, () => {}, remote.options);
  t.after(() => flow.stop()); flow.start(); await until(() => typeof release === 'function');
  assert.deepEqual(flow.cancel(), { status: 'idle' });
  release(complete); await tick(); await tick();
  assert.equal(accepted, 0); assert.deepEqual(flow.page(), { status: 'idle' });
  remote.replies.push(() => complete); flow.start();
  await until(() => flow.page().status === 'complete'); assert.equal(accepted, 1);
});

test('pending replies, incomplete replies, network failure and slow_down retain one registration', async t => {
  const remote = provider(); const waits: number[] = [];
  remote.replies.push(() => ({ error: 'slow_down' }), () => ({}), () => { throw new TypeError('private network diagnostic'); }, () => complete);
  const flow = new LarkRegistration(async () => ready, () => {}, { ...remote.options, wait: async (milliseconds, signal) => { waits.push(milliseconds); signal.throwIfAborted(); } });
  t.after(() => flow.stop()); flow.start(); await until(() => flow.page().status === 'complete');
  assert.deepEqual(waits, [6000, 6000, 7000]);
  assert.equal(remote.calls.filter(call => call.fields.get('action') === 'begin').length, 1);
});

test('refusal, expiry, malformed credentials and unsupported tenant brands fail without saving', async t => {
  for (const [reply, expected] of [
    [{ error: 'access_denied' }, 'access_denied'], [{ error: 'expired_token' }, 'expired_token'], [{ error: 'invalid_grant' }, 'expired_token'],
    [{ ...complete, client_id: 'not-an-app' }, 'invalid_credentials'],
    [{ ...complete, user_info: { tenant_brand: 'lark' } }, 'unsupported_brand'],
    [{ error: 'private-error-with-credentials' }, 'registration_unavailable'],
  ] as const) {
    const remote = provider(); let saves = 0; remote.replies.push(() => reply);
    const flow = new LarkRegistration(async () => { saves++; return ready; }, () => {}, remote.options);
    t.after(() => flow.stop()); flow.start();
    const failed = await until(() => flow.page().status === 'failed' && flow.page());
    assert.deepEqual(failed, { status: 'failed', error: expected }); assert.equal(saves, 0);
  }
});

test('the begin expiry bounds polling and provider-supplied links cannot change the QR destination', async t => {
  const remote = provider(); let now = 1000;
  remote.setDevice({ device_code: 'private-device-code', user_code: 'SAFE-1234', expire_in: 1, interval: -1, verification_uri_complete: 'https://untrusted.example/' });
  remote.replies.push(() => { now = 2001; return { error: 'authorization_pending' }; });
  const flow = new LarkRegistration(async () => ready, () => {}, { ...remote.options, now: () => now });
  t.after(() => flow.stop()); flow.start();
  await until(() => flow.page().status === 'failed'); assert.equal(flow.page().error, 'expired_token');
  assert.ok(!JSON.stringify(flow.page()).includes('untrusted.example'));
});

test('saving is a commit: cancellation cannot claim to undo it and private save errors are sanitized', async t => {
  const remote = provider(); let release!: () => void;
  remote.replies.push(() => complete);
  const flow = new LarkRegistration(async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error('private-app-secret'); }, () => {}, remote.options);
  t.after(() => flow.stop()); flow.start(); await until(() => typeof release === 'function');
  assert.equal(flow.page().status, 'connecting'); assert.throws(() => flow.cancel(), /being saved/);
  release(); await until(() => flow.page().status === 'failed');
  assert.deepEqual(flow.page(), { status: 'failed', error: 'save_failed' });
});

const defaultScopes = ['im:chat:create', 'im:chat:read', 'im:chat:update', 'im:message:send_as_bot', 'im:message.group_at_msg:readonly', 'im:message.p2p_msg:readonly'];
function scopeApi(scopes = defaultScopes): LarkApi {
  return { appId, async request<T>(): Promise<T> { return { app: { scopes: scopes.map(scope => ({ scope, token_types: ['tenant'] })) } } as T; } };
}
test('readiness identifies actual messaging gaps without treating a connected bot as a complete setup', async () => {
  const setup = await inspectLarkSetup(scopeApi());
  assert.equal(setup.status, 'permissions-required'); assert.equal(setup.mention_only, true);
  assert.deepEqual(setup.missing, ['im:chat.announcement:read', 'im:chat.announcement:write_only', 'im:message.history:readonly', 'im:message.group_msg']);
  assert.match(setup.permission!.qr, /^data:image\/png;base64,/);
  const url = new URL(setup.permission!.url); assert.equal(url.origin, 'https://open.feishu.cn'); assert.equal(url.pathname, `/app/${appId}/auth`);
  assert.deepEqual(url.searchParams.get('q')?.split(','), setup.missing);
  const all = await inspectLarkSetup(scopeApi([...defaultScopes, ...setup.missing]));
  assert.deepEqual(all, ready);
});
test('chat-list access is required even when all other messaging scopes are present', async () => {
  const primaryScopes = ['im:chat:create', 'im:chat.announcement:read', 'im:chat.announcement:write_only', 'im:message:send_as_bot', 'im:message.history:readonly', 'im:message.group_msg'];
  const missingList = await inspectLarkSetup(scopeApi(primaryScopes));
  assert.equal(missingList.status, 'permissions-required');
  assert.deepEqual(missingList.missing, ['im:chat:read']);
  assert.equal(missingList.mention_only, false);
  assert.equal(new URL(missingList.permission!.url).searchParams.get('q'), 'im:chat:read');
  for (const grant of ['im:chat:read', 'im:chat:readonly', 'im:chat']) {
    assert.deepEqual(await inspectLarkSetup(scopeApi([...primaryScopes, grant])), ready);
  }
});

test('history polling requires a history-read grant even when live messaging scopes are present', async () => {
  const live = [...defaultScopes, 'im:chat.announcement:read', 'im:chat.announcement:write_only', 'im:message.group_msg'];
  const missingHistory = await inspectLarkSetup(scopeApi(live));
  assert.equal(missingHistory.status, 'permissions-required');
  assert.deepEqual(missingHistory.missing, ['im:message.history:readonly']);
  assert.equal(missingHistory.mention_only, false);
  for (const grant of ['im:message.history:readonly', 'im:message:readonly', 'im:message']) {
    assert.deepEqual(await inspectLarkSetup(scopeApi([...live, grant])), ready);
  }
});

test('a failed scope inspection is unknown rather than permission denial, and user scopes do not authorize the bot', async () => {
  const inaccessible: LarkApi = { appId, async request() { throw new Error('private-provider-error'); } };
  const unknown = await inspectLarkSetup(inaccessible); assert.equal(unknown.status, 'unavailable'); assert.deepEqual(unknown.missing, []);
  assert.ok(!JSON.stringify(unknown).includes('private-provider-error'));
  const userOnly: LarkApi = { appId, async request<T>() { return { app: { scopes: [{ scope: 'im:chat', token_types: ['user'] }] } } as T; } };
  assert.ok((await inspectLarkSetup(userOnly)).missing.includes('im:chat:create'));
});

async function settingsHarness(t: TestContext, options: { env?: NodeJS.ProcessEnv } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-lark-registration-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await State.open(directory); const remote = provider(); const reports: unknown[] = [];
  const lark: LarkControl = { status: () => 'ready', channel: () => ({ groups: 0 }),
    async configure(credentials) { lark.credentials = credentials; lark.api = credentials ? scopeApi() : undefined; } };
  const settings = new SettingsService({ state, lark, env: options.env ?? {}, registration: remote.options, report: record => reports.push(record),
    verify: async credentials => { assert.equal(credentials.appSecret, complete.client_secret); }, github: new GitHubAuth(state),
    pulls: { preferences: async () => ({ follow: [] }), restore: async () => {} }, agents: { list: async () => [], set: async () => { throw new Error('not used'); } } });
  t.after(() => settings.stop());
  return { state, remote, settings, lark, directory, reports };
}
test('a version 0.1.13 JSON upgrade preserves personal app type, recipient and group ownership', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-personal-app-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = { lark_app_id: appId, lark_app_secret: complete.client_secret,
    lark_recipient_open_id: complete.user_info.open_id, lark_connection_type: 'personal-app' as const };
  const binding = { chat_id: 'oc_personal', app_id: appId, session_id: 'personal-session', sender_open_id: complete.user_info.open_id };
  const original = JSON.stringify({ version: 1, sessions: [], lark_bindings: [binding], settings });
  await writeFile(join(directory, 'state.json'), original, { mode: 0o600 });
  const migrated = await State.open(directory);
  assert.deepEqual(migrated.settings, settings);
  assert.deepEqual(migrated.bindings.get(binding.chat_id), binding);
  assert.deepEqual((await State.open(directory)).settings, settings);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), original);
});

test('a QR result saves private credentials and the app-specific scanning user, then reconnects', async t => {
  const h = await settingsHarness(t);
  h.lark.credentials = { appId: 'cli_fedcba9876543210', appSecret: 'old-secret' }; h.state.settings.lark_recipient_open_id = 'ou_oldAppUser';
  h.remote.replies.push(() => complete); h.settings.startLarkRegistration();
  await until(() => h.settings.larkRegistration().status === 'complete');
  const persisted = await State.open(h.directory);
  assert.equal(persisted.settings.lark_app_secret, complete.client_secret);
  assert.equal(persisted.settings.lark_recipient_open_id, complete.user_info.open_id);
  assert.equal(persisted.settings.lark_connection_type, 'personal-app');
  assert.equal((await h.settings.page()).lark.connection_type, 'personal-app');
  await assertMode(join(h.directory, 'state.sqlite'), 0o600);
  assert.equal(h.lark.credentials?.appId, appId);
  assert.equal(h.settings.larkRegistration().setup?.status, 'permissions-required');
  const publicData = JSON.stringify([await h.settings.page(), h.settings.larkRegistration(), h.reports]);
  assert.ok(!publicData.includes('private-app-secret')); assert.ok(!publicData.includes('private-device-code'));
});
test('a failed QR save rolls back credentials, recipient and group ownership before queued saves or a retry', async t => {
  const h = await settingsHarness(t);
  const oldAppId = 'cli_fedcba9876543210';
  const credentials = { appId: oldAppId, appSecret: 'old-secret' }; h.lark.credentials = credentials;
  const oldApi: LarkApi = { appId: oldAppId, async request() { throw new Error('Old API must not be used during failed save'); } };
  h.lark.api = oldApi;
  const configure = t.mock.method(h.lark, 'configure');
  const original = { lark_app_id: oldAppId, lark_app_secret: 'old-secret', lark_recipient_open_id: 'ou_original', lark_connection_type: 'bot' as const };
  Object.assign(h.state.settings, original, { github_token: 'initial-token' });
  const binding = { chat_id: 'oc_original', session_id: 'original-session', sender_open_id: 'ou_original' };
  h.state.bindings.set(binding.chat_id, binding); await h.state.save();
  let entered = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const write = StateDatabase.prototype.write; let writes = 0;
  t.mock.method(StateDatabase.prototype, 'write', async function (this: StateDatabase, rows: StateRows) {
    if (this.path === join(h.directory, 'state.sqlite')) {
      const index = ++writes;
      if (index === 1) { entered = true; await gate; }
      if (index === 3) {
        // An unrelated setting and session change while this write is pending must survive its rollback.
        h.state.settings.github_token = 'parallel-token';
        h.state.sessions.set('parallel-session', { session_id: 'parallel-session', host_id: 'test-host', adapter: 'codex', session_name: 'Parallel session' });
        throw new Error('Injected QR write failure');
      }
    }
    return write.call(this, rows);
  });
  const save = h.state.save.bind(h.state); let scheduled = 0;
  t.mock.method(h.state, 'save', (transaction?: Parameters<State['save']>[0]) => { scheduled++; return save(transaction); });
  const first = h.state.save(); await until(() => entered);
  const older = h.state.save();
  h.remote.replies.push(() => complete); h.settings.startLarkRegistration();
  await until(() => scheduled === 3);
  assert.deepEqual(h.state.settings, { ...original, github_token: 'initial-token' }, 'queued QR changes have not been applied early');
  const later = h.state.save(); release(); await Promise.all([first, older, later]);
  await until(() => h.settings.larkRegistration().status === 'failed');
  assert.equal(h.settings.larkRegistration().error, 'save_failed');
  assert.deepEqual(h.state.settings, { ...original, github_token: 'parallel-token' });
  assert.strictEqual(h.lark.credentials, credentials); assert.strictEqual(h.lark.api, oldApi);
  assert.equal(configure.mock.calls.length, 0);
  assert.strictEqual(h.state.bindings.get(binding.chat_id), binding); assert.equal(h.state.bindings.get(binding.chat_id)?.app_id, undefined);
  const reopened = await State.open(h.directory);
  assert.deepEqual(reopened.settings, { ...original, github_token: 'parallel-token' });
  assert.deepEqual(reopened.bindings.get(binding.chat_id), binding); assert.ok(reopened.sessions.has('parallel-session'));
  assert.ok(!JSON.stringify(reopened.settings).includes(complete.client_secret));
  h.remote.replies.push(() => complete); h.settings.startLarkRegistration();
  await until(() => h.settings.larkRegistration().status === 'complete');
  assert.equal(h.lark.credentials?.appId, appId); assert.equal(configure.mock.calls.length, 1);
  assert.equal(h.state.bindings.get(binding.chat_id)?.app_id, oldAppId);
  assert.equal((await State.open(h.directory)).settings.lark_app_secret, complete.client_secret);
});

test('cancel after an unseen completion reports the committed app once without undoing it or creating another', async t => {
  const h = await settingsHarness(t);
  h.lark.credentials = { appId: 'cli_fedcba9876543210', appSecret: 'old-secret' };
  h.state.settings.lark_recipient_open_id = 'ou_oldAppUser';
  const oldPage = await h.settings.page();
  h.settings.startLarkRegistration();
  const displayed = await until(() => h.settings.larkRegistration().status === 'waiting' && h.settings.larkRegistration());
  h.remote.replies.push(() => complete);
  await until(() => h.state.settings.lark_app_id === appId && h.settings.larkRegistration().status === 'complete');
  assert.equal(displayed.status, 'waiting', 'the UI has not observed completion yet');
  assert.notEqual(oldPage.lark.app_id, appId);
  const origin = await serve(t, await EventLog.open(h.directory), { settings: h.settings });
  const response = await fetch(origin + '/ui/api/settings/lark/registration', { method: 'POST', headers: { 'x-nootify-ui': '1' }, body: JSON.stringify({ action: 'cancel' }) });
  assert.equal(response.status, 200);
  const result = await response.json() as { status: string; app_id: string };
  assert.equal(result.status, 'complete'); assert.equal(result.app_id, appId);
  assert.ok(!JSON.stringify(result).includes(complete.client_secret));
  assert.deepEqual(h.settings.larkRegistration(), { status: 'idle' }, 'dismiss the server flow after reporting the saved result');
  assert.deepEqual(h.settings.cancelLarkRegistration(), { status: 'idle' });
  const page = await (await fetch(origin + '/ui/api/settings')).json() as { lark: { app_id: string; recipient: string; connection_type: string } };
  assert.equal(page.lark.app_id, appId); assert.equal(page.lark.recipient, complete.user_info.open_id); assert.equal(page.lark.connection_type, 'personal-app');
  assert.equal((await State.open(h.directory)).settings.lark_app_secret, complete.client_secret);
  assert.equal(h.remote.calls.filter(call => call.fields.get('action') === 'begin').length, 1);
});

test('personal app type survives export/import, while legacy credentials keep the original bot setup', async t => {
  const h = await settingsHarness(t);
  assert.equal((await h.settings.page()).lark.connection_type, 'bot');
  h.remote.replies.push(() => complete); h.settings.startLarkRegistration();
  await until(() => h.settings.larkRegistration().status === 'complete');
  const file = JSON.parse(await readFile((await h.settings.exportConfig()).path, 'utf8'));
  assert.equal(file.lark.connection_type, 'personal-app');
  const target = await settingsHarness(t);
  await target.settings.importConfig(file);
  assert.equal((await target.settings.page()).lark.connection_type, 'personal-app');
  assert.equal((await State.open(target.directory)).settings.lark_connection_type, 'personal-app');
  await target.settings.saveLark(appId, '');
  assert.equal((await target.settings.page()).lark.connection_type, 'personal-app', 'editing a saved secret retains its type');
  await target.settings.saveLark(appId, '', 'bot');
  assert.equal((await target.settings.page()).lark.connection_type, 'bot');
  assert.equal((await State.open(target.directory)).settings.lark_connection_type, 'bot');
  delete file.lark.connection_type;
  await target.settings.importConfig(file);
  assert.equal((await target.settings.page()).lark.connection_type, 'bot', 'older configuration files keep the previous setup');
  await target.settings.clearLark();
  assert.equal(target.state.settings.lark_connection_type, undefined);
});

test('connection types are validated and the settings API saves the explicitly selected type', async t => {
  const h = await settingsHarness(t);
  await assert.rejects(h.settings.saveLark(appId, complete.client_secret, 'user'), /connection type/);
  assert.equal(h.state.settings.lark_app_id, undefined);
  const origin = await serve(t, await EventLog.open(h.directory), { settings: h.settings });
  const response = await fetch(origin + '/ui/api/settings/lark', { method: 'POST', headers: { 'x-nootify-ui': '1' },
    body: JSON.stringify({ app_id: appId, app_secret: complete.client_secret, connection_type: 'personal-app' }) });
  assert.equal(response.status, 200);
  assert.equal((await h.settings.page()).lark.connection_type, 'personal-app');
  const base = { format: 'nootify-config', version: 1, lark: { app_id: appId, app_secret: complete.client_secret } };
  for (const lark of [{ ...base.lark, connection_type: 'user' }, { connection_type: 'personal-app' }]) {
    await assert.rejects(h.settings.importConfig({ ...base, lark }), /connection type/);
  }
  assert.equal(h.state.settings.lark_connection_type, 'personal-app');
});

test('environment configuration prevents a QR flow before any provider request', async t => {
  const h = await settingsHarness(t, { env: { LARK_APP_ID: appId, LARK_APP_SECRET: 'env-secret' } });
  assert.throws(() => h.settings.startLarkRegistration(), /take precedence/); assert.equal(h.remote.calls.length, 0);
});
test('manual credential changes cancel pending registration before it can overwrite them', async t => {
  const h = await settingsHarness(t); h.settings.startLarkRegistration();
  await until(() => h.settings.larkRegistration().status === 'waiting');
  await h.settings.saveLark(appId, complete.client_secret);
  h.remote.replies.push(() => complete); await tick();
  assert.deepEqual(h.settings.larkRegistration(), { status: 'idle' }); assert.equal(h.state.settings.lark_recipient_open_id, undefined);
});
async function serve(t: TestContext, logs: EventLog, options: HostOptions): Promise<string> {
  const server = createServiceHost([], 'test-token', logs, options); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); }); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
test('QR URLs, status and permission actions remain loopback-only behind the UI request header', async t => {
  const h = await settingsHarness(t); const logs = await EventLog.open(h.directory);
  const local = await serve(t, logs, { settings: h.settings });
  const remote = await serve(t, logs, { settings: h.settings, via: 'tailnet', tailnet: { authorize: async () => undefined, url: () => undefined } as unknown as TailnetAccess });
  const send = (origin: string, path: string, action: string, headers = { 'x-nootify-ui': '1' }) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify({ action }) });
  const registration = '/ui/api/settings/lark/registration';
  for (const action of ['start', 'status', 'cancel']) {
    assert.equal((await send(remote, registration, action)).status, 403);
    assert.equal((await send(local, registration, action, {} as { 'x-nootify-ui': string })).status, 403);
  }
  assert.equal((await send(remote, '/ui/api/settings/lark/permissions', 'check')).status, 403);
  assert.equal(h.remote.calls.length, 0);
  assert.equal((await send(local, registration, 'start')).status, 200);
  await until(() => h.settings.larkRegistration().status === 'waiting');
  const status = await send(local, registration, 'status'); assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await status.json() as { status: string }).status, 'waiting');
  const publicPage = await (await fetch(remote + '/ui/api/settings')).text();
  assert.ok(!publicPage.includes('ABCD-1234')); assert.ok(!publicPage.includes('data:image/png'));
  assert.equal((await send(local, registration, 'cancel')).status, 200);
});

test('replacing a running app retains and persists the original app ownership of legacy bindings', async t => {
  const h = await settingsHarness(t); const sessions = new SessionsService(h.state);
  const lark = new LarkService(h.state, sessions, { appId, appSecret: 'original-secret' }, () => {}, scopeApi(), 9417,
    options => ({ start: async () => { options.status('ready'); }, stop: async () => {} }));
  t.after(async () => { await lark.stop(); await sessions.stop(); });
  h.state.bindings.set('oc_legacy', { chat_id: 'oc_legacy', session_id: 'old-session', sender_open_id: 'ou_oldAppUser' });
  const otherId = 'cli_fedcba9876543210';
  await lark.configure({ appId: otherId, appSecret: 'replacement-secret' });
  assert.equal(h.state.bindings.get('oc_legacy')?.app_id, appId);
  assert.equal((await State.open(h.directory)).bindings.get('oc_legacy')?.app_id, appId);
  assert.equal(lark.channel().groups, 0);
  assert.equal(lark.threads?.binding('old-session'), undefined);
  assert.equal(lark.threads?.recipient(), undefined);
});
