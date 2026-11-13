import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { authorizeUiFixture, settleUiFixture } from './ui-transport-fixture.js';
import type { ProviderSummary, RemoteSummary } from '../src/ui-types.js';

async function until(check: () => unknown, message: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw new Error(message);
}

test('provider and remote-access UI performs real mutations, preserves secrets and enforces local-only editing', async t => {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const { window, document } = parseHTML(html);
  const globals: Record<string, unknown> = {
    window, document, Element: window.Element, HTMLElement: window.HTMLElement,
    navigator: { languages: ['en-US'], language: 'en-US' },
    location: new URL('http://127.0.0.1:9417/#/providers'),
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0, matchMedia: () => ({ matches: false }), CSS: { escape: (value: string) => value },
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(async () => { await settleUiFixture(); for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } });
  let focused: HTMLElement | null = null;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => focused });
  t.mock.method(window.HTMLElement.prototype, 'focus', function (this: HTMLElement) { focused = this; });
  const element = (id: string) => document.getElementById(id)! as unknown as HTMLElement;
  const field = (id: string) => element(id) as HTMLInputElement;
  const button = (id: string) => element(id) as HTMLButtonElement;
  const dialog = element('provider-delete-dialog') as HTMLDialogElement;
  const providerDialog = element('provider-dialog') as HTMLDialogElement;
  for (const nativeDialog of [dialog, providerDialog]) {
    Object.defineProperty(nativeDialog, 'open', { configurable: true, get: () => nativeDialog.hasAttribute('open') });
    nativeDialog.showModal = () => { nativeDialog.setAttribute('open', ''); };
    nativeDialog.close = () => { nativeDialog.removeAttribute('open'); };
  }
  const timers: { run: () => void; milliseconds: number }[] = [];
  t.mock.method(globalThis, 'setInterval', ((run: () => void, milliseconds: number) => {
    timers.push({ run, milliseconds }); return {} as NodeJS.Timeout;
  }) as typeof globalThis.setInterval);

  let providers: ProviderSummary[] = [];
  let defaultProvider: string | undefined;
  let editable = true;
  const secrets = new Map<string, string>();
  let remote: RemoteSummary = { enabled: false, listen: '127.0.0.1:9418', status: 'disabled', tls: false, token_set: true, peers: [] };
  let remoteToken = 'synthetic-listener-token';
  const providerWrites: Record<string, unknown>[] = [];
  const remoteWrites: Record<string, unknown>[] = [];
  let registration: Record<string, unknown> = { status: 'idle' };
  const registrationWrites: Record<string, unknown>[] = [];
  let registrationRecovery: { id?: string; name: string; enabled: boolean } | undefined;
  let cancelCompletes = false; let setupReads = 0;
  let providerReads = 0; let remoteReads = 0; let secretReads = 0;
  let failProvider = false; let failRemote = false; let failProviderRead = false;
  let holdProvider: Promise<void> | undefined; let releaseProvider: (() => void) | undefined;
  let holdSecret: Promise<void> | undefined; let releaseSecret: (() => void) | undefined;
  const providerPage = () => ({ node_id: 'synthetic-local-node', providers, default_provider_id: defaultProvider, remote, editable });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), 'http://127.0.0.1:9417').pathname;
    if (path === '/ui/api/snapshot') return Response.json({ time: '2026-11-09T10:00:00Z', modules: [], sessions: [], logs: [] });
    if (path === '/ui/api/agents') return Response.json({ agents: [], editable });
    if (init?.method === 'POST') {
      assert.equal(new Headers(init.headers).get('x-nootify-ui'), '1');
      if (!editable) return Response.json({ error: 'Local access required' }, { status: 403 });
    }
    if (path === '/ui/api/providers/registration') {
      const body = JSON.parse(String(init?.body)); registrationWrites.push(body);
      if (body.action === 'recover') return Response.json(registration.status === 'idle' ? { status: 'idle' } : { ...registration, recovery: registrationRecovery });
      if (body.action === 'start') registration = { status: 'waiting', registration_id: 'synthetic-scan', url: 'https://open.feishu.cn/page/cli?user_code=TEST', qr: 'data:image/png;base64,c3ludGhldGlj', expires_at: new Date(Date.now() + 60000).toISOString() };
      else {
        assert.equal(body.registration_id, 'synthetic-scan');
        if (body.action === 'cancel' && !cancelCompletes) registration = { status: 'idle', registration_id: 'synthetic-scan' };
      }
      return Response.json(registration);
    }
    if (path === '/ui/api/providers/setup') { setupReads++; return Response.json({ app_id: 'cli_personal', status: 'ready', missing: [], mention_only: false }); }
    if (path === '/ui/api/providers') {
      if (init?.method !== 'POST') {
        providerReads++;
        if (failProviderRead) return Response.json({ error: 'Synthetic provider outage' }, { status: 503 });
        return Response.json(providerPage());
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; providerWrites.push(body);
      if (holdProvider) { await holdProvider; holdProvider = undefined; }
      if (failProvider) { failProvider = false; return Response.json({ error: '<b>Synthetic save failure</b>' }, { status: 503 }); }
      if (body.action === 'save') {
        const config = body.provider as ProviderSummary & { app_secret?: string; token?: string };
        const id = config.id || `provider-${providers.length + 1}`;
        assert.ok(config.name); assert.ok(config.type === 'feishu' ? config.app_id : config.address, 'Save includes all non-secret connection fields');
        if (config.app_secret || config.token) secrets.set(id, config.app_secret || config.token!);
        assert.ok(secrets.get(id), 'The fixture requires a secret for new providers');
        const { app_secret: _appSecret, token: _token, ...safe } = config;
        const summary = { ...safe, id, status: 'connected', ...(config.type === 'feishu' ? { secret_set: true } : { token_set: true }) };
        providers = [...providers.filter(provider => provider.id !== id), summary];
        defaultProvider ??= id;
      } else if (body.action === 'reconnect') { assert.ok(providers.some(provider => provider.id === body.id)); }
      else if (body.action === 'default') defaultProvider = body.id as string;
      else if (body.action === 'delete') {
        providers = providers.filter(provider => provider.id !== body.id);
        if (defaultProvider === body.id) defaultProvider = undefined;
      } else assert.fail(`Unknown provider action: ${String(body.action)}`);
      return Response.json(providerPage());
    }
    if (path === '/ui/api/settings/remote') {
      if (init?.method !== 'POST') { remoteReads++; return Response.json({ ...remote, node_id: 'synthetic-local-node', editable }); }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; remoteWrites.push(body);
      if (failRemote) { failRemote = false; return Response.json({ error: 'Synthetic listener failure' }, { status: 503 }); }
      if (body.token) remoteToken = String(body.token);
      remote = { ...remote, ...body, enabled: body.enabled as boolean, listen: body.listen as string,
        status: body.enabled ? 'listening' : 'disabled', tls: !!(body.tls_cert_file ?? remote.tls_cert_file), token_set: true };
      return Response.json({ ...remote, node_id: 'synthetic-local-node', editable });
    }
    if (path === '/ui/api/settings/remote/secret') {
      assert.equal(init?.method, 'POST'); secretReads++;
      if (holdSecret) { await holdSecret; holdSecret = undefined; }
      return Response.json({ token: remoteToken });
    }
    assert.fail(`Unexpected UI request: ${path}`);
  });
  const change = (id: string, value: string) => { field(id).value = value; field(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
  const select = (id: string, value: string) => { field(id).value = value; field(id).dispatchEvent(new window.Event('change', { bubbles: true })); };
  const submit = (id: string) => { element(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); };
  const navigate = (hash: string) => { location.hash = hash; window.dispatchEvent(new window.Event('hashchange')); };
  const providerButton = (id: string, action: string) => document.querySelector<HTMLButtonElement>(`#provider-rows [data-key="provider-${action}-${id}"]`)!;
  const providerRow = (id: string) => document.querySelector<HTMLElement>(`[data-provider-id="${id}"]`)!;
  authorizeUiFixture(t);
  await import('../src/ui-app.js');
  await until(() => !button('provider-add').disabled, 'Provider settings did not load');
  const poll = timers.find(timer => timer.milliseconds === 2000)!.run;

  await t.test('empty state is actionable and navigation keeps Channels and Remote access', () => {
    assert.equal(element('providers-empty').hidden, false);
    assert.equal(element('crumb-page').textContent, 'Channels');
    assert.equal(button('provider-add').textContent, 'Add channel');
    assert.equal(element('provider-add').closest('.titlebar'), null);
    assert.ok(element('provider-add').closest('#providers-view .providers-toolbar'));
    assert.equal(element('providers-summary').textContent, 'No default channel selected');
    assert.equal(document.querySelector('[data-view="settings-remote"]')!.textContent, 'Remote access');
    assert.equal(document.querySelector('#settings-subnav [data-view="settings-lark"]'), null);
    assert.equal(document.querySelectorAll('.nav-label').length, 1);
    assert.equal(document.querySelector('[data-view="repos"], [data-view^="pulls-"], [data-view="settings-github"]'), null);
    assert.equal(secretReads, 0);
  });

  const key = (id: string, value: string) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value }); element(id).dispatchEvent(event);
  };
  await t.test('Add opens three channel choices with search, keyboard navigation, Back and cancellable drafts', () => {
    assert.equal(element('provider-add').parentElement!.firstElementChild, element('provider-add'), 'Add is the first action above the list');
    button('provider-add').click();
    assert.equal(providerDialog.open, true); assert.equal(element('provider-chooser').hidden, false);
    assert.equal(element('provider-editor').hidden, true); assert.equal(document.activeElement, element('provider-type-search'));
    assert.equal(document.querySelectorAll('#provider-type-options button').length, 3);
    assert.equal(element('provider-choose-feishu').querySelector('strong')!.textContent, 'Feishu Bot');
    assert.equal(element('provider-choose-remote').querySelector('strong')!.textContent, 'Remote Nootify gRPC');
    submit('provider-editor'); assert.equal(providerWrites.length, 0, 'Choosing a type does not save anything');
    key('provider-type-search', 'ArrowDown'); assert.equal(document.activeElement, element('provider-choose-feishu'));
    key('provider-choose-feishu', 'ArrowDown'); assert.equal(document.activeElement, element('provider-choose-personal-app'));
    key('provider-choose-personal-app', 'ArrowDown'); assert.equal(document.activeElement, element('provider-choose-remote'));
    key('provider-choose-remote', 'Home'); assert.equal(document.activeElement, element('provider-choose-feishu'));
    change('provider-type-search', 'unavailable'); assert.equal(element('provider-type-empty').hidden, false);
    change('provider-type-search', 'grpc'); assert.equal(element('provider-choose-feishu').hidden, true);
    key('provider-type-search', 'Enter'); assert.equal(element('provider-remote-fields').hidden, false);
    assert.equal(element('provider-chooser').hidden, true); assert.equal(document.activeElement, element('provider-name'));
    change('provider-token', 'synthetic-draft-token'); button('provider-back').click();
    assert.equal(element('provider-chooser').hidden, false); assert.equal(field('provider-token').value, '');
    assert.equal(field('provider-type-search').value, ''); assert.equal(document.activeElement, element('provider-choose-remote'));
    button('provider-choose-feishu').click(); change('provider-app-secret', 'synthetic-draft-secret');
    key('provider-name', 'Escape'); assert.equal(providerDialog.open, false); assert.equal(field('provider-app-secret').value, '');
    assert.equal(document.activeElement, element('provider-add')); assert.equal(providerWrites.length, 0);
    button('provider-add').click(); providerDialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    assert.equal(providerDialog.open, false); assert.equal(document.activeElement, element('provider-add'));
    button('provider-add').click(); button('provider-dialog-close').click(); assert.equal(providerDialog.open, false);
  });

  await t.test('adding Feishu saves exact credentials and displays names as escaped text', async () => {
    button('provider-add').click(); button('provider-choose-feishu').click();
    change('provider-name', '<img src=x onerror=alert(1)>'); change('provider-app-id', 'cli_synthetic');
    change('provider-app-secret', 'synthetic-feishu-secret'); change('provider-recipient', 'ou_synthetic');
    submit('provider-editor');
    assert.equal(button('provider-save').disabled, true);
    await until(() => element('provider-editor').hidden, 'Feishu provider did not save');
    assert.equal(providers.length, 1); assert.equal(providers[0].type, 'feishu');
    assert.equal(providerDialog.open, false);
    assert.equal(providerButton('provider-1', 'default').hidden, true, 'Do not repeat an unavailable action on the default channel');
    assert.equal(element('providers-summary').hidden, true, 'The default badge is enough when a default exists');
    assert.equal(providerRow('provider-1').classList.contains('channel-entry'), true);
    assert.ok(providerRow('provider-1').closest('.channel-list'), 'Channels share one compact list group');
    assert.equal(secrets.get('provider-1'), 'synthetic-feishu-secret');
    assert.equal(providerRow('provider-1').querySelector('.setting-title')!.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(providerRow('provider-1').querySelector('img'), null);
    assert.equal(field('provider-app-secret').value, '', 'Clear write-only secrets after saving');
    assert.equal(document.activeElement, element('provider-add'));
  });

  await t.test('editing preserves a blank App Secret and the recipient, then clears it from the form', async () => {
    providerButton('provider-1', 'edit').click();
    assert.equal(field('provider-app-secret').value, '');
    assert.equal(field('provider-recipient').value, 'ou_synthetic');
    assert.equal(providerDialog.open, true); assert.equal(element('provider-chooser').hidden, true);
    assert.equal(element('provider-back').hidden, true); assert.equal(element('provider-type-name').textContent, 'Feishu Bot');
    assert.equal(document.querySelector('#provider-editor select'), null);
    assert.match(element('provider-secret-hint').textContent!, /leave blank to keep/i);
    change('provider-name', 'Work Feishu'); submit('provider-editor');
    await until(() => element('provider-editor').hidden, 'Provider edit did not finish');
    const saved = providerWrites.at(-1)!.provider as Record<string, unknown>;
    assert.equal(Object.hasOwn(saved, 'app_secret'), false); assert.equal(saved.recipient_open_id, 'ou_synthetic');
    assert.equal(secrets.get('provider-1'), 'synthetic-feishu-secret');
    assert.equal(document.activeElement?.getAttribute('data-key'), 'provider-edit-provider-1');
  });

  await t.test('remote providers save TLS options, change the default and preserve tokens when toggled', async () => {
    button('provider-add').click(); button('provider-choose-remote').click();
    assert.equal(element('provider-feishu-fields').hidden, true);
    assert.equal(element('provider-remote-fields').hidden, false);
    change('provider-name', 'Remote home'); change('provider-address', 'home.example:9418');
    change('provider-token', 'synthetic-upstream-token'); change('provider-server-name', 'home.example'); submit('provider-editor');
    await until(() => element('provider-editor').hidden, 'Remote provider did not save');
    assert.equal(providers[1].tls, true); assert.equal(providers[1].server_name, 'home.example');
    providerButton('provider-2', 'default').click();
    await until(() => element('providers-summary').textContent === 'Default: Remote home', 'Default provider did not change');
    providerButton('provider-2', 'edit').click();
    assert.equal(field('provider-token').value, ''); change('provider-name', 'Remote relay'); submit('provider-editor');
    await until(() => element('provider-editor').hidden, 'Remote provider edit did not save');
    assert.equal(Object.hasOwn(providerWrites.at(-1)!.provider as object, 'token'), false);
    const enabled = providerButton('provider-2', 'enabled') as unknown as HTMLInputElement;
    enabled.checked = false; enabled.dispatchEvent(new window.Event('change'));
    await until(() => providerRow('provider-2').querySelector('.provider-status')!.textContent === 'Disabled', 'Enabled flag did not update');
    const config = providerWrites.at(-1)!.provider as Record<string, unknown>;
    assert.equal(config.address, 'home.example:9418'); assert.equal(config.server_name, 'home.example');
    assert.equal(config.enabled, false); assert.equal(secrets.get('provider-2'), 'synthetic-upstream-token');
  });

  await t.test('failed saves retain input, show escaped errors and prevent concurrent writes', async () => {
    providerButton('provider-1', 'edit').click(); change('provider-name', 'Retry this name');
    failProvider = true; holdProvider = new Promise(resolve => { releaseProvider = resolve; });
    const before = providerWrites.length; submit('provider-editor'); submit('provider-editor');
    assert.equal((element('provider-fields') as HTMLFieldSetElement).disabled, true);
    assert.equal(button('provider-save').disabled, true);
    await until(() => providerWrites.length === before + 1, 'The encrypted save did not reach the API fixture');
    assert.equal(button('provider-dialog-close').disabled, true); key('provider-name', 'Escape'); assert.equal(providerDialog.open, true, 'A pending mutation retains the dialog');
    releaseProvider!();
    await until(() => !button('provider-save').disabled, 'Save failure left the editor busy');
    assert.equal(field('provider-name').value, 'Retry this name');
    assert.match(element('provider-editor-error').textContent!, /<b>Synthetic save failure<\/b>/);
    assert.equal(element('provider-editor-error').querySelector('b'), null);
    submit('provider-editor'); await until(() => element('provider-editor').hidden, 'Save retry did not work');
  });

  await t.test('deletion needs explicit confirmation, supports Escape and reports failures in the dialog', async () => {
    const before = providerWrites.length; providerButton('provider-2', 'delete').click();
    assert.equal(dialog.open, true); assert.equal(document.activeElement, element('provider-delete-cancel'));
    assert.equal(providerWrites.length, before); assert.match(element('provider-delete-detail').textContent!, /keeps the agent’s original conversations/);
    dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    assert.equal(dialog.open, false); assert.equal(document.activeElement?.getAttribute('data-key'), 'provider-delete-provider-2');
    providerButton('provider-2', 'delete').click(); failProvider = true; button('provider-delete-confirm').click();
    await until(() => !button('provider-delete-confirm').disabled, 'Failed deletion stayed busy');
    assert.equal(dialog.open, true); assert.equal(element('provider-delete-error').hidden, false); assert.equal(providers.length, 2);
    button('provider-delete-confirm').click();
    await until(() => !dialog.open, 'Confirmed provider deletion did not close');
    assert.equal(providers.length, 1); assert.equal(defaultProvider, undefined);
    assert.equal(providerRow('provider-2'), null); assert.equal(document.activeElement, element('provider-add'));
  });

  await t.test('read failures provide retry and read-only access blocks every mutation', async () => {
    failProviderRead = true; const beforeReads = providerReads; poll();
    await until(() => providerReads > beforeReads && !element('providers-banner').hidden, 'Provider outage did not render');
    assert.equal(button('providers-retry').hidden, false);
    failProviderRead = false; button('providers-retry').click();
    await until(() => element('providers-banner').hidden, 'Provider retry did not recover');
    editable = false; poll(); await until(() => !element('providers-readonly').hidden, 'Read-only provider page did not render');
    const before = providerWrites.length;
    assert.equal(button('provider-add').disabled, true);
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('#provider-rows input, #provider-rows button')) assert.equal(control.disabled, true);
    button('provider-add').click(); providerButton('provider-1', 'delete').click();
    assert.equal(element('provider-editor').hidden, true); assert.equal(dialog.open, false); assert.equal(providerWrites.length, before);
    editable = true;
  });

  await t.test('editing can cancel with focus restored, and a permission change disables an already open dialog', async () => {
    poll(); await until(() => !button('provider-add').disabled, 'Local provider controls did not restore');
    providerButton('provider-1', 'edit').click(); change('provider-app-secret', 'synthetic-discarded-secret');
    const before = providerWrites.length; button('provider-cancel').click();
    assert.equal(providerDialog.open, false); assert.equal(field('provider-app-secret').value, '');
    assert.equal(providerWrites.length, before); assert.equal(document.activeElement?.getAttribute('data-key'), 'provider-edit-provider-1');
    providerButton('provider-1', 'edit').click(); editable = false; poll();
    await until(() => (element('provider-fields') as HTMLFieldSetElement).disabled, 'Permission update did not disable dialog fields');
    assert.equal(button('provider-save').disabled, true); assert.match(element('provider-editor-local').textContent!, /local computer/);
    submit('provider-editor'); assert.equal(providerWrites.length, before);
    button('provider-cancel').click(); assert.equal(providerDialog.open, false); editable = true;
  });

  await t.test('remote access shows independently acknowledged downstreams and saves listener/TLS settings', async () => {
    remote.peers = [
      { node_id: 'downstream-a', name: '<b>Desktop A</b>', connected_at: '2026-11-09T09:00:00Z', pending: 2, last_ack: '2026-11-09T09:59:00Z' },
      { node_id: 'downstream-b', name: 'Desktop B', connected_at: '2026-11-09T09:30:00Z', connected: false, pending: 7 },
    ];
    navigate('#/settings/remote'); await until(() => !button('remote-save').disabled, 'Remote access did not load');
    assert.equal(element('crumb-page').textContent, 'Remote access'); assert.equal(field('remote-listen').value, '127.0.0.1:9418');
    assert.equal(secretReads, 0); assert.equal(field('remote-token').value, '');
    const rows = [...document.querySelectorAll('#remote-peer-rows .row')];
    assert.equal(rows.length, 2); assert.equal(rows[0].querySelector('.row-title')!.textContent, '<b>Desktop A</b>');
    assert.equal(rows[0].querySelector('b'), null); assert.match(rows[0].textContent!, /2 pending.*Last acknowledgement/);
    assert.match(rows[1].textContent!, /Disconnected/);
    assert.match(rows[1].textContent!, /7 pending.*No acknowledgement yet/);
    field('remote-enabled').checked = true; field('remote-enabled').dispatchEvent(new window.Event('input', { bubbles: true }));
    change('remote-listen', '0.0.0.0:9418'); field('remote-tls').checked = true; field('remote-tls').dispatchEvent(new window.Event('change', { bubbles: true }));
    change('remote-cert', '/synthetic/server.pem'); change('remote-key', '/synthetic/server-key.pem'); submit('remote-form');
    await until(() => element('remote-save-note').textContent === 'Remote access saved', 'Listener settings did not save');
    assert.deepEqual(remoteWrites.at(-1), { enabled: true, listen: '0.0.0.0:9418', tls_cert_file: '/synthetic/server.pem', tls_key_file: '/synthetic/server-key.pem' });
    assert.equal(element('remote-state').textContent, 'Listening'); assert.equal(field('remote-token').value, '');
    change('remote-cert', ''); change('remote-key', ''); submit('remote-form');
    await until(() => !button('remote-save').disabled, 'TLS preservation save did not finish');
    assert.equal(Object.hasOwn(remoteWrites.at(-1)!, 'tls_cert_file'), false); assert.equal(remote.tls_cert_file, '/synthetic/server.pem');
  });

  await t.test('tokens reveal only on explicit action, hide clears fetched secrets, and edits survive polling', async () => {
    button('remote-token-toggle').click(); await until(() => field('remote-token').type === 'text', 'Token did not reveal');
    assert.equal(secretReads, 1); assert.equal(field('remote-token').value, 'synthetic-listener-token');
    assert.equal(element('remote-token-toggle').getAttribute('aria-pressed'), 'true');
    button('remote-token-toggle').click(); assert.equal(field('remote-token').type, 'password'); assert.equal(field('remote-token').value, '');
    change('remote-token', 'synthetic-replacement-token'); change('remote-listen', '127.0.0.1:9520');
    const beforeReads = remoteReads; poll(); await until(() => remoteReads > beforeReads, 'Remote status did not refresh'); await nextTurn();
    assert.equal(field('remote-listen').value, '127.0.0.1:9520'); assert.equal(field('remote-token').value, 'synthetic-replacement-token');
    button('remote-token-toggle').click(); assert.equal(secretReads, 1, 'Viewing an entered token never fetches the saved one');
    field('remote-tls').checked = false; field('remote-tls').dispatchEvent(new window.Event('change', { bubbles: true }));
    submit('remote-form'); await until(() => !button('remote-save').disabled, 'Token replacement did not finish');
    assert.deepEqual(remoteWrites.at(-1), { enabled: true, listen: '127.0.0.1:9520', token: 'synthetic-replacement-token', tls_cert_file: '', tls_key_file: '' });
    assert.equal(field('remote-token').value, ''); assert.equal(field('remote-token').type, 'password');
    assert.equal(remoteToken, 'synthetic-replacement-token');
  });

  await t.test('remote failures remain recoverable and navigation discards an in-flight reveal', async () => {
    failRemote = true; change('remote-listen', '127.0.0.1:9600'); submit('remote-form');
    await until(() => !button('remote-save').disabled, 'Remote failure stayed busy');
    assert.match(element('remote-banner').textContent!, /Synthetic listener failure/); assert.equal(field('remote-listen').value, '127.0.0.1:9600');
    const beforeReads = remoteReads; poll(); await until(() => remoteReads > beforeReads, 'Status refresh did not run after failure'); await nextTurn();
    assert.match(element('remote-banner').textContent!, /Synthetic listener failure/, 'Background status refresh must not erase a failed save');
    submit('remote-form'); await until(() => element('remote-save-note').textContent === 'Remote access saved', 'Remote retry failed');
    holdSecret = new Promise(resolve => { releaseSecret = resolve; }); button('remote-token-toggle').click();
    assert.equal(button('remote-token-toggle').disabled, true);
    navigate('#/providers'); releaseSecret!(); await nextTurn(); await nextTurn();
    assert.equal(field('remote-token').type, 'password'); assert.equal(field('remote-token').value, '');
    editable = false; navigate('#/settings/remote');
    await until(() => !element('remote-readonly').hidden, 'Remote read-only status did not load');
    const before = remoteWrites.length; const reveals = secretReads;
    assert.equal((element('remote-fields') as HTMLFieldSetElement).disabled, true);
    assert.equal(button('remote-token-toggle').disabled, true); assert.equal(button('remote-save').disabled, true);
    button('remote-token-toggle').click(); submit('remote-form');
    assert.equal(remoteWrites.length, before); assert.equal(secretReads, reveals);
  });

  await t.test('personal App authorization creates a scoped channel and preserves draft/cancel semantics', async () => {
    editable = true; navigate('#/providers'); await until(() => !button('provider-add').disabled, 'Channels unavailable');
    button('provider-add').click(); change('provider-type-search', 'oauth');
    assert.equal(button('provider-choose-personal-app').hidden, false); assert.equal(button('provider-choose-feishu').hidden, true);
    key('provider-type-search', 'Enter');
    assert.equal(element('provider-personal-fields').hidden, false); assert.equal(element('provider-feishu-fields').hidden, true);
    assert.equal(button('provider-save').textContent, 'Authorize with QR code');
    change('provider-name', 'Personal messages'); submit('provider-editor');
    await until(() => registrationWrites.length > 0 && !button('provider-cancel').disabled, 'Scan did not start');
    assert.deepEqual(registrationWrites.at(-1), { action: 'start', name: 'Personal messages', enabled: true });
    assert.equal(element('provider-registration').hidden, false);
    assert.equal(element('provider-registration-open').getAttribute('href'), 'https://open.feishu.cn/page/cli?user_code=TEST');
    assert.equal(button('provider-save').hidden, true);
    button('provider-cancel').click(); await until(() => !providerDialog.open, 'Cancel did not close');
    assert.equal(registrationWrites.at(-1)!.action, 'cancel'); assert.equal(document.activeElement, element('provider-add'));

    button('provider-add').click(); button('provider-choose-personal-app').click(); change('provider-name', 'Personal messages'); submit('provider-editor');
    await until(() => registration.status === 'waiting' && !button('provider-cancel').disabled, 'Second scan did not start');
    const previousDefault = defaultProvider;
    providers.push({ id: 'personal-1', name: 'Personal messages', type: 'feishu', connection_type: 'personal-app', enabled: true,
      status: 'connected', app_id: 'cli_personal', recipient_open_id: 'ou_personal', secret_set: true });
    secrets.set('personal-1', 'synthetic-personal-secret');
    registration = { status: 'complete', registration_id: 'synthetic-scan', provider_id: 'personal-1', app_id: 'cli_personal', setup: { app_id: 'cli_personal', status: 'ready', missing: [], mention_only: false } };
    poll(); await until(() => button('provider-save').textContent === 'Save' && !button('provider-save').disabled, 'Completion did not reconcile');
    assert.equal(defaultProvider, previousDefault); assert.match(providerRow('personal-1').textContent!, /Feishu personal app/);
    assert.equal(element('provider-personal-actions').hidden, false); assert.equal(field('provider-app-secret').value, '');
    change('provider-name', 'Renamed personal'); submit('provider-editor'); await until(() => !providerDialog.open, 'Rename did not save');
    assert.equal((providerWrites.at(-1)!.provider as ProviderSummary).connection_type, 'personal-app');
    assert.equal(Object.hasOwn(providerWrites.at(-1)!.provider as object, 'app_secret'), false);
    providerButton('personal-1', 'edit').click(); button('provider-reconnect').click(); await until(() => !button('provider-reconnect').disabled, 'Reconnect did not finish');
    assert.deepEqual(providerWrites.at(-1), { action: 'reconnect', id: 'personal-1' });
    button('provider-permissions-check').click(); await until(() => setupReads > 0 && !button('provider-permissions-check').disabled, 'Permission check did not finish');
    assert.match(element('provider-permissions-status').textContent!, /permissions are enabled/);
    button('provider-reauthorize').click(); await until(() => registration.status === 'waiting' && !button('provider-cancel').disabled, 'Reauthorization did not start');
    assert.equal(registrationWrites.at(-1)!.id, 'personal-1');
    registration = { ...registration, expires_at: new Date(Date.now() - 1000).toISOString() }; poll();
    await until(() => !button('provider-registration-retry').hidden, 'Expired QR did not offer retry');
    assert.equal(element('provider-registration-qr').hidden, true);
    const starts = registrationWrites.filter(write => write.action === 'start').length;
    button('provider-registration-retry').click();
    await until(() => registrationWrites.filter(write => write.action === 'start').length > starts && !button('provider-cancel').disabled, 'Retry did not start a new scoped scan');
    assert.equal(registrationWrites.at(-1)!.id, 'personal-1');
    registration = { status: 'failed', registration_id: 'synthetic-scan', error: 'app_mismatch' }; poll();
    await until(() => element('provider-registration-detail').textContent!.includes('does not match'), 'Scoped failure did not render');
    assert.equal(providers.find(p => p.id === 'personal-1')!.app_id, 'cli_personal'); button('provider-cancel').click();
  });

  await t.test('closing a waiting scan reconciles a completion that raced cancel', async () => {
    await settleUiFixture();
    const previousDefault = defaultProvider;
    const previousCount = providers.length;
    button('provider-add').click(); button('provider-choose-personal-app').click(); change('provider-name', 'Cancel race'); submit('provider-editor');
    await until(() => registration.status === 'waiting' && !button('provider-cancel').disabled, 'Scan did not start');
    providers.push({ id: 'personal-2', name: 'Cancel race', type: 'feishu', connection_type: 'personal-app', enabled: true,
      status: 'connected', app_id: 'cli_personal_2', recipient_open_id: 'ou_personal_2', secret_set: true });
    secrets.set('personal-2', 'synthetic-personal-2-secret');
    registration = { status: 'complete', registration_id: 'synthetic-scan', provider_id: 'personal-2', app_id: 'cli_personal_2' }; cancelCompletes = true;
    button('provider-cancel').click(); await until(() => !providerDialog.open, 'Completed cancellation did not close');
    cancelCompletes = false;
    assert.equal(providers.length, previousCount + 1); assert.equal(defaultProvider, previousDefault);
    assert.ok(providerRow('personal-1')); assert.ok(providerRow('personal-2'));
    assert.equal(providers.find(provider => provider.id === 'personal-1')!.name, 'Renamed personal');
    // A completed registration focuses its saved channel. Compare a scalar so a
    // failure does not synchronously inspect LinkeDOM's entire linked document.
    assert.equal(document.activeElement?.getAttribute('data-key'), 'provider-edit-personal-2');
  });

  await t.test('a new editor can recover an orphaned scan and cancel it without starting or writing another channel', async () => {
    await settleUiFixture(); navigate('#/providers');
    registration = { status: 'waiting', registration_id: 'synthetic-scan', url: 'https://open.feishu.cn/page/cli?user_code=RECOVER', expires_at: new Date(Date.now() + 60000).toISOString() };
    registrationRecovery = { id: 'personal-1', name: 'Recovered personal draft', enabled: false };
    const starts = registrationWrites.filter(write => write.action === 'start').length;
    const writes = providerWrites.length;
    button('provider-add').click(); button('provider-choose-personal-app').click();
    assert.equal(field('provider-name').value, '');
    button('provider-registration-recover').click();
    await until(() => !element('provider-registration').hidden && !button('provider-cancel').disabled, 'Orphaned scan was not recovered');
    assert.equal(field('provider-name').value, 'Recovered personal draft'); assert.equal(field('provider-enabled').checked, false);
    assert.equal(button('provider-save').hidden, true);
    assert.equal(element('provider-registration-open').getAttribute('href'), 'https://open.feishu.cn/page/cli?user_code=RECOVER');
    assert.equal(registrationWrites.filter(write => write.action === 'start').length, starts);
    button('provider-cancel').click(); await until(() => !providerDialog.open, 'Recovered scan could not be canceled');
    assert.equal(registrationWrites.at(-1)!.action, 'cancel'); assert.equal(registrationWrites.at(-1)!.registration_id, 'synthetic-scan');
    assert.equal(providerWrites.length, writes);
    assert.equal((document.activeElement as HTMLElement).dataset.key, 'provider-edit-personal-1');

    button('provider-add').click(); button('provider-choose-personal-app').click(); button('provider-registration-recover').click();
    await until(() => element('provider-editor-error').textContent!.includes('No previous authorization'), 'No-flow recovery was not explained');
    assert.equal(button('provider-save').hidden, false); button('provider-cancel').click();
  });

  await t.test('recovering a completion after a lost response adopts the saved channel without replaying its save', async () => {
    await settleUiFixture();
    registration = { status: 'complete', registration_id: 'synthetic-scan', provider_id: 'personal-2', app_id: 'cli_personal_2' };
    registrationRecovery = { name: 'Original draft before completion', enabled: false };
    const writes = providerWrites.length; const defaultBefore = defaultProvider;
    button('provider-add').click(); button('provider-choose-personal-app').click(); button('provider-registration-recover').click();
    await until(() => !element('provider-personal-actions').hidden && !button('provider-save').disabled, 'Saved authorization did not recover');
    assert.equal(field('provider-name').value, providers.find(provider => provider.id === 'personal-2')!.name);
    assert.equal(field('provider-app-id').value, 'cli_personal_2'); assert.equal(field('provider-app-secret').value, '');
    assert.equal(providerWrites.length, writes); assert.equal(defaultProvider, defaultBefore);
    button('provider-cancel').click(); assert.equal((document.activeElement as HTMLElement).dataset.key, 'provider-edit-personal-2');
  });

  await t.test('new provider and remote labels translate without changing user data', async () => {
    navigate('#/settings/remote');
    select('language', 'zh-CN');
    assert.equal(element('crumb-page').textContent, '远程接入'); assert.equal(element('remote-title').textContent, '远程接入');
    assert.equal(element('remote-peer-rows').querySelector('.row-title')!.textContent, '<b>Desktop A</b>');
    assert.match(element('remote-peer-rows').textContent!, /2 条待确认/);
    navigate('#/providers'); assert.equal(element('provider-add').textContent, '添加通道');
    assert.equal(providerRow('provider-1').querySelector('.setting-title')!.textContent, 'Retry this name');
    editable = true; poll(); await until(() => !button('provider-add').disabled, 'Provider chooser did not regain local access');
    button('provider-add').click();
    assert.equal(element('provider-editor-title').textContent, '添加通道');
    assert.equal(element('provider-choose-feishu').querySelector('strong')!.textContent, '飞书 Bot');
    assert.equal(element('provider-choose-remote').querySelector('strong')!.textContent, '远程 Nootify gRPC');
    change('provider-type-search', '飞书'); assert.equal(element('provider-choose-remote').hidden, true);
    button('provider-choose-feishu').click(); assert.equal(element('provider-editor-title').textContent, '配置飞书 Bot');
    select('language', 'en'); assert.equal(element('provider-editor-title').textContent, 'Configure Feishu Bot');
    button('provider-cancel').click(); assert.equal(providerDialog.open, false);
  });
});
