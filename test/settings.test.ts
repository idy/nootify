import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AgentPrompt } from '../src/agents.js';
import { EventLog } from '../src/events.js';
import { deviceCode, GitHubAuth } from '../src/github-auth.js';
import { PullRequestsService } from '../src/github.js';
import { resolveCredentials, type Credentials, type LarkApi } from '../src/lark-metadata.js';
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
/** Stands in for gh, as GH_BIN: a login prints its code and waits for `<gh>.go`; `<gh>.deny` makes it fail. */
async function fakeGh(t: TestContext, dir: string): Promise<string> {
  const path = join(dir, 'gh');
  await writeFile(path, `#!/bin/sh
case "$1" in
  --version) echo 'gh version 2.0.0 (test)' ;;
  auth)
    echo '! One-time code (ABCD-1234) copied to clipboard' >&2
    echo 'Open this URL to continue in your web browser: https://github.com/login/device' >&2
    while [ ! -f "$0.go" ]; do sleep 0.02; done
    if [ -f "$0.deny" ]; then echo 'access_denied: the user cancelled' >&2; exit 1; fi
    touch "$0.ok" ;;
  api)
    if [ -f "$0.offline" ]; then echo 'dial tcp: lookup api.github.com: no such host' >&2; exit 1; fi
    if [ -f "$0.ok" ]; then echo '{"data":{"viewer":{"login":"octo"}}}'; exit 0; fi
    echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4 ;;
esac
`);
  await chmod(path, 0o755);
  const previous = process.env.GH_BIN;
  process.env.GH_BIN = path;
  t.after(() => { if (previous === undefined) delete process.env.GH_BIN; else process.env.GH_BIN = previous; });
  return path;
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
  const settings = new SettingsService({ state, lark, pulls, agents, github: new GitHubAuth(dir), env: options.env ?? {}, mcpConfig: options.mcpConfig,
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

test('device codes are read from either gh wording, even after a clipboard warning', () => {
  const url = 'Open this URL to continue in your web browser: https://github.com/login/device\n';
  assert.deepEqual(deviceCode(`! One-time code (ABCD-1234) copied to clipboard\n${url}`), { code: 'ABCD-1234', url: 'https://github.com/login/device' });
  assert.equal(deviceCode(`failed to copy one-time code to clipboard: exec: "pbcopy"\n! First copy your one-time code: WXYZ-9876\n${url}`)?.code, 'WXYZ-9876');
  assert.equal(deviceCode('! One-time code (ABCD-1234) copied to clipboard\n'), undefined, 'still waiting for the URL');
  assert.equal(deviceCode(url), undefined);
  assert.equal(deviceCode(`Reference ABCD-1234\n${url}`), undefined, 'only gh\'s own code line counts');
});

test('a device login shows gh\'s code, leaves the credential to gh and refreshes afterwards', async t => {
  const dir = await temporary(t); const gh = await fakeGh(t, dir);
  let refreshed = 0; const reports: Record<string, unknown>[] = [];
  const auth = new GitHubAuth(dir, record => reports.push(record), () => { refreshed++; });
  assert.deepEqual(await auth.account(), { installed: true, signedIn: false });
  assert.equal(auth.start().status, 'starting');
  assert.equal(auth.start().status, 'starting', 'a second start joins the running login');
  const waiting = await until(() => auth.login().status === 'waiting' && auth.login());
  assert.deepEqual([waiting.code, waiting.url], ['ABCD-1234', 'https://github.com/login/device']);
  assert.ok(Date.parse(waiting.expiresAt!) > Date.now());
  await writeFile(`${gh}.go`, '');
  await until(() => refreshed === 1);
  assert.deepEqual(auth.login(), { status: 'idle' });
  assert.deepEqual(await auth.account(), { installed: true, signedIn: true, login: 'octo' });
  assert.deepEqual(reports.map(record => record.status), ['github_login']);
});

test('a cancelled or refused login reports its outcome and can be retried', async t => {
  const dir = await temporary(t); const gh = await fakeGh(t, dir);
  let refreshed = 0;
  const auth = new GitHubAuth(dir, () => {}, () => { refreshed++; });
  auth.start();
  await until(() => auth.login().status === 'waiting');
  assert.deepEqual(auth.cancel(), { status: 'idle' });
  await auth.stop();
  assert.deepEqual(auth.login(), { status: 'idle' }, 'the killed child does not report over the cancellation');
  await writeFile(`${gh}.go`, ''); await writeFile(`${gh}.deny`, '');
  auth.start();
  const failed = await until(() => auth.login().status === 'failed' && auth.login());
  assert.match(failed.error!, /access_denied/);
  assert.equal(refreshed, 0);
  await rm(`${gh}.deny`);
  auth.start();
  await until(() => refreshed === 1);
  assert.equal((await auth.account()).login, 'octo');
});

test('a missing gh or an unreachable GitHub is not reported as signed out', async t => {
  const dir = await temporary(t); const gh = await fakeGh(t, dir);
  await writeFile(`${gh}.offline`, '');
  const auth = new GitHubAuth(dir);
  const offline = await auth.account();
  assert.deepEqual([offline.installed, offline.signedIn], [true, false]);
  assert.match(offline.error!, /no such host/);
  process.env.GH_BIN = join(dir, 'missing-gh');
  assert.equal((await auth.account()).installed, false);
  auth.start();
  assert.match((await until(() => auth.login().status === 'failed' && auth.login())).error!, /GitHub CLI is unavailable/);
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
  assert.equal(configured.length, 1, 'a blank secret keeps the saved one, and nothing changed, so the connection is left alone');
  await assert.rejects(settings.saveLark('cli_fedcba9876543210', ''), /App Secret/, 'another app never inherits this secret');
  assert.equal((await State.open(dir)).settings.lark_app_secret, 'right-secret');
  assert.equal((await stat(join(dir, 'state.json'))).mode & 0o777, 0o600);
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
  state.backends.set('opencode', { url: 'http://127.0.0.1:4096', password: 'backend-secret' });
  const { path, summary } = await settings.exportConfig();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  const file = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual([file.format, file.version], ['nootify-config', 1]);
  assert.deepEqual(file.lark, { app_id: appId, app_secret: 'export-secret', recipient_open_id: 'ou_owner' });
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
  assert.deepEqual(reopened.settings, { lark_recipient_open_id: 'ou_owner', lark_app_id: appId, lark_app_secret: 'export-secret' });
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
  assert.deepEqual(state.settings, { lark_app_id: appId, lark_app_secret: 'saved-secret', lark_recipient_open_id: 'ou_new' });
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
  const gh = await fakeGh(t, dir);
  const logs = await EventLog.open(dir);
  const local = await serve(t, logs, { settings });
  const remote = await serve(t, logs, { settings, via: 'tailnet', tailnet: { authorize: async () => undefined, url: () => undefined } as unknown as TailnetAccess });
  const save = { app_id: appId, app_secret: 'page-secret' };

  assert.equal((await action(local, '/ui/api/settings/lark', save, {})).status, 403, 'needs the UI header');
  assert.equal((await action(remote, '/ui/api/settings/lark', save)).status, 403, 'refused on the Tailscale listener');
  assert.equal((await action(remote, '/ui/api/settings/export')).status, 403);
  assert.equal((await action(remote, '/ui/api/settings/github/login', { action: 'start' })).status, 403);
  assert.equal((await action(remote, '/ui/api/settings/import', { document: {}, apply: true })).status, 403);
  assert.equal(state.settings.lark_app_id, undefined);

  assert.equal((await action(local, '/ui/api/settings/lark', save)).status, 200);
  assert.equal(configured.length, 1);
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
  await writeFile(`${gh}.ok`, '');
  assert.equal(((await (await fetch(`${local}/ui/api/settings/github`)).json()) as { account: { login: string } }).account.login, 'octo');
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
