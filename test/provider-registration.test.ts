import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CoreError, type CoreTransport } from '../src/provider-core.js';
import { ProvidersService, type ProviderRegistrationPage, type ProvidersOptions } from '../src/providers.js';
import { SessionsService } from '../src/sessions.js';
import { State, type Settings } from '../src/state.js';
import { HttpError } from '../src/types.js';
import type { Credentials } from '../src/lark-metadata.js';
import { inspectLarkSetup, type LarkSetup } from '../src/lark-registration.js';

const appId = 'cli_0123456789abcdef';
const oldAppId = 'cli_fedcba9876543210';
const secret = 'private-registration-secret';
const success = { client_id: appId, client_secret: secret, user_info: { open_id: 'ou_scanner', tenant_brand: 'feishu' } };
const ready = (app_id = appId): LarkSetup => ({ app_id, status: 'ready', missing: [], mention_only: false });
const bot = { id: 'legacy-feishu', type: 'feishu', connection_type: 'bot', name: 'Existing bot', enabled: true,
  app_id: oldAppId, app_secret: 'private-existing-secret', recipient_open_id: 'ou_existing' };
const personal = { ...bot, id: 'personal-one', name: 'Personal one', connection_type: 'personal-app', app_id: appId };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
function gate<T = void>() {
  let release!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 2000; i++) { if (await predicate()) return; await tick(); }
  throw new Error('Registration did not reach the expected state');
}
class RegistrationCore implements CoreTransport {
  configs = new Map<string, Record<string, unknown>>();
  calls: { method: string; params: Record<string, unknown> }[] = [];
  defaultId?: string;
  stopped = false;
  async start() {}
  async stop() { this.stopped = true; }
  seed(config: Record<string, unknown>) { this.configs.set(String(config.id), structuredClone(config)); this.defaultId ??= String(config.id); }
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    assert.equal(this.stopped, false, 'requests must finish before core shutdown');
    this.calls.push({ method, params: structuredClone(params) });
    if (method === 'provider.save') {
      const previous = this.configs.get(String(params.id));
      if (previous && previous.app_id !== params.app_id) throw new CoreError('conflict', 'App ID is immutable');
      this.seed({ ...params, ...(params.connection_type === undefined && previous?.connection_type ? { connection_type: previous.connection_type } : {}),
        app_secret: params.app_secret || previous?.app_secret });
    } else if (method === 'provider.delete') this.configs.delete(String(params.id));
    else if (method === 'provider.default') this.defaultId = String(params.id);
    else if (method === 'migration.import') {
      const previous = this.configs.get('legacy-feishu');
      if (!previous) this.seed({ id: 'legacy-feishu', type: 'feishu', name: 'Migrated', enabled: true, app_id: params.app_id,
        app_secret: params.app_secret, recipient_open_id: params.recipient_open_id,
        ...(params.connection_type ? { connection_type: params.connection_type } : {}) });
      else if (params.connection_type && previous.app_id === params.app_id && !previous.connection_type) previous.connection_type = params.connection_type;
    } else if (method === 'config.export') return structuredClone({ providers: [...this.configs.values()], default_provider_id: this.defaultId }) as T;
    if (method === 'status') return { node_id: 'local', default_provider_id: this.defaultId, providers: [...this.configs.values()].map(config => {
      const { app_secret, token, ...safe } = config; return { ...safe, status: 'connected', secret_set: Boolean(app_secret), token_set: Boolean(token) };
    }), remote: { enabled: false, listen: '127.0.0.1:9418', status: 'disabled', tls: false, token_set: false, peers: [] } } as T;
    return (method === 'session.list' ? [] : {}) as T;
  }
}
async function fixture(t: TestContext, options: { providers?: Record<string, unknown>[]; saved?: Settings; credentials?: Credentials; dependencies?: ProvidersOptions } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-provider-registration-'));
  const state = await State.open(directory); Object.assign(state.settings, options.saved); await state.save();
  const core = new RegistrationCore(); for (const provider of options.providers ?? []) core.seed(provider);
  const replies: (() => unknown | Promise<unknown>)[] = [];
  const requests: string[] = []; const verified: Credentials[] = []; const inspected: string[] = []; const reports: Record<string, unknown>[] = [];
  const providers = new ProvidersService(state, new SessionsService(state), options.credentials, record => reports.push(record), 9417, undefined, core, undefined, {
    registration: { fetch: async (_url, init) => {
      const action = new URLSearchParams(String(init?.body)).get('action')!; requests.push(action);
      if (action === 'begin') return Response.json({ device_code: 'private-device-code', user_code: 'ABCD-1234', expire_in: 600, interval: 1 });
      return Response.json(await (replies.shift()?.() ?? { error: 'authorization_pending' }));
    }, wait: async (_milliseconds, signal) => { await tick(); signal.throwIfAborted(); } },
    verify: async credentials => { verified.push(credentials); },
    setup: async api => { inspected.push(api.appId); return ready(api.appId); }, ...options.dependencies,
  });
  await providers.start();
  t.after(async () => { await providers.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, state, core, providers, replies, requests, verified, inspected, reports };
}
const start = (providers: ProvidersService, extra: Record<string, unknown> = {}) => providers.registration({ action: 'start', name: 'New personal app', enabled: true, ...extra });
const status = (providers: ProvidersService, registration: ProviderRegistrationPage) => providers.registration({ action: 'status', registration_id: registration.registration_id });
async function outcome(providers: ProvidersService, registration: ProviderRegistrationPage, expected = 'complete') {
  let page: ProviderRegistrationPage | undefined;
  await until(async () => { page = await status(providers, registration); return page.status === expected; });
  return page!;
}
const isStatus = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;

test('new personal registration preserves the existing/default channel and exposes no credentials', async t => {
  const saved = { lark_app_id: bot.app_id, lark_app_secret: bot.app_secret, lark_recipient_open_id: bot.recipient_open_id, lark_connection_type: 'bot' as const };
  const h = await fixture(t, { providers: [bot], saved });
  const before = structuredClone(h.core.configs.get(bot.id));
  const flow = await start(h.providers, { name: '  Personal notifications  ', enabled: false });
  assert.equal(flow.status, 'starting'); assert.ok(flow.registration_id);
  const waiting = await outcome(h.providers, flow, 'waiting'); assert.match(waiting.qr!, /^data:image\/png;base64,/);
  await assert.rejects(start(h.providers, { id: personal.id }), isStatus(409));
  await assert.rejects(h.providers.registration({ action: 'status' }), isStatus(400));
  for (const action of ['status', 'cancel']) await assert.rejects(h.providers.registration({ action, registration_id: 'other-tab' }), isStatus(409));
  assert.equal(h.requests.filter(action => action === 'begin').length, 1);
  h.replies.push(() => success);
  const done = await outcome(h.providers, flow);
  assert.ok(done.provider_id); assert.notEqual(done.provider_id, bot.id);
  assert.deepEqual(h.core.configs.get(done.provider_id!), { id: done.provider_id, type: 'feishu', connection_type: 'personal-app',
    name: 'Personal notifications', enabled: false, app_id: appId, app_secret: secret, recipient_open_id: 'ou_scanner' });
  assert.deepEqual(h.core.configs.get(bot.id), before); assert.equal(h.core.defaultId, bot.id);
  assert.deepEqual(h.state.settings, saved); assert.deepEqual((await State.open(h.directory)).settings, saved);
  assert.deepEqual(h.verified, [{ appId, appSecret: secret }]); assert.deepEqual(h.inspected, [appId]);
  await until(() => h.reports.some(report => report.status === 'lark_registration_complete'));
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await status(h.providers, flow), done);
    assert.deepEqual(await h.providers.registration({ action: 'cancel', registration_id: flow.registration_id }), done);
  }
  assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, 1);
  assert.equal(h.core.calls.filter(call => call.method === 'provider.default').length, 0);
  const publicData = JSON.stringify([flow, waiting, done, await h.providers.page(), h.reports]);
  for (const privateValue of [secret, bot.app_secret, 'private-device-code', 'client_secret', 'device_code']) assert.ok(!publicData.includes(privateValue));
});

