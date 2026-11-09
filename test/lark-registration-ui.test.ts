import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { SettingsPage } from '../src/settings.js';
import type { LarkRegistrationPage } from '../src/lark-registration.js';

async function until(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await nextTurn(); }
  throw new Error(message);
}

test('the live settings module reconciles committed QR settings after the service loses its transient registration', async t => {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const { window, document } = parseHTML(html);
  const globals: Record<string, unknown> = {
    window, document, navigator: { languages: ['en-US'], language: 'en-US' },
    location: new URL('http://127.0.0.1:9417/#/settings/lark'),
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false }),
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  const timers: { run: () => void; milliseconds: number }[] = [];
  t.mock.method(globalThis, 'setInterval', ((run: () => void, milliseconds: number) => {
    timers.push({ run, milliseconds }); return {} as NodeJS.Timeout;
  }) as typeof globalThis.setInterval);
  const channel = { status: 'disabled', configured: false, saved: false, threads: 0 };
  let settings: SettingsPage & { editable: boolean } = {
    version: '0.1.13', exports_dir: '/synthetic/exports', editable: true,
    lark: { status: 'disabled', configured: false, saved: false, groups: 0, connection_type: 'bot' },
  };
  let flow: LarkRegistrationPage = { status: 'idle' };
  let statusReads = 0; let settingsReads = 0; let failedSettingsReads = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), 'http://127.0.0.1:9417').pathname;
    if (path === '/ui/api/settings') {
      settingsReads++;
      if (failedSettingsReads > 0) { failedSettingsReads--; return Response.json({ error: 'Synthetic restart outage' }, { status: 503 }); }
      return Response.json(settings);
    }
    if (path === '/ui/api/snapshot') return Response.json({ time: new Date().toISOString(), modules: [{ name: 'lark', status: settings.lark.status }], sessions: [], logs: [] });
    if (path === '/ui/api/agents') return Response.json({ agents: [], editable: true });
    if (path === '/ui/api/settings/lark/permissions') return Response.json({ app_id: settings.lark.app_id, status: 'ready', missing: [], mention_only: false });
    if (path === '/ui/api/settings/lark/registration') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action: string };
      if (body.action === 'start') flow = { status: 'waiting', url: 'https://open.feishu.cn/page/cli?user_code=TEST-ONLY', qr: 'data:image/png;base64,c3ludGhldGlj', expires_at: new Date(Date.now() + 600_000).toISOString() };
      else if (body.action === 'status') statusReads++;
      else if (body.action === 'cancel') { const previous = flow; flow = { status: 'idle' }; return Response.json(previous.status === 'complete' ? previous : flow); }
      else assert.fail(`Unexpected registration action: ${body.action}`);
      return Response.json(flow);
    }
    assert.fail(`Unexpected settings request: ${path}`);
  });
  const element = (id: string) => document.getElementById(id)! as unknown as HTMLElement;
  const field = (id: string) => element(id) as HTMLInputElement;
  const button = (id: string) => element(id) as HTMLButtonElement;
  await import('../src/ui-app.js');
  await until(() => statusReads > 0 && !button('lark-type-personal').disabled, 'Initial settings did not load');
  const poll = timers.find(timer => timer.milliseconds === 2000)!.run;
  const commitAndRestart = (appId: string, recipient: string) => {
    settings = { ...settings, lark: { status: 'ready', configured: true, saved: true, source: 'settings', groups: 0, connection_type: 'personal-app', app_id: appId, recipient } };
    flow = { status: 'idle' }; // A fresh service instance restores settings but has no registration in memory.
  };
  await t.test('a refused scan keeps the personal app retry visible when durable settings are unchanged', async () => {
    button('lark-type-personal').click();
    await until(() => !element('lark-personal').hidden && !button('lark-qr-start').disabled, 'Personal app form did not open');
    button('lark-qr-start').click();
    await until(() => !element('lark-registration').hidden && !!element('lark-registration-qr').querySelector('img'), 'QR waiting state did not render');
    flow = { status: 'failed', error: 'access_denied' }; poll();
    await until(() => element('lark-registration-detail').textContent!.includes('declined') && !button('lark-qr-refresh').disabled, 'The refusal did not expose retry');
    assert.equal(element('lark-type-personal').getAttribute('aria-pressed'), 'true');
    assert.equal(element('lark-registration').hidden, false);
    assert.equal(field('lark-app-id').value, '');
  });
  await t.test('first setup reloads saved credentials and recipient when waiting becomes idle', async () => {
    assert.equal(field('lark-app-id').value, '');
    button('lark-type-personal').click();
    await until(() => !element('lark-personal').hidden && !button('lark-qr-start').disabled, 'Personal app form did not open');
    button('lark-qr-start').click();
    await until(() => !element('lark-registration').hidden && !!element('lark-registration-qr').querySelector('img'), 'QR waiting state did not render');
    const app = 'cli_0123456789abcdef';
    commitAndRestart(app, 'ou_first'); poll();
    await until(() => field('lark-app-id').value === app && !button('lark-qr-start').disabled, 'The page stayed unconfigured after the committed service restart');
    assert.equal(field('lark-recipient').value, 'ou_first');
    assert.equal(element('lark-type-personal').getAttribute('aria-pressed'), 'true');
    assert.equal(element('lark-current-title').textContent, 'Feishu personal app');
    assert.equal(element('lark-registration').hidden, true);
    assert.equal(element('lark-registration-qr').querySelector('img'), null);
  });
  await t.test('a transient settings failure after idle keeps reconciliation alive until the new app is loaded', async () => {
    button('lark-qr-start').click();
    await until(() => !element('lark-registration').hidden && !!element('lark-registration-qr').querySelector('img'), 'Replacement QR did not render');
    const app = 'cli_fedcba9876543210';
    commitAndRestart(app, 'ou_replacement'); failedSettingsReads = 1;
    const before = settingsReads; poll();
    await until(() => settingsReads > before && failedSettingsReads === 0, 'The restarted service did not request saved settings');
    await nextTurn();
    assert.equal(field('lark-app-id').value, 'cli_0123456789abcdef');
    assert.equal(button('lark-qr-start').disabled, true, 'Do not allow another app setup before reconciliation finishes');
    poll();
    await until(() => field('lark-app-id').value === app && !button('lark-qr-start').disabled, 'Idle stopped the reconciliation retry');
    assert.equal(field('lark-recipient').value, 'ou_replacement');
    assert.equal(element('lark-registration').hidden, true);
    assert.equal(element('settings-banner').hidden, true, 'A successful retry clears only the settings-read error');
  });
  await t.test('a restart before commit dismisses the scan without inventing a new connection', async () => {
    button('lark-qr-start').click();
    await until(() => !element('lark-registration').hidden && !!element('lark-registration-qr').querySelector('img'), 'New QR did not render');
    const before = settingsReads; flow = { status: 'idle' }; poll();
    await until(() => settingsReads > before && element('lark-registration').hidden && !button('lark-qr-start').disabled, 'The uncommitted scan did not reconcile');
    assert.equal(field('lark-app-id').value, 'cli_fedcba9876543210');
    assert.equal(field('lark-recipient').value, 'ou_replacement');
  });
  await t.test('normal completion and Done still refresh settings without clearing the saved connection', async () => {
    button('lark-qr-start').click();
    await until(() => !element('lark-registration').hidden && !!element('lark-registration-qr').querySelector('img'), 'Final QR did not render');
    const app = 'cli_0011223344556677';
    commitAndRestart(app, 'ou_normal');
    flow = { status: 'complete', app_id: app, setup: { app_id: app, status: 'ready', missing: [], mention_only: false } }; poll();
    await until(() => field('lark-app-id').value === app && !button('lark-registration-cancel').disabled, 'Normal completion did not reconcile');
    assert.equal(field('lark-recipient').value, 'ou_normal');
    assert.equal(element('lark-registration-title').textContent, 'App saved');
    button('lark-registration-cancel').click();
    await until(() => element('lark-registration').hidden && !button('lark-qr-start').disabled, 'Done did not dismiss the flow');
    assert.equal(field('lark-app-id').value, app); assert.equal(field('lark-recipient').value, 'ou_normal');
  });
  await nextTurn();
});
