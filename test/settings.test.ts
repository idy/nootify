import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AgentPrompt } from '../src/agents.js';
import { EventLog } from '../src/events.js';
import { GitHubAuth } from '../src/github-auth.js';
import { PullRequestsService } from '../src/github.js';
import { ApiError, resolveCredentials, type Credentials, type LarkApi } from '../src/lark-metadata.js';
import { LarkService } from '../src/lark.js';
import { createServiceHost, type HostOptions } from '../src/server.js';
import { SessionsService } from '../src/sessions.js';
import { SettingsService, type AgentControl, type LarkControl } from '../src/settings.js';
import { State } from '../src/state.js';
import type { TailnetAccess } from '../src/tailnet.js';

const appId = 'cli_0123456789abcdef';
async function temporary(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nootify-settings-')); t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function until<T>(read: () => T | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = read();
    if (value) return value;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error('Timed out');
}
/** GitHub's device login and GraphQL in memory, with replies to polling queued in `replies`. Requests to the test's own servers pass through. */
function fakeGitHub(t: TestContext) {
  const github = { token: 'gho_fake-token', replies: [] as string[], offline: false, deviceReply: undefined as Record<string, unknown> | undefined, requests: [] as { url: string; fields: URLSearchParams }[] };
  const real = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1')) return real(input, init);
    if (github.offline) throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND github.com') });
    if (url === 'https://api.github.com/graphql') {
      return new Headers(init?.headers).get('authorization') === `Bearer ${github.token}`
        ? Response.json({ data: { viewer: { login: 'octo' } } }) : Response.json({ message: 'Bad credentials' }, { status: 401 });
    }
    github.requests.push({ url, fields: new URLSearchParams(String(init?.body)) });
    if (url === 'https://github.com/login/device/code') {
      return Response.json(github.deviceReply ?? { device_code: 'device-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0 });
    }
    assert.equal(url, 'https://github.com/login/oauth/access_token');
    const reply = github.replies.shift() ?? 'authorization_pending';
    return Response.json(reply === 'token' ? { access_token: github.token, token_type: 'bearer', scope: 'repo,read:org' } : { error: reply, ...(reply === 'slow_down' ? { interval: 0 } : {}) });
  });
  return github;
}
async function mcpFile(t: TestContext): Promise<string> {
  const path = join(await temporary(t), 'mcp.json');
  await writeFile(path, JSON.stringify({ mcpServers: { lark: { env: { LARK_APP_ID: 'cli_mcp', LARK_APP_SECRET: 'mcp-secret' } } } }));
  return path;
}
async function harness(t: TestContext, options: { env?: NodeJS.ProcessEnv; mcpConfig?: string; verify?: (credentials: Credentials) => Promise<void>; setAgent?: () => Promise<void> } = {}) {
  const dir = await temporary(t);
  const state = await State.open(dir);
  const configured: (Credentials | undefined)[] = [];
  const lark: LarkControl = { status: () => 'disabled', channel: () => ({ groups: 0 }),
    async configure(credentials) { lark.credentials = credentials; configured.push(credentials); } };
  const enabled: string[] = [];
  const agents: AgentControl = {
    async list() { return [{ agent: 'claude', injected: false }, { agent: 'codex', injected: true }] as AgentPrompt[]; },
    async set(agent) { await options.setAgent?.(); enabled.push(agent); return {} as AgentPrompt; },
  };
  const pulls = new PullRequestsService(dir);
  const revealed: string[] = []; const reports: Record<string, unknown>[] = [];
  const settings = new SettingsService({ state, lark, pulls, agents, github: new GitHubAuth(state, () => {}, () => {}, 'client-1'), env: options.env ?? {}, mcpConfig: options.mcpConfig,
    verify: options.verify ?? (async () => {}), reveal: async path => { revealed.push(path); }, report: record => reports.push(record) });
  return { dir, state, lark, pulls, settings, configured, enabled, revealed, reports };
}
async function serve(t: TestContext, logs: EventLog, options: HostOptions): Promise<string> {
  const server = createServiceHost([], 'test-token', logs, options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const action = (origin: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-nootify-ui': '1' }) => fetch(origin + path,
  { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test('a device login shows the code, keeps the token private and refreshes afterwards', async t => {
  const github = fakeGitHub(t);
  const dir = await temporary(t); const state = await State.open(dir);
  let changed = 0; const reports: Record<string, unknown>[] = [];
  const auth = new GitHubAuth(state, record => reports.push(record), () => { changed++; }, 'client-1');
  assert.deepEqual(await auth.account(), { signedIn: false });
  assert.equal(auth.start().status, 'starting');
  assert.equal(auth.start().status, 'starting', 'a second start joins the running login');
  const waiting = await until(() => auth.login().status === 'waiting' && auth.login());
  assert.deepEqual([waiting.code, waiting.url], ['ABCD-1234', 'https://github.com/login/device']);
  assert.ok(Date.parse(waiting.expiresAt!) > Date.now());
  assert.deepEqual(Object.fromEntries(github.requests[0].fields), { client_id: 'client-1', scope: 'repo read:org' });
  github.replies.push('slow_down', 'token');
  await until(() => changed === 1);
  assert.deepEqual(Object.fromEntries(github.requests.at(-1)!.fields), { client_id: 'client-1', device_code: 'device-1', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  assert.deepEqual(auth.login(), { status: 'idle' });
  assert.deepEqual(await auth.account(), { signedIn: true, login: 'octo' });
  assert.equal((await State.open(dir)).settings.github_token, github.token);
  assert.equal((await stat(join(dir, 'state.json'))).mode & 0o777, 0o600);
  assert.deepEqual(reports.map(record => record.status), ['github_login']);
  assert.ok(!JSON.stringify(reports).includes(github.token));
});

test('a cancelled, refused or expired login reports its outcome and can be retried', async t => {
  const github = fakeGitHub(t);
  const state = await State.open(await temporary(t));
  let changed = 0;
  const auth = new GitHubAuth(state, () => {}, () => { changed++; }, 'client-1');
  auth.start();
  await until(() => auth.login().status === 'waiting');
  assert.deepEqual(auth.cancel(), { status: 'idle' });
  await auth.stop();
  const polls = github.requests.length;
  await new Promise(done => setTimeout(done, 30));
  assert.equal(github.requests.length, polls, 'polling stops with the cancellation');
  for (const error of ['access_denied', 'expired_token', 'device_flow_disabled']) {
    github.replies.push(error);
    auth.start();
    assert.equal((await until(() => auth.login().status === 'failed' && auth.login())).error, error);
  }
  assert.deepEqual([changed, state.settings.github_token], [0, undefined]);
  github.replies.push('token');
  auth.start();
  await until(() => changed === 1);
  assert.equal(state.settings.github_token, github.token);
});

test('a dropped connection does not end a login, and GitHub refusing the app does', async t => {
  const github = fakeGitHub(t);
  const state = await State.open(await temporary(t));
  let changed = 0;
  const auth = new GitHubAuth(state, () => {}, () => { changed++; }, 'client-1');
  auth.start();
  await until(() => auth.login().status === 'waiting');
  github.offline = true;
  await new Promise(done => setTimeout(done, 30));
  assert.equal(auth.login().status, 'waiting');
  github.offline = false; github.replies.push('token');
  await until(() => changed === 1);
  await auth.signOut();
  github.deviceReply = { error: 'Not Found' };
  auth.start();
  assert.equal((await until(() => auth.login().status === 'failed' && auth.login())).error, 'Not Found');
});

test('a build without a client ID says so instead of calling GitHub', async t => {
  const github = fakeGitHub(t);
  const auth = new GitHubAuth(await State.open(await temporary(t)), () => {}, () => {}, '');
  assert.deepEqual(auth.start(), { status: 'failed', error: 'missing_client_id' });
  assert.equal(github.requests.length, 0);
});

test('a rejected token reads as signed out, an unreachable GitHub does not, and signing out forgets the token', async t => {
  const github = fakeGitHub(t);
  const dir = await temporary(t); const state = await State.open(dir);
  state.settings.github_token = github.token; await state.save();
  let changed = 0; const reports: Record<string, unknown>[] = [];
  const auth = new GitHubAuth(state, record => reports.push(record), () => { changed++; }, 'client-1');
  assert.deepEqual(await auth.account(), { signedIn: true, login: 'octo' });
  github.offline = true;
  const offline = await auth.account();
  assert.equal(offline.signedIn, false);
  assert.match(offline.error!, /Cannot reach GitHub: getaddrinfo ENOTFOUND/);
  github.offline = false;
  state.settings.github_token = 'gho_revoked';
  assert.deepEqual(await auth.account(), { signedIn: false });
  await auth.signOut();
  assert.equal((await State.open(dir)).settings.github_token, undefined);
  assert.deepEqual([changed, reports.map(record => record.status)], [1, ['github_logout']]);
});

test('credentials come from the environment, then saved settings, then the MCP file', async t => {
  const mcp = await mcpFile(t);
  const saved = { lark_app_id: 'cli_saved', lark_app_secret: 'saved-secret' };
  assert.equal(await resolveCredentials({}, {}), undefined);
  assert.deepEqual(await resolveCredentials({}, {}, mcp), { credentials: { appId: 'cli_mcp', appSecret: 'mcp-secret' }, source: 'mcp-config' });
  assert.deepEqual(await resolveCredentials({}, saved, mcp), { credentials: { appId: 'cli_saved', appSecret: 'saved-secret' }, source: 'settings' });
  assert.equal((await resolveCredentials({}, saved, join(dirname(mcp), 'missing.json')))?.source, 'settings', 'a broken MCP file cannot stop a saved bot');
  assert.equal((await resolveCredentials({ LARK_APP_ID: 'cli_env', LARK_APP_SECRET: 'env-secret' }, saved, mcp))?.source, 'environment');
  await assert.rejects(resolveCredentials({ LARK_APP_ID: 'cli_env' }, saved, mcp), /both/);
});

test('Feishu credentials are verified before they replace the running bot', async t => {
  let accepted = false;
  const { dir, state, settings, configured, reports } = await harness(t, { verify: async () => { if (!accepted) throw new Error('Feishu API 10014: app secret invalid'); } });
  await assert.rejects(settings.saveLark('not-an-id', 'secret'), /App ID/);
  await assert.rejects(settings.saveLark(appId, ''), /App Secret/);
  await assert.rejects(settings.saveLark(appId, 'wrong-secret'), /10014/);
  assert.equal(state.settings.lark_app_id, undefined);
  assert.equal(configured.length, 0);
  accepted = true;
  await settings.saveLark(appId, ' right-secret\n');
  assert.deepEqual(configured, [{ appId, appSecret: 'right-secret' }]);
  const page = await settings.page();
  assert.deepEqual([page.lark.app_id, page.lark.source, page.lark.saved], [appId, 'settings', true]);
  assert.ok(!JSON.stringify(page).includes('right-secret'));
  assert.ok(!JSON.stringify(reports).includes('right-secret'));
  await settings.saveLark(appId, '');
  assert.equal(configured.length, 2, 'an explicit save retains the secret and reconnects even unchanged credentials');
  await assert.rejects(settings.saveLark('cli_fedcba9876543210', ''), /App Secret/, 'another app never inherits this secret');
  assert.equal((await State.open(dir)).settings.lark_app_secret, 'right-secret');
  assert.equal((await stat(join(dir, 'state.json'))).mode & 0o777, 0o600);
});

test('Feishu requires both credentials before Settings can report a connection', async t => {
  const { lark, settings } = await harness(t);
  lark.status = () => 'ready';
  for (const credentials of [undefined, { appId, appSecret: '' }, { appId, appSecret: '   ' }, { appId: '', appSecret: 'secret' }]) {
    lark.credentials = credentials;
    const page = await settings.page();
    assert.equal(page.lark.configured, false);
    assert.equal(page.lark.status, 'disabled');
    assert.deepEqual(settings.larkSecret(), {});
  }
  lark.credentials = { appId, appSecret: 'configured-secret' };
  assert.deepEqual([(await settings.page()).lark.configured, (await settings.page()).lark.status], [true, 'ready']);
  assert.ok(!JSON.stringify(await settings.page()).includes('configured-secret'));
});

test('a masked MCP secret can be retained for its application when saving', async t => {
  const { lark, settings, configured } = await harness(t);
  lark.credentials = { appId, appSecret: 'mcp-secret' };
  await settings.saveLark(appId, '');
  assert.equal(configured.length, 1, 'saving the active MCP credentials also reconnects the receiver');
  assert.equal((await settings.page()).lark.saved, true);
  await assert.rejects(settings.saveLark('cli_fedcba9876543210', ''), /App Secret/);
});

test('recipient directory reads are local-only and selections refuse a changed application', async t => {
  const { lark, settings, dir, state } = await harness(t);
  const logs = await EventLog.open(dir);
  let reads = 0;
  lark.credentials = { appId, appSecret: 'private-secret' };
  lark.api = { appId, async request<T>(_method: string, path: string): Promise<T> {
    reads++;
    return (path.includes('/scopes') ? { user_ids: ['ou_owner'] } : { items: [{ open_id: 'ou_owner', name: 'Owner' }] }) as T;
  } };
  const local = await serve(t, logs, { settings });
  const remote = await serve(t, logs, { settings, via: 'tailnet', tailnet: { authorize: async () => undefined, url: () => undefined } as unknown as TailnetAccess });
  const path = '/ui/api/settings/lark/recipients';
  assert.equal((await action(local, path, undefined, {})).status, 403);
  assert.equal((await action(remote, path)).status, 403);
  assert.equal(reads, 0);
  const result = await action(local, path);
  assert.equal(result.status, 200);
  const body = await result.text();
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(JSON.parse(body).users, [{ open_id: 'ou_owner', name: 'Owner' }]);
  assert.ok(!body.includes('private-secret'));
  await assert.rejects(settings.setRecipient('ou_owner', 'cli_other'), /credentials changed/);
  assert.equal(state.settings.lark_recipient_open_id, undefined);
  await settings.setRecipient('ou_owner', appId);
  assert.equal(state.settings.lark_recipient_open_id, 'ou_owner');
  lark.credentials = undefined;
  await assert.rejects(settings.larkRecipients(), /Configure/);
});

test('recipient snapshots are cached, while an explicit retry reads fresh provider data', async t => {
  const { lark, settings } = await harness(t); let reads = 0;
  lark.credentials = { appId, appSecret: 'secret' };
  lark.api = { appId, async request<T>(_method: string, path: string): Promise<T> { reads++; return (path.includes('/scopes') ? { user_ids: ['ou_owner'] } : { items: [{ open_id: 'ou_owner', name: 'Owner' }] }) as T; } };
  await settings.larkRecipients(); const firstReads = reads;
  await settings.larkRecipients(); assert.equal(reads, firstReads);
  await settings.larkRecipients(undefined, undefined, true); assert.ok(reads > firstReads);
});

test('local directory streams deliver contacts before a slow later batch and include a completion event', async t => {
  const { lark, settings, dir } = await harness(t);
  let release!: () => void; const slow = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const ids = Array.from({ length: 51 }, (_, i) => `ou_person${i}`);
  lark.credentials = { appId, appSecret: 'secret' };
  lark.api = { appId, async request<T>(_method: string, path: string): Promise<T> {
    if (path.includes('/scopes')) return { user_ids: ids } as T;
    const requested = new URL(path, 'https://open.feishu.cn').searchParams.getAll('user_ids');
    if (requested.includes('ou_person50')) await slow;
    return { items: requested.map(open_id => ({ open_id, name: open_id })) } as T;
  } };
  const origin = await serve(t, await EventLog.open(dir), { settings });
  const response = await action(origin, '/ui/api/settings/lark/recipients/stream', {});
  assert.match(response.headers.get('content-type')!, /ndjson/);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"type":"progress"/);
  assert.match(new TextDecoder().decode(first.value), /ou_person0/);
  release(); let rest = '';
  while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
  assert.match(rest, /"type":"complete"/);
  assert.match(rest, /ou_person50/);
});

test('permission failure streams provide an official locally generated QR and stay unavailable remotely', async t => {
  const { lark, settings, dir } = await harness(t);
  lark.credentials = { appId, appSecret: 'secret' };
  const url = `https://open.feishu.cn/app/${appId}/auth?q=contact:contact.base:readonly&op_from=openapi`;
  lark.api = { appId, async request<T>(): Promise<T> { throw new ApiError(99991672, 'private provider text', { url, scopes: ['contact:contact.base:readonly'] }); } };
  const logs = await EventLog.open(dir); const local = await serve(t, logs, { settings });
  const response = await action(local, '/ui/api/settings/lark/recipients/stream', {});
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  const failure = events.find(event => event.type === 'error');
  assert.equal(failure.status, 403); assert.equal(failure.permission.url, url); assert.match(failure.permission.qr, /^data:image\/png;base64,/);
  assert.ok(!JSON.stringify(events).includes('private provider text'));
  const remote = await serve(t, logs, { settings, via: 'tailnet', tailnet: { authorize: async () => undefined, url: () => undefined } as unknown as TailnetAccess });
  assert.equal((await action(remote, '/ui/api/settings/lark/recipients/stream', {})).status, 403);
});

test('a directory response cannot survive a bot configuration change', async t => {
  const { lark, settings } = await harness(t);
  lark.credentials = { appId, appSecret: 'first' };
  lark.api = { appId, async request<T>(): Promise<T> {
    lark.credentials = { appId, appSecret: 'replacement' };
    return {} as T;
  } };
  await assert.rejects(settings.larkRecipients(), /credentials changed/);
});

test('credentials set for this process cannot be overridden from the page', async t => {
  const { settings, configured } = await harness(t, { env: { LARK_APP_ID: appId, LARK_APP_SECRET: 'env-secret' } });
  await assert.rejects(settings.saveLark(appId, 'other-secret'), /take precedence/);
  assert.equal(configured.length, 0);
});

test('clearing saved credentials returns to the MCP file, or disables Feishu without one', async t => {
  const withFile = await harness(t, { mcpConfig: await mcpFile(t) });
  await withFile.settings.saveLark(appId, 'saved-secret');
  await withFile.settings.clearLark();
  assert.deepEqual(withFile.configured.at(-1), { appId: 'cli_mcp', appSecret: 'mcp-secret' });
  assert.equal(withFile.state.settings.lark_app_secret, undefined);
  assert.deepEqual([(await withFile.settings.page()).lark.source, (await withFile.settings.page()).lark.saved], ['mcp-config', false]);
  const alone = await harness(t);
  await alone.settings.saveLark(appId, 'saved-secret');
  await alone.settings.clearLark();
  assert.equal(alone.configured.at(-1), undefined);
  assert.equal((await alone.settings.page()).lark.source, undefined);
});

test('an unreadable MCP file leaves saved credentials in place when clearing', async t => {
  const { state, settings } = await harness(t, { mcpConfig: join(await temporary(t), 'missing.json') });
  await settings.saveLark(appId, 'saved-secret');
  await assert.rejects(settings.clearLark());
  assert.equal(state.settings.lark_app_secret, 'saved-secret');
});

test('an export keeps its secrets in a private file and keeps only the newest ten', async t => {
  const { lark, state, settings, revealed } = await harness(t);
  await assert.doesNotReject(settings.reveal());
  lark.credentials = { appId, appSecret: 'export-secret' };
  state.settings.lark_recipient_open_id = 'ou_owner';
  state.settings.github_token = 'gho_stays-here';
  state.backends.set('opencode', { url: 'http://127.0.0.1:4096', password: 'backend-secret' });
  const { path, summary } = await settings.exportConfig();
  assert.ok(!(await readFile(path, 'utf8')).includes('gho_stays-here'), 'the GitHub sign-in is not part of an export');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  const file = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual([file.format, file.version], ['nootify-config', 1]);
  assert.deepEqual(file.lark, { app_id: appId, app_secret: 'export-secret', recipient_open_id: 'ou_owner', connection_type: 'bot' });
  assert.equal(file.backends.opencode.password, 'backend-secret');
  assert.deepEqual(file.agents, ['codex']);
  assert.ok(!JSON.stringify({ path, summary }).includes('secret'));
  assert.equal((await settings.page()).last_export, path);
  await settings.reveal();
  assert.deepEqual(revealed, [dirname(path), path]);
  for (let index = 0; index < 11; index++) await settings.exportConfig();
  assert.equal((await readdir(dirname(path))).length, 10);
});

test('an exported file restores another installation, after a preview that changes nothing', async t => {
  const source = await harness(t);
  source.lark.credentials = { appId, appSecret: 'export-secret' };
  source.state.settings.lark_recipient_open_id = 'ou_owner';
  source.state.backends.set('opencode', { url: 'http://127.0.0.1:4096', password: 'backend-secret' });
  await writeFile(join(source.dir, 'pulls.config.json'), JSON.stringify({ ownedOwners: ['acme'] }));
  await source.pulls.setChoice('acme/widgets', true);
  const document = JSON.parse(await readFile((await source.settings.exportConfig()).path, 'utf8'));

  const target = await harness(t);
  assert.deepEqual(await target.settings.previewImport(document), { exported_at: document.exported_at, app_id: appId, recipient: 'ou_owner',
    pulls_config: true, follow: 1, backends: ['opencode'], agents: ['codex'], warnings: [] });
  assert.equal(target.state.settings.lark_app_id, undefined);
  assert.equal(target.configured.length, 0);
  await assert.rejects(stat(join(target.dir, 'pulls.config.json')), { code: 'ENOENT' });

  assert.deepEqual((await target.settings.importConfig(document)).warnings, []);
  assert.deepEqual(target.configured, [{ appId, appSecret: 'export-secret' }]);
  assert.deepEqual(target.enabled, ['codex']);
  const reopened = await State.open(target.dir);
  assert.deepEqual(reopened.settings, { lark_recipient_open_id: 'ou_owner', lark_app_id: appId, lark_app_secret: 'export-secret', lark_connection_type: 'bot' });
  assert.equal(reopened.backends.get('opencode')?.password, 'backend-secret');
  assert.deepEqual(JSON.parse(await readFile(join(target.dir, 'pulls.config.json'), 'utf8')), { ownedOwners: ['acme'] });
  assert.equal((await stat(join(target.dir, 'pulls.config.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await target.pulls.preferences(), { config: { ownedOwners: ['acme'] }, follow: [{ repository: 'acme/widgets', follow: true }] });
  assert.equal((await stat(join(target.dir, 'repo-preferences.json'))).mode & 0o777, 0o600);
});

test('a file that fails validation changes nothing, even with a valid section first', async t => {
  const { state, settings, configured, enabled } = await harness(t);
  const base = { format: 'nootify-config', version: 1, exported_at: '2026-11-04T00:00:00.000Z' };
  const cases: [unknown, RegExp][] = [
    [[], /Not a Nootify/],
    [{ format: 'other', version: 1 }, /Not a Nootify/],
    [{ ...base, version: 2 }, /newer version/],
    [{ ...base, lark: { app_id: appId } }, /together/],
    [{ ...base, lark: { app_id: 'cli_short', app_secret: 'x' } }, /credentials/],
    [{ ...base, lark: { recipient_open_id: 'someone' } }, /recipient/],
    [{ ...base, pulls: { config: { authors: 'not-a-list' } } }, /authors/],
    [{ ...base, pulls: { follow: [{ repository: 'not a repository', follow: true }] } }, /follow/],
    [{ ...base, backends: { codex: { url: 'ws://example.com:4500' } } }, /local URL/],
    [{ ...base, backends: { opencode: { url: 'http://127.0.0.1:4096', password: 1 } } }, /password/],
    [{ ...base, agents: ['other'] }, /agents/],
    [{ ...base, lark: { app_id: appId, app_secret: 'x' }, agents: ['other'] }, /agents/],
  ];
  for (const [document, message] of cases) {
    await assert.rejects(settings.previewImport(document), message);
    await assert.rejects(settings.importConfig(document), message);
  }
  assert.deepEqual(state.settings, {});
  assert.deepEqual([state.backends.size, configured.length, enabled.length], [0, 0, 0]);
});

test('an import touches only what its file names and reports what it could not apply', async t => {
  const { state, settings, configured } = await harness(t, { setAgent: async () => { throw new Error('unbalanced markers'); } });
  await settings.saveLark(appId, 'saved-secret');
  state.backends.set('codex', { url: 'ws://127.0.0.1:4500' });
  const summary = await settings.importConfig({ format: 'nootify-config', version: 1, lark: { recipient_open_id: 'ou_new' }, agents: ['codex'] });
  assert.deepEqual(state.settings, { lark_app_id: appId, lark_app_secret: 'saved-secret', lark_recipient_open_id: 'ou_new', lark_connection_type: 'bot' });
  assert.equal(state.backends.size, 1);
  assert.equal(configured.length, 1, 'the bot is not reconnected');
  assert.deepEqual(summary.warnings, ['codex: unbalanced markers']);
});

test('environment credentials stay in use after an import, and the import says so', async t => {
  const { settings, configured } = await harness(t, { env: { LARK_APP_ID: 'cli_env', LARK_APP_SECRET: 'env-secret' } });
  const summary = await settings.importConfig({ format: 'nootify-config', version: 1, lark: { app_id: appId, app_secret: 'file-secret' } });
  assert.deepEqual(configured, [{ appId: 'cli_env', appSecret: 'env-secret' }]);
  assert.match(summary.warnings[0], /stay in use/);
});

test('settings pages never carry secrets, and only this Mac can change anything', async t => {
  const { dir, state, settings, configured } = await harness(t);
  const github = fakeGitHub(t);
  const logs = await EventLog.open(dir);
  const local = await serve(t, logs, { settings });
  const remote = await serve(t, logs, { settings, via: 'tailnet', tailnet: { authorize: async () => undefined, url: () => undefined } as unknown as TailnetAccess });
  const save = { app_id: appId, app_secret: 'page-secret' };

  assert.equal((await action(local, '/ui/api/settings/lark', save, {})).status, 403, 'needs the UI header');
  assert.equal((await action(remote, '/ui/api/settings/lark', save)).status, 403, 'refused on the Tailscale listener');
  assert.equal((await action(remote, '/ui/api/settings/export')).status, 403);
  assert.equal((await action(remote, '/ui/api/settings/github/login', { action: 'start' })).status, 403);
  assert.equal((await action(remote, '/ui/api/settings/github/login', { action: 'sign-out' })).status, 403);
  assert.equal((await action(remote, '/ui/api/settings/import', { document: {}, apply: true })).status, 403);
  assert.equal(state.settings.lark_app_id, undefined);

  assert.equal((await action(local, '/ui/api/settings/lark', save)).status, 200);
  assert.equal(configured.length, 1);
  const revealPath = '/ui/api/settings/lark/secret';
  assert.equal((await action(local, revealPath, undefined, {})).status, 403, 'revealing needs the UI header');
  assert.equal((await action(remote, revealPath)).status, 403, 'remote browsers cannot reveal secrets');
  assert.equal((await action(local, revealPath, undefined, { 'x-nootify-ui': '1', origin: 'http://attacker.test' })).status, 403);
  assert.equal((await action(local, revealPath, undefined, { 'x-nootify-ui': '1', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.notEqual((await fetch(local + revealPath)).status, 200, 'GET cannot reveal a secret');
  const revealed = await action(local, revealPath);
  assert.equal(revealed.status, 200);
  assert.equal(revealed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await revealed.json(), save);
  for (const origin of [local, remote]) {
    for (const path of ['/ui/api/settings', '/ui/api/snapshot']) assert.ok(!(await (await fetch(origin + path)).text()).includes(save.app_secret));
  }
  assert.equal((await action(local, '/ui/api/settings/recipient', { open_id: 'ou_owner' })).status, 200);
  assert.equal(((await (await action(local, '/ui/api/settings/recipient', { open_id: 'bad' })).json()) as { error: string }).error, 'Expected a Feishu open_id (ou_…)');

  const page = await (await fetch(`${local}/ui/api/settings`)).json() as { editable: boolean; lark: { recipient?: string } };
  assert.deepEqual([page.editable, page.lark.recipient], [true, 'ou_owner']);
  assert.equal(((await (await fetch(`${remote}/ui/api/settings`)).json()) as { editable: boolean }).editable, false);
  const exported = await action(local, '/ui/api/settings/export');
  const body = await exported.text();
  assert.equal(exported.status, 200);
  assert.ok(!body.includes('page-secret'));
  assert.ok((await readFile((JSON.parse(body) as { path: string }).path, 'utf8')).includes('page-secret'));

  assert.equal((await action(local, '/ui/api/settings/import', { document: { format: 'other' } })).status, 400);
  assert.equal((await action(local, '/ui/api/settings/github/login', { action: 'other' })).status, 400);
  assert.equal((await action(local, '/ui/api/settings/github/login', { action: 'start' })).status, 200);
  await until(() => settings.startGitHubLogin().status === 'waiting');
  assert.equal(((await (await fetch(`${local}/ui/api/settings/github`)).json()) as { login: { code?: string } }).login.code, 'ABCD-1234');
  assert.deepEqual(((await (await fetch(`${remote}/ui/api/settings/github`)).json()) as { login: unknown }).login, { status: 'waiting' }, 'the code stays on this Mac');
  assert.equal((await action(local, '/ui/api/settings/github/login', { action: 'cancel' })).status, 200);
  await settings.stop();
  state.settings.github_token = github.token;
  const account = await (await fetch(`${local}/ui/api/settings/github`)).text();
  assert.equal((JSON.parse(account) as { account: { login: string } }).account.login, 'octo');
  for (const path of ['/ui/api/settings', '/ui/api/settings/github', '/ui/api/snapshot']) assert.ok(!(await (await fetch(local + path)).text()).includes(github.token), path);
  assert.equal((await action(local, '/ui/api/settings/github/login', { action: 'sign-out' })).status, 200);
  assert.equal(state.settings.github_token, undefined);
});

test('restoring pull preferences replaces only what it names', async t => {
  const dir = await temporary(t);
  const pulls = new PullRequestsService(dir);
  await pulls.setChoice('acme/widgets', true);
  await pulls.restore({ config: { authors: ['octo'] } });
  assert.deepEqual(await pulls.preferences(), { config: { authors: ['octo'] }, follow: [{ repository: 'acme/widgets', follow: true }] });
  await pulls.restore({ follow: [] });
  assert.deepEqual(await pulls.preferences(), { config: { authors: ['octo'] }, follow: [] });
});

test('the Feishu module swaps its bot in place', async t => {
  const state = await State.open(await temporary(t));
  const api: LarkApi = { appId: 'cli_test', async request<T>(): Promise<T> { return {} as T; } };
  const lark = new LarkService(state, new SessionsService(state), undefined, () => {}, api);
  assert.equal(lark.channel().configured, true);
  await lark.configure(undefined);
  assert.deepEqual([lark.channel().configured, lark.api, lark.threads, lark.credentials, lark.status()], [false, undefined, undefined, undefined, 'disabled']);
  // The SDK refuses this ID before it makes any network request.
  await lark.configure({ appId: 'cli_not_valid', appSecret: 'fake-secret' });
  assert.equal(lark.credentials?.appId, 'cli_not_valid');
  assert.equal(lark.channel().configured, true);
  assert.ok(lark.threads);
  assert.equal(lark.status(), 'connecting');
  await lark.stop();
});