test('local recovery resumes and cancels an orphaned scan without its lost registration ID', async t => {
  const h = await fixture(t, { providers: [bot] });
  assert.deepEqual(await h.providers.registration({ action: 'recover' }), { status: 'idle' });
  // Discard the start response, as a closed/reloaded tab or failed response would.
  await start(h.providers, { name: 'Original draft', enabled: false });
  let recovered!: ProviderRegistrationPage;
  await until(async () => { recovered = await h.providers.registration({ action: 'recover' }); return recovered.status === 'waiting'; });
  assert.ok(recovered.registration_id); assert.match(recovered.qr!, /^data:image\/png;base64,/);
  assert.deepEqual(recovered.recovery, { name: 'Original draft', enabled: false });
  await assert.rejects(start(h.providers, { name: 'Do not replace original' }), isStatus(409));
  const same = await h.providers.registration({ action: 'recover' });
  assert.equal(same.registration_id, recovered.registration_id); assert.deepEqual(same.recovery, recovered.recovery);
  assert.equal(h.requests.filter(action => action === 'begin').length, 1);
  for (const value of [secret, bot.app_secret, 'private-device-code', 'client_secret', 'device_code']) assert.ok(!JSON.stringify(recovered).includes(value));
  assert.equal((await h.providers.registration({ action: 'cancel', registration_id: recovered.registration_id })).status, 'idle');
  assert.deepEqual(await h.providers.registration({ action: 'recover' }), { status: 'idle' });
  const next = await start(h.providers); assert.notEqual(next.registration_id, recovered.registration_id);
  assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, 0);
  assert.equal(h.core.defaultId, bot.id);
});

