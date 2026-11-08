import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { LogEntry } from '../src/events.js';

async function until(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await nextTurn(); }
  throw new Error(message);
}

test('Logs separates event purpose from delivery outcome and keeps its controls working', async t => {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const { window, document } = parseHTML(html);
  const globals: Record<string, unknown> = {
    window, document, Element: window.Element, HTMLElement: window.HTMLElement,
    navigator: { languages: ['en-US'], language: 'en-US' },
    location: new URL('http://127.0.0.1:9417/#/logs'),
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0, matchMedia: () => ({ matches: false }),
    CSS: { escape: (value: string) => value },
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  // Supply browser selection and focus behavior that linkedom does not implement.
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
  const timers: { run: () => void; milliseconds: number }[] = [];
  t.mock.method(globalThis, 'setInterval', ((run: () => void, milliseconds: number) => {
    timers.push({ run, milliseconds }); return {} as NodeJS.Timeout;
  }) as typeof globalThis.setInterval);

  const event = (id: string, status: string, fields: Partial<LogEntry> = {}): LogEntry => ({
    id, status, time: '2026-11-08T10:30:00.000Z', session_id: 'session-1', ...fields,
  });
  let logs = [
    event('progress-feishu', 'thread_message', { source: 'lark', preview: '<strong>Progress body</strong>', message_id: 'om_progress' }),
    event('progress-build', 'thread_message', { source: 'lark', session_id: 'session-2', session_name: 'Windows packaging', preview: 'Build completed' }),
    event('reply', 'replied', { source: 'lark', preview: 'Reply to the user', reply_id: 'reply-1' }),
    event('received', 'received', { source: 'lark', message_id: 'om_user-1', preview: 'Please fix indexing' }),
    event('forwarded', 'input_accepted', { source: 'lark', message_id: 'om_user-1' }),
    event('queued', 'inbox_queued', { source: 'lark', session_id: 'session-3' }),
    event('receipt', 'session_acknowledged', { source: 'lark', message_id: 'om_user-1' }),
    event('ignored', 'ignored', { source: 'lark', reason: 'sender_not_allowed', preview: 'Untrusted input' }),
    event('delivery-failed', 'delivery_failed', { source: 'lark', error: 'Synthetic delivery failure' }),
    event('progress-failed', 'thread_failed', { source: 'lark', error: 'Synthetic progress failure' }),
    event('unconfirmed', 'delivery_unconfirmed', { source: 'lark' }),
    event('rejected', 'input_accepted', { source: 'lark', reason: 'input_rejected' }),
    event('queue-full', 'queue_full', { source: 'lark' }),
    event('connection', 'lark_ready', { session_id: undefined }),
    event('system', 'future_system_event', { source: 'archived-provider', session_id: undefined, preview: 'A future service event' }),
  ];
  const agents = [['claude', 'Claude'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['trae', 'Trae'], ['workbuddy', 'WorkBuddy']].map(([agent, name]) => ({
    agent, name, file: `/fixture/${agent}/instructions`, injected: false, status: 'absent', block: `Feishu instructions for ${name}`,
  }));
  let channel: { name: 'feishu'; configured: boolean; recipient?: string; groups: number } | undefined = { name: 'feishu', configured: true, recipient: 'ou_fixture', groups: 2 };
  let editable = true;
  const agentWrites: { agent: string; enabled: boolean }[] = [];
  let reads = 0; let agentReads = 0;
  let releaseAgentReads!: () => void;
  const agentsReady = new Promise<void>(resolve => { releaseAgentReads = resolve; });
  let agentsUnavailable = false; let agentsEmpty = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), 'http://127.0.0.1:9417').pathname;
    if (path === '/ui/api/snapshot') {
      reads++;
      return Response.json({ time: '2026-11-08T10:31:00.000Z', modules: [], logs,
        sessions: [{ session_id: 'session-1', session_name: 'SQLite recovery', adapter: 'codex', host_id: 'fixture-host' }] });
    }
    if (path === '/ui/api/agents') {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { agent: string; enabled: boolean };
        agentWrites.push(body);
        const agent = agents.find(agent => agent.agent === body.agent)!;
        agent.injected = body.enabled; agent.status = body.enabled ? 'current' : 'absent';
        return Response.json({ ok: true });
      }
      agentReads++;
      await agentsReady;
      if (agentsUnavailable) return Response.json({ error: 'Unavailable fixture' }, { status: 503 });
      return Response.json({ agents: agentsEmpty ? [] : agents, editable, ...(channel ? { channel } : {}) });
    }
    assert.fail(`Unexpected UI request: ${path}`);
  });
  const element = (id: string) => document.getElementById(id)! as unknown as HTMLElement;
  const field = (id: string) => element(id) as HTMLInputElement;
  const row = (id: string) => document.querySelector<HTMLButtonElement>(`#logs-table [data-key="${id}"]`)!;
  const text = (id: string, selector: string) => row(id).querySelector(selector)!.textContent;
  const ids = () => [...document.querySelectorAll<HTMLElement>('#logs-table .log-row')].map(item => item.dataset.key!);
  const tab = (value: string) => document.querySelector<HTMLButtonElement>(`#outcome-tabs [data-value="${value}"]`)!;
  const search = (query: string) => { field('search').value = query; field('search').dispatchEvent(new window.Event('input', { bubbles: true })); };
  await import('../src/ui-app.js');
  await until(() => ids().length === 15, 'Initial Logs fixture did not render');

  await t.test('Agents hides its card while loading, unavailable or empty, then restores it on retry', async () => {
    location.hash = '#/agents'; window.dispatchEvent(new window.Event('hashchange'));
    assert.equal(element('agents-card').hidden, true, 'An unfilled card must not show a border strip');
    agentsUnavailable = true; releaseAgentReads();
    await until(() => element('agents-banner').textContent!.includes('HTTP 503'), 'Agent load failure did not render');
    assert.equal(element('agents-card').hidden, true);
    assert.equal(element('channel-settings').getAttribute('href'), '#/settings/lark');

    const refresh = async () => {
      const before = agentReads; element('refresh').click();
      await until(() => agentReads > before, 'Agent request did not retry');
      await nextTurn();
    };
    agentsUnavailable = false; agentsEmpty = true; await refresh();
    assert.equal(element('agents-card').hidden, true, 'An empty response must not show a border strip');
    assert.equal(element('agents-banner').hidden, true, 'Retry clears the previous load error');
    agentsEmpty = false; await refresh();
    assert.equal(element('agents-card').hidden, false);
    assert.equal(document.querySelectorAll('#agent-rows .check').length, 5);
    assert.equal(element('agents-card').contains(element('channel-title')), false, 'The summary stays outside the card');
    location.hash = '#/logs'; window.dispatchEvent(new window.Event('hashchange'));
  });

  await t.test('one row contains a message-type label, subject title and action on the right without subtitles', () => {
    assert.equal(text('progress-feishu', '.log-type'), 'Progress');
    assert.equal(row('progress-feishu').querySelector<HTMLElement>('.log-type')!.dataset.type, 'progress');
    assert.equal(text('progress-feishu', '.log-subject'), '<strong>Progress body</strong>');
    assert.equal(row('progress-feishu').querySelector('strong'), null, 'User content must stay plain text');
    assert.equal(text('progress-feishu', '.log-action'), 'Sent');
    assert.equal(text('reply', '.log-type'), 'Replies');
    assert.equal(text('reply', '.log-subject'), 'Reply to the user');
    assert.equal(text('reply', '.log-action'), 'Replied');
    assert.equal(text('received', '.log-type'), 'User messages');
    assert.equal(text('queued', '.log-subject'), 'session-3', 'Missing content falls back to the session topic');
    assert.equal(text('connection', '.log-type'), 'System');
    for (const id of ids()) {
      const children = row(id).children;
      assert.ok(children[0].classList.contains('log-type'));
      assert.ok(children[1].classList.contains('log-subject'));
      assert.equal(children[2].className, 'log-action');
      assert.ok(children[3].classList.contains('chevron'));
      assert.equal(row(id).querySelector('.row-meta, .row-side, .secondary, .log-context'), null);
    }
    assert.equal(element('logs-count').textContent, '15');
    assert.equal(element('logs-count').title, '15 log entries');
  });

  await t.test('actions describe real stages and use the same presentation for success, receipt, ignores and failure', () => {
    assert.equal(text('received', '.log-action'), 'Received');
    assert.equal(text('forwarded', '.log-action'), 'Forwarded');
    assert.equal(text('queued', '.log-action'), 'Queued');
    assert.equal(text('receipt', '.log-action'), 'Acknowledged');
    assert.equal(text('unconfirmed', '.log-action'), 'Unconfirmed');
    assert.equal(text('rejected', '.log-action'), 'Failed');
    assert.equal(text('ignored', '.log-action'), 'Ignored');
    assert.equal(text('ignored', '.log-type'), 'User messages', 'Ignored is an action, not a message type');
    assert.equal(text('progress-failed', '.log-type'), 'Progress', 'A failure keeps its original message type');
    assert.equal(text('ignored', '.log-subject'), 'Untrusted input');
    for (const id of ids()) assert.equal(row(id).querySelector('.log-action')!.className, 'log-action');
  });

  await t.test('purpose filters expose incoming, progress, replies, system, ignores and failures separately', () => {
    tab('progress').click(); assert.deepEqual(ids(), ['progress-feishu', 'progress-build', 'progress-failed']);
    assert.equal(tab('progress').getAttribute('aria-pressed'), 'true');
    assert.equal(tab('progress').querySelector('.count')!.textContent, '3');
    tab('reply').click(); assert.deepEqual(ids(), ['reply']);
    tab('incoming').click(); assert.deepEqual(ids(), ['received', 'forwarded', 'queued', 'receipt', 'ignored', 'delivery-failed', 'unconfirmed', 'rejected', 'queue-full']);
    tab('system').click(); assert.deepEqual(ids(), ['connection', 'system']);
    tab('ignored').click(); assert.deepEqual(ids(), ['ignored']);
    tab('error').click(); assert.deepEqual(ids(), ['delivery-failed', 'progress-failed', 'unconfirmed', 'rejected', 'queue-full']);
    tab('all').click(); assert.equal(ids().length, 15);
  });

  await t.test('search includes content, session names, identifiers and translated source names with useful counts', () => {
    search('WINDOWS'); assert.deepEqual(ids(), ['progress-build']);
    assert.equal(tab('all').querySelector('.count')!.textContent, '1');
    assert.equal(tab('progress').querySelector('.count')!.textContent, '1');
    assert.equal(tab('reply').querySelector('.count')!.textContent, '0');
    search('om_user-1'); assert.deepEqual(ids(), ['received', 'forwarded', 'receipt']);
    search('Feishu'); assert.ok(ids().includes('progress-feishu')); assert.ok(ids().includes('progress-build')); assert.ok(!ids().includes('system'));
    search('SQLite recovery'); assert.ok(ids().includes('forwarded')); assert.ok(!ids().includes('progress-build'));
    search('Please fix indexing'); assert.deepEqual(ids(), ['received']);
    search('no-matching-fixture'); assert.deepEqual(ids(), []); assert.equal(element('empty').hidden, false);
    search(''); assert.equal(element('empty').hidden, true);
  });

  await t.test('button expansion preserves focus and exposes human explanation alongside raw fields', () => {
    row('progress-feishu').focus();
    row('progress-feishu').click();
    const expanded = row('progress-feishu');
    assert.equal(expanded.type, 'button');
    assert.equal(expanded.getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, expanded);
    const details = document.getElementById(expanded.getAttribute('aria-controls')!)!;
    assert.ok(details);
    assert.match(details.textContent!, /What happenedProgress sent/);
    assert.match(details.textContent!, /DirectionCodex → Feishu/);
    assert.match(details.textContent!, /thread_message/);
    assert.match(details.textContent!, /om_progress/);
    assert.match(details.textContent!, /<strong>Progress body<\/strong>/);
    expanded.click(); assert.equal(row('progress-feishu').getAttribute('aria-expanded'), 'false');
    row('system').click();
    const archivedDetails = document.getElementById(row('system').getAttribute('aria-controls')!)!;
    assert.match(archivedDetails.textContent!, /Sourcesarchived-provider/);
    assert.match(archivedDetails.textContent!, /Directionarchived-provider/);
    assert.match(archivedDetails.textContent!, /future_system_event/);
    row('system').click();
  });

  await t.test('pause freezes rows until resumed and export retains the current search and purpose filter', async () => {
    element('pause').click();
    assert.equal(element('pause').getAttribute('aria-pressed'), 'true');
    logs = [event('new-progress', 'thread_message', { source: 'lark', preview: 'A later update' }), ...logs];
    const before = reads;
    timers.find(timer => timer.milliseconds === 2000)!.run();
    await until(() => reads > before, 'Paused snapshot did not refresh');
    await nextTurn();
    assert.equal(ids().length, 15);
    element('pause').click(); assert.equal(ids().length, 16);
    tab('progress').click(); search('Build completed');
    let exported: Blob | undefined; let download = '';
    t.mock.method(URL, 'createObjectURL', (blob: Blob) => { exported = blob; return 'blob:logs-fixture'; });
    t.mock.method(URL, 'revokeObjectURL', () => {});
    t.mock.method(window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { download = this.download; });
    element('export').click();
    assert.match(download, /^nootify-logs-\d{4}-\d{2}-\d{2}\.ndjson$/);
    assert.ok(exported);
    const entries = (await exported.text()).trim().split('\n').map(line => JSON.parse(line) as LogEntry);
    assert.deepEqual(entries.map(entry => entry.id), ['progress-build']);
    assert.equal(entries[0].status, 'thread_message');
    search(''); tab('all').click();
  });

  await t.test('changing language translates event purposes, directions and receipts without touching user content', () => {
    field('language').value = 'zh-CN'; field('language').dispatchEvent(new window.Event('change'));
    assert.equal(text('progress-feishu', '.log-type'), '会话进度');
    assert.equal(text('progress-feishu', '.log-action'), '已发送');
    assert.equal(text('receipt', '.log-action'), '已确认');
    assert.equal(text('forwarded', '.log-action'), '已转发');
    assert.equal(tab('progress').querySelector('span')!.textContent, '会话进度');
    assert.equal(text('progress-feishu', '.log-subject'), '<strong>Progress body</strong>');
    assert.match(element('logs-view').querySelector('.hint')!.textContent!, /发送成功不代表已读/);
    field('language').value = 'en'; field('language').dispatchEvent(new window.Event('change'));
    assert.equal(text('progress-feishu', '.log-action'), 'Sent');
    assert.match(element('logs-view').querySelector('.hint')!.textContent!, /Sent does not mean read/);
  });

  await t.test('Agents uses a fixed Feishu status card and keeps every agent adapter editable', async () => {
    location.hash = '#/agents'; window.dispatchEvent(new window.Event('hashchange'));
    await until(() => document.querySelectorAll('#agent-rows .check').length === 5, 'Agent fixtures did not render');
    assert.equal(element('channel-title').textContent, 'Feishu notifications');
    assert.equal(element('channel-state').textContent, 'Configured');
    assert.equal(element('channel-sub').textContent, 'Recipient ou_fixture · Groups bound: 2');
    assert.equal(element('channel-settings').getAttribute('href'), '#/settings/lark');
    assert.equal(element('channel-settings').textContent, 'Configure Feishu');
    assert.equal(document.querySelector('#notification-channel, #channel-save, #agents-view select'), null);
    for (const agent of agents) {
      const before = agentReads;
      const checkbox = document.querySelector<HTMLInputElement>(`#agent-rows [data-key="${agent.agent}"]`)!;
      assert.equal(checkbox.disabled, false);
      assert.equal(checkbox.getAttribute('aria-label'), `Add Feishu instructions to ${agent.name}`);
      checkbox.checked = true; checkbox.dispatchEvent(new window.Event('change'));
      await until(() => agentReads > before, `${agent.name} did not refresh after enabling`);
      await nextTurn();
      assert.deepEqual(agentWrites.at(-1), { agent: agent.agent, enabled: true });
      assert.equal(document.querySelector<HTMLInputElement>(`#agent-rows [data-key="${agent.agent}"]`)!.checked, true);
    }
    assert.match(element('agent-rows').textContent!, /The conversation must check for replies/);
    field('language').value = 'zh-CN'; field('language').dispatchEvent(new window.Event('change'));
    assert.equal(element('channel-title').textContent, '飞书通知');
    assert.equal(element('channel-state').textContent, '已配置');
    assert.equal(element('channel-sub').textContent, '接收人 ou_fixture · 已绑定 2 个群');
    assert.equal(element('channel-settings').textContent, '配置飞书');
    field('language').value = 'en'; field('language').dispatchEvent(new window.Event('change'));
  });

  await t.test('the Feishu card handles missing configuration, recipient, optional summary and read-only access', async () => {
    const refresh = async () => {
      const before = agentReads; element('refresh').click();
      await until(() => agentReads > before, 'Agent summary did not refresh');
      await nextTurn();
    };
    channel = { name: 'feishu', configured: false, groups: 0 }; await refresh();
    assert.equal(element('channel-state').textContent, 'Not configured');
    assert.match(element('channel-sub').textContent!, /Add app credentials under Settings · Feishu/);
    channel = { name: 'feishu', configured: true, groups: 0 }; await refresh();
    assert.equal(element('channel-sub').textContent, 'Add a recipient under Settings · Feishu');
    channel = undefined; await refresh();
    assert.equal(element('channel-title').textContent, 'Feishu notifications');
    assert.equal(element('channel-state').textContent, 'Disabled');
    assert.equal(element('channel-sub').textContent, 'Feishu module is disabled');
    assert.equal(element('channel-settings').getAttribute('href'), '#/settings/lark');
    editable = false; channel = { name: 'feishu', configured: true, recipient: 'ou_fixture', groups: 2 }; await refresh();
    assert.equal(element('agents-banner').textContent, 'Agent instructions are read-only over Tailscale. Edit them on this Mac.');
    assert.ok([...document.querySelectorAll<HTMLInputElement>('#agent-rows .check')].every(checkbox => checkbox.disabled));
  });
});
