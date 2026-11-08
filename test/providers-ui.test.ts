import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { ProviderSummary, RemoteSummary } from '../src/providers.js';

async function until(check: () => unknown, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await nextTurn(); }
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
  t.after(() => { for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } });
  const selectPrototype = window.HTMLSelectElement.prototype;
  const selectValue = Object.getOwnPropertyDescriptor(selectPrototype, 'value')!;
  Object.defineProperty(selectPrototype, 'value', { ...selectValue, set(this: HTMLSelectElement, value: string) {
    const options = [...this.querySelectorAll('option')];
    for (const option of options) option.selected = false;
    const selected = options.find(option => option.value === value); if (selected) selected.selected = true;
  } });
  t.after(() => Object.defineProperty(selectPrototype, 'value', selectValue));
  let focused: HTMLElement | null = null;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => focused });
  t.mock.method(window.HTMLElement.prototype, 'focus', function (this: HTMLElement) { focused = this; });
  const element = (id: string) => document.getElementById(id)! as unknown as HTMLElement;
  const field = (id: string) => element(id) as HTMLInputElement;
  const button = (id: string) => element(id) as HTMLButtonElement;
  const dialog = element('provider-delete-dialog') as HTMLDialogElement;
  Object.defineProperty(dialog, 'open', { configurable: true, get: () => dialog.hasAttribute('open') });
  dialog.showModal = () => { dialog.setAttribute('open', ''); };
  dialog.close = () => { dialog.removeAttribute('open'); };
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
      } else if (body.action === 'default') defaultProvider = body.id as string;
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
  await import('../src/ui-app.js');
  await until(() => !button('provider-add').disabled, 'Provider settings did not load');
  const poll = timers.find(timer => timer.milliseconds === 2000)!.run;

  await t.test('empty state is actionable and navigation uses Providers, Repos and Remote access', () => {
    assert.equal(element('providers-empty').hidden, false);
    assert.equal(element('providers-summary').textContent, 'No default provider selected');
    assert.equal(document.querySelector('[data-view="settings-remote"]')!.textContent, 'Remote access');
    assert.equal(document.querySelector('#settings-subnav [data-view="settings-lark"]'), null);
    assert.equal(document.querySelectorAll('.nav-label')[1].textContent, 'Repos');
    assert.equal(secretReads, 0);
  });

  await t.test('adding Feishu saves exact credentials and displays names as escaped text', async () => {
    button('provider-add').click();
    change('provider-name', '<img src=x onerror=alert(1)>'); change('provider-app-id', 'cli_synthetic');
    change('provider-app-secret', 'synthetic-feishu-secret'); change('provider-recipient', 'ou_synthetic');
    submit('provider-editor');
    assert.equal(button('provider-save').disabled, true);
    await until(() => element('provider-editor').hidden, 'Feishu provider did not save');
    assert.equal(providers.length, 1); assert.equal(providers[0].type, 'feishu');
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
    assert.equal(field('provider-type').disabled, true);
    assert.match(element('provider-secret-hint').textContent!, /leave blank to keep/i);
    change('provider-name', 'Work Feishu'); submit('provider-editor');
    await until(() => element('provider-editor').hidden, 'Provider edit did not finish');
    const saved = providerWrites.at(-1)!.provider as Record<string, unknown>;
    assert.equal(Object.hasOwn(saved, 'app_secret'), false); assert.equal(saved.recipient_open_id, 'ou_synthetic');
    assert.equal(secrets.get('provider-1'), 'synthetic-feishu-secret');
    assert.equal(document.activeElement?.getAttribute('data-key'), 'provider-edit-provider-1');
  });

  await t.test('remote providers save TLS options, change the default and preserve tokens when toggled', async () => {
    button('provider-add').click(); select('provider-type', 'remote');
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
    assert.equal(button('provider-save').disabled, true); assert.equal(providerWrites.length, before + 1);
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

  await t.test('new provider and remote labels translate without changing user data', () => {
    select('language', 'zh-CN');
    assert.equal(element('crumb-page').textContent, '远程接入'); assert.equal(element('remote-title').textContent, '远程接入');
    assert.equal(element('remote-peer-rows').querySelector('.row-title')!.textContent, '<b>Desktop A</b>');
    assert.match(element('remote-peer-rows').textContent!, /2 条待确认/);
    navigate('#/providers'); assert.equal(element('provider-add').textContent, '添加 Provider');
    assert.equal(providerRow('provider-1').querySelector('.setting-title')!.textContent, 'Retry this name');
  });
});