test('recovery observes a saving or committed reauthorization without replaying it', async t => {
  const saving = gate(); let verifying = false;
  t.after(() => saving.release());
  const h = await fixture(t, { providers: [bot, personal], dependencies: { verify: async () => { verifying = true; await saving.promise; } } });
  h.replies.push(() => success);
  await start(h.providers, { id: personal.id, name: 'Reconnect personal', enabled: false });
  await until(() => verifying);
  const recovering = await h.providers.registration({ action: 'recover' });
  assert.equal(recovering.status, 'connecting');
  assert.deepEqual(recovering.recovery, { id: personal.id, name: 'Reconnect personal', enabled: false });
  await assert.rejects(h.providers.registration({ action: 'cancel', registration_id: recovering.registration_id }), isStatus(409));
  saving.release();
  let completed!: ProviderRegistrationPage;
  await until(async () => { completed = await h.providers.registration({ action: 'recover' }); return completed.status === 'complete'; });
  assert.equal(completed.registration_id, recovering.registration_id); assert.equal(completed.provider_id, personal.id);
  assert.equal((await h.providers.registration({ action: 'cancel', registration_id: completed.registration_id })).status, 'complete');
  assert.deepEqual(await h.providers.registration({ action: 'recover' }), completed);
  assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, 1);
  assert.equal(h.core.configs.get(personal.id)!.app_secret, secret); assert.equal(h.core.defaultId, bot.id);
});

for (const subtype of [undefined, 'bot', 'personal-app']) test(`recipient-only save preserves stored subtype ${subtype ?? '(missing)'}`, async t => {
  const legacy: Record<string, unknown> = { ...bot };
  if (subtype) legacy.connection_type = subtype; else delete legacy.connection_type;
  const h = await fixture(t, { providers: [legacy] });
  const request = h.core.request.bind(h.core);
  t.mock.method(h.core, 'request', async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const result = await request<T>(method, params);
    if (method === 'status') for (const provider of (result as { providers: Record<string, unknown>[] }).providers) {
      if (provider.type === 'feishu') provider.connection_type ??= 'bot';
    }
    return result;
  });
  await h.providers.setRecipient('ou_updated');
  const saved = h.core.calls.filter(call => call.method === 'provider.save').at(-1)!;
  assert.equal(Object.hasOwn(saved.params, 'connection_type'), false, 'A presentation default must not become stored metadata');
  assert.equal(h.core.configs.get(bot.id)!.connection_type, subtype);
  assert.equal(h.core.configs.get(bot.id)!.recipient_open_id, 'ou_updated');
  assert.equal(h.core.configs.get(bot.id)!.app_secret, bot.app_secret);
});

test('cancel is scoped and a late scan cannot save or retarget a new registration', async t => {
  const h = await fixture(t, { providers: [bot] }); const poll = gate<unknown>(); let polling = false;
  h.replies.push(() => { polling = true; return poll.promise; });
  const flow = await start(h.providers); await until(() => polling);
  const cancel = () => h.providers.registration({ action: 'cancel', registration_id: flow.registration_id });
  assert.equal((await cancel()).status, 'idle'); assert.equal((await cancel()).status, 'idle');
  assert.equal((await status(h.providers, flow)).status, 'idle');
  const next = await start(h.providers, { name: 'Different channel' }); assert.notEqual(next.registration_id, flow.registration_id);
  await assert.rejects(cancel(), isStatus(409)); poll.release(success);
  await tick(); await tick(); assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, 0);
  h.replies.push(() => success); const done = await outcome(h.providers, next);
  assert.equal(h.core.configs.get(done.provider_id!)?.name, 'Different channel');
});

for (const [reply, error] of [
  [{ error: 'access_denied' }, 'access_denied'], [{ error: 'expired_token' }, 'expired_token'],
  [{ ...success, client_id: 'malformed' }, 'invalid_credentials'], [{ ...success, user_info: {} }, 'missing_recipient'],
  [{ ...success, user_info: { open_id: 'not-open-id' } }, 'missing_recipient'],
] as const) test(`registration ${error} never commits a provider or leaks credentials`, async t => {
  const h = await fixture(t, { providers: [bot] }); h.replies.push(() => reply);
  const flow = await start(h.providers); const failed = await outcome(h.providers, flow, 'failed');
  assert.equal(failed.error, error); assert.equal(failed.provider_id, undefined);
  assert.deepEqual(await status(h.providers, flow), failed);
  assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, 0);
  assert.ok(!JSON.stringify([failed, h.reports]).includes('private-'));
});

test('verification failures are sanitized and permission inspection failure does not undo a successful save', async t => {
  const rejected = await fixture(t, { dependencies: { verify: async () => { throw new Error(secret); } } });
  rejected.replies.push(() => success); const failed = await outcome(rejected.providers, await start(rejected.providers), 'failed');
  assert.equal(failed.error, 'save_failed'); assert.ok(!JSON.stringify([failed, rejected.reports]).includes(secret));
  assert.equal(rejected.core.configs.size, 0);
  const h = await fixture(t, { dependencies: { setup: async () => { throw new Error(secret); } } });
  h.replies.push(() => success); const done = await outcome(h.providers, await start(h.providers));
  assert.equal(done.setup?.status, 'unavailable'); assert.equal(h.core.configs.get(done.provider_id!)?.app_secret, secret);
});

test('reauthorization only accepts an explicitly selected personal app with the same App ID', async t => {
  const h = await fixture(t, { providers: [bot, personal, { id: 'remote', type: 'remote', name: 'Remote', enabled: true, address: 'host:9418', token: 'private-token' }] });
  for (const id of ['missing', bot.id, 'remote']) await assert.rejects(start(h.providers, { id }), isStatus(409));
  assert.equal(h.requests.length, 0);
  const before = structuredClone(h.core.configs);
  h.replies.push(() => ({ ...success, client_id: oldAppId }));
  const wrong = await outcome(h.providers, await start(h.providers, { id: personal.id }), 'failed');
  assert.equal(wrong.error, 'app_mismatch'); assert.deepEqual(h.core.configs, before); assert.equal(h.verified.length, 0);
  h.replies.push(() => success); const done = await outcome(h.providers, await start(h.providers, { id: personal.id, name: 'Reauthorized', enabled: false }));
  assert.equal(done.provider_id, personal.id); assert.equal(h.core.configs.size, before.size);
  assert.equal(h.core.configs.get(personal.id)?.name, 'Reauthorized'); assert.equal(h.core.configs.get(personal.id)?.enabled, false);
  assert.equal(h.core.configs.get(personal.id)?.app_secret, secret); assert.deepEqual(h.core.configs.get(bot.id), before.get(bot.id));
  assert.equal(h.core.defaultId, bot.id);
});

for (const change of ['delete', 'edit', 'subtype'] as const) test(`a target ${change} during verification cannot be overwritten by a stale scan`, async t => {
  const verification = gate(); let verifying = false; t.after(() => verification.release());
  const h = await fixture(t, { providers: [bot, personal], dependencies: { verify: async () => { verifying = true; await verification.promise; } } });
  h.replies.push(() => success); const flow = await start(h.providers, { id: personal.id }); await until(() => verifying);
  if (change === 'delete') await h.providers.action({ action: 'delete', id: personal.id });
  else await h.providers.action({ action: 'save', provider: { ...personal, ...(change === 'edit' ? { name: 'Concurrent edit' } : { connection_type: 'bot' }) } });
  const expected = structuredClone(h.core.configs); const mutations = h.core.calls.filter(call => call.method === 'provider.save').length;
  verification.release(); const failed = await outcome(h.providers, flow, 'failed'); assert.equal(failed.error, 'target_changed');
  assert.deepEqual(h.core.configs, expected); assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, mutations);
});

for (const error of ['committed_not_durable', 'unconfirmed', 'conflict', 'status-loss'] as const) test(`registration preserves the ${error} save outcome without resubmission`, async t => {
  const h = await fixture(t, { providers: [bot] }); const request = h.core.request.bind(h.core); let saved = false;
  t.mock.method(h.core, 'request', async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'status' && saved && error === 'status-loss') throw new CoreError('unavailable', secret);
    if (method !== 'provider.save') return request<T>(method, params);
    if (error === 'conflict') throw new CoreError(error, secret);
    const result = await request<T>(method, params); saved = true;
    if (error !== 'status-loss') throw new CoreError(error, secret); return result;
  });
  h.replies.push(() => success); const flow = await start(h.providers);
  const page = await outcome(h.providers, flow, error === 'unconfirmed' || error === 'conflict' ? 'failed' : 'complete');
  await until(() => h.reports.some(report => /lark_registration_(complete|failed)/.test(String(report.status))));
  const settled = await status(h.providers, flow);
  assert.equal(settled.error, error === 'status-loss' ? 'provider_status_unavailable' : error === 'conflict' ? 'save_failed' : error === 'unconfirmed' ? 'save_unconfirmed' : error);
  if (error !== 'conflict') {
    assert.equal(h.core.configs.get(page.provider_id!)?.app_secret, secret);
    assert.deepEqual(await h.providers.registration({ action: 'cancel', registration_id: flow.registration_id }), settled);
    assert.deepEqual(await status(h.providers, flow), settled);
    assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, 1);
  } else assert.equal(h.core.configs.size, 1);
  assert.ok(!JSON.stringify([settled, h.reports]).includes(secret));
});

test('a confirmed legacy reauthorization survives compatibility mirror failure', async t => {
  const h = await fixture(t, { providers: [{ ...personal, id: 'legacy-feishu' }] });
  h.providers.setCompatibilitySync(async update => { await update(); const error = new HttpError(409, secret);
    error.cause = new CoreError('committed_not_mirrored', secret); throw error; });
  h.replies.push(() => success); const flow = await start(h.providers, { id: 'legacy-feishu' });
  await outcome(h.providers, flow); await until(() => h.reports.some(report => report.status === 'lark_registration_complete'));
  const done = await status(h.providers, flow); assert.equal(done.error, 'committed_not_mirrored');
  assert.equal(done.provider_id, 'legacy-feishu'); assert.equal(h.core.configs.get(done.provider_id!)?.app_secret, secret);
  assert.ok(!JSON.stringify([done, h.reports]).includes(secret));
});

test('connecting refuses cancellation and shutdown waits for the local commit without deadlocking', async t => {
  const h = await fixture(t, { providers: [bot] }); const saving = gate(); t.after(() => saving.release());
  let entered = false; const request = h.core.request.bind(h.core);
  t.mock.method(h.core, 'request', async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'provider.save') { entered = true; await saving.promise; }
    return request<T>(method, params);
  });
  h.replies.push(() => success); const flow = await start(h.providers); await until(() => entered);
  assert.equal((await status(h.providers, flow)).status, 'connecting');
  await assert.rejects(h.providers.registration({ action: 'cancel', registration_id: flow.registration_id }), isStatus(409));
  await assert.rejects(start(h.providers), isStatus(409));
  const stopping = h.providers.stop(); await tick(); assert.equal(h.core.stopped, false);
  saving.release(); await stopping;
  assert.equal(h.core.stopped, true); const done = await status(h.providers, flow); assert.equal(done.status, 'complete');
  assert.equal(h.core.configs.get(done.provider_id!)?.app_secret, secret);
});

test('shutdown during credential verification cancels registration before core shutdown', async t => {
  const verifying = gate(); t.after(() => verifying.release()); let entered = false;
  const h = await fixture(t, { dependencies: { verify: async () => { entered = true; await verifying.promise; } } });
  h.replies.push(() => success); await start(h.providers); await until(() => entered);
  const stopping = h.providers.stop(); await tick(); assert.equal(h.core.stopped, false);
  verifying.release(); await stopping; assert.equal(h.core.stopped, true); assert.equal(h.core.configs.size, 0);
  await assert.rejects(start(h.providers), isStatus(503));
});

test('reconnect uses only the selected saved config, including unchanged legacy providers', async t => {
  const remote = { id: 'upstream', type: 'remote', name: 'Upstream', enabled: false, address: 'host:9418', token: 'private-token' };
  const h = await fixture(t, { providers: [bot, personal, remote] }); const expected = structuredClone(h.core.configs);
  for (const id of [personal.id, bot.id, remote.id]) {
    const before = h.core.calls.length; const page = await h.providers.action({ action: 'reconnect', id, provider: { id: bot.id, app_secret: 'ignored' } });
    const saves = h.core.calls.slice(before).filter(call => call.method === 'provider.save');
    assert.equal(saves.length, 1); assert.deepEqual(saves[0].params, expected.get(id));
    assert.equal(page.default_provider_id, bot.id); assert.ok(!JSON.stringify(page).includes('private-'));
  }
  await assert.rejects(h.providers.action({ action: 'reconnect', id: 'missing' }), isStatus(404));
  assert.deepEqual(h.core.configs, new Map([...expected].map(([id, config]) => [id, { ...config, app_secret: config.app_secret }])));
});

test('permission setup inspects exactly the selected owned Feishu app and rejects a replaced config', async t => {
  const inspected: string[] = []; let changed = false;
  const h = await fixture(t, { providers: [bot, personal, { id: 'remote', type: 'remote' }], dependencies: {
    setup: async api => {
      inspected.push(api.appId);
      const result = await inspectLarkSetup({ appId: api.appId, async request<T>() { return { app: { scopes: [] } } as T; } });
      if (changed) h.core.configs.delete(personal.id); return result;
    },
  } });
  const setup = await h.providers.setup(personal.id); assert.equal(setup.app_id, appId); assert.equal(setup.status, 'permissions-required');
  assert.ok(setup.missing.includes('im:chat:create')); assert.equal(new URL(setup.permission!.url).pathname, `/app/${appId}/auth`);
  assert.ok(!JSON.stringify(setup).includes('private-')); assert.deepEqual(inspected, [appId]);
  assert.equal((await h.providers.setup(bot.id)).app_id, oldAppId);
  await assert.rejects(h.providers.setup('missing'), isStatus(404)); await assert.rejects(h.providers.setup('remote'), isStatus(400));
  changed = true; await assert.rejects(h.providers.setup(personal.id), isStatus(409));
  assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, 0);
});

for (const known of [true, false]) test(`migration and legacy saves ${known ? 'carry matching' : 'omit unrelated'} saved personal subtype without GET mutations`, async t => {
  const saved = { lark_app_id: known ? appId : oldAppId, lark_connection_type: 'personal-app' as const };
  const h = await fixture(t, { saved, credentials: { appId, appSecret: secret } });
  assert.equal(h.core.calls.find(call => call.method === 'migration.import')?.params.connection_type, known ? 'personal-app' : undefined);
  const before = h.core.calls.length; const page = await h.providers.page(); await h.providers.page();
  assert.equal(page.providers[0].connection_type, known ? 'personal-app' : undefined);
  assert.ok(h.core.calls.slice(before).every(call => ['status', 'session.list'].includes(call.method)));
  await h.providers.configure({ appId, appSecret: secret });
  assert.equal(h.core.calls.filter(call => call.method === 'provider.save').at(-1)?.params.connection_type, known ? 'personal-app' : undefined);
});

test('simultaneous starts allocate only one active registration', async t => {
  const h = await fixture(t);
  const results = await Promise.allSettled([start(h.providers), start(h.providers)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(isStatus(409)(rejected.reason)); assert.equal(h.requests.filter(action => action === 'begin').length, 1);
});

test('the stale-target guard runs after compatibility preflight immediately before saving', async t => {
  const h = await fixture(t, { providers: [{ ...personal, id: 'legacy-feishu' }] });
  const preflight = gate(); t.after(() => preflight.release()); let entered = false;
  h.providers.setCompatibilitySync(async update => { entered = true; await preflight.promise; await update(); });
  h.replies.push(() => success); const flow = await start(h.providers, { id: 'legacy-feishu' }); await until(() => entered);
  await h.providers.configure({ appId, appSecret: 'private-concurrent-edit' });
  const expected = structuredClone(h.core.configs); preflight.release();
  assert.equal((await outcome(h.providers, flow, 'failed')).error, 'target_changed');
  assert.deepEqual(h.core.configs, expected);
  assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, 1);
});

test('shutdown while a start is awaiting config cannot launch a registration after the core stops', async t => {
  const h = await fixture(t); const reading = gate(); t.after(() => reading.release()); let entered = false;
  const request = h.core.request.bind(h.core);
  t.mock.method(h.core, 'request', async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'config.export') { entered = true; await reading.promise; } return request<T>(method, params);
  });
  const starting = start(h.providers); const rejected = assert.rejects(starting, isStatus(503)); await until(() => entered);
  const stopping = h.providers.stop(); reading.release(); await rejected; await stopping;
  assert.equal(h.requests.length, 0); assert.equal(h.core.stopped, true);
});

test('reconnect reads its saved config inside the change queue and cannot resurrect a deleted channel', async t => {
  const h = await fixture(t, { providers: [bot, personal] }); const deleting = gate(); t.after(() => deleting.release()); let entered = false;
  const request = h.core.request.bind(h.core);
  t.mock.method(h.core, 'request', async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'provider.delete') { entered = true; await deleting.promise; } return request<T>(method, params);
  });
  const deletion = h.providers.action({ action: 'delete', id: personal.id }); await until(() => entered);
  const reconnect = assert.rejects(h.providers.action({ action: 'reconnect', id: personal.id }), isStatus(404));
  deleting.release(); await deletion; await reconnect;
  assert.equal(h.core.configs.has(personal.id), false); assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, 0);
});

test('legacy subtype-only edits reach the core while omitted subtype keeps compatibility retry semantics', async t => {
  const h = await fixture(t, { providers: [bot] });
  await h.providers.action({ action: 'save', provider: { ...bot, connection_type: 'personal-app' } });
  assert.equal(h.core.configs.get(bot.id)?.connection_type, 'personal-app');
  const count = h.core.calls.filter(call => call.method === 'provider.save').length;
  const { connection_type: _omitted, ...masked } = bot;
  await h.providers.action({ action: 'save', provider: masked });
  assert.equal(h.core.calls.filter(call => call.method === 'provider.save').length, count);
  assert.equal(h.core.configs.get(bot.id)?.connection_type, 'personal-app');
});
