import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AgentPrompts, type AgentId } from '../src/agents.js';
import { sessionThreadDiscovery } from '../src/session-threads.js';
import { LarkThreadSync } from '../src/lark-thread-sync.js';
import { LarkThreads } from '../src/lark-threads.js';
import { State } from '../src/state.js';
import type { ThreadRequest } from '../src/types.js';

async function collect(discover: ReturnType<typeof sessionThreadDiscovery>): Promise<ThreadRequest[]> {
  const found: ThreadRequest[] = [];
  for await (const session of discover(new AbortController().signal)) found.push(session);
  return found;
}

for (const adapter of ['codex', 'trae'] as const) {
  test(`${adapter} bound catalogs avoid per-session prompt reads while pending and foreign-app bindings are repaired`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nootify-bound-scan-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = await State.open(join(root, 'state')); state.settings.lark_recipient_open_id = 'ou_owner';
    const files = Object.fromEntries(['claude', 'codex', 'opencode', 'trae', 'workbuddy'].map(agent => [agent, join(root, agent, 'rules.md')])) as Record<AgentId, string>;
    const agents = new AgentPrompts({ stateDir: state.directory, port: 9417, files }); await agents.set(adapter, true);
    const ids = Array.from({ length: 128 }, (_, index) => `session-${index}`);
    if (adapter === 'codex') {
      const db = new DatabaseSync(join(root, 'codex/state_5.sqlite'));
      db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, archived INTEGER); BEGIN');
      const put = db.prepare('INSERT INTO threads VALUES (?, ?, ?, 0)');
      for (const id of ids) put.run(id, '/work', id);
      db.exec('COMMIT'); db.close();
    } else {
      for (const id of ids) state.sessions.set(id, { host_id: hostname(), adapter, session_id: id, session_name: id });
    }
    for (const [index, id] of ids.entries()) state.bindings.set(`oc_${index}`, {
      chat_id: `oc_${index}`, app_id: index === 127 ? 'cli_foreign' : 'cli_current', adapter,
      session_id: id, sender_open_id: 'ou_owner', ...(index === 126 ? { announcement_pending: true } : {}),
    });
    await state.save(); const saved = await State.open(state.directory);
    const threads = new LarkThreads(saved, { appId: 'cli_current', async request() { throw new Error('Unexpected provider call'); } });
    const list = t.mock.method(agents, 'list', agents.list.bind(agents));
    const open = t.mock.method(threads, 'open', async (...args: Parameters<LarkThreads['open']>) => {
      const [kind, id, name] = args; const previous = threads.binding(id, kind);
      const chat_id = previous?.chat_id ?? `oc_current_${id}`;
      saved.bindings.set(chat_id, { chat_id, app_id: 'cli_current', adapter: kind, session_id: id, session_name: name, sender_open_id: 'ou_owner' });
      await saved.save();
      return { channel: 'feishu' as const, adapter: kind, session_id: id, session_name: name, chat_id, created: !previous };
    });
    const sync = new LarkThreadSync({ state: saved, threads, report: () => {}, discover: sessionThreadDiscovery(agents, saved, () => {}, { codexHome: join(root, 'codex') }) });
    await sync.reconcile();
    assert.deepEqual(open.mock.calls.map(call => call.arguments[1]).sort(), ['session-126', 'session-127']);
    assert.equal(list.mock.callCount(), 3, 'one enrollment snapshot plus only the two necessary opens');
    assert.equal(saved.bindings.get('oc_127')?.app_id, 'cli_foreign');
    assert.equal(threads.binding('session-126', adapter)?.announcement_pending, undefined);
    assert.equal(threads.binding('session-127', adapter)?.app_id, 'cli_current');
    list.mock.resetCalls(); open.mock.resetCalls();
    await sync.reconcile();
    assert.equal(list.mock.callCount(), 1, 'an entirely bound catalog reads the prompt set only once');
    assert.equal(open.mock.callCount(), 0);
  });
}

test('enabled agents backfill old local identities without transcript reads or archived conversations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nootify-thread-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await State.open(join(root, 'state'));
  const files = Object.fromEntries(['claude', 'codex', 'opencode', 'trae', 'workbuddy'].map(agent => [agent, join(root, agent, 'rules.md')])) as Record<AgentId, string>;
  const agents = new AgentPrompts({ stateDir: state.directory, port: 9417, files });
  for (const agent of ['claude', 'codex', 'opencode', 'trae', 'workbuddy'] as AgentId[]) await agents.set(agent, true);
  const desktop = join(root, 'desktop/account/profile'); await mkdir(desktop, { recursive: true });
  for (const [id, archived] of [['local_open', false], ['local_archived', true], ['local_unknown', undefined]] as const) {
    await writeFile(join(desktop, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: `cli_${id}`, title: id, isArchived: archived }));
  }
  const projects = join(root, 'claude/projects/project'); await mkdir(projects, { recursive: true });
  for (const id of ['cli_local_open', 'cli_local_archived', 'cli_local_unknown', 'standalone']) {
    await writeFile(join(projects, `${id}.jsonl`), JSON.stringify({ type: 'custom-title', customTitle: 'Transcript title must not be read' }));
  }
  const codex = join(root, 'codex'); const db = new DatabaseSync(join(codex, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, archived INTEGER);
    INSERT INTO threads VALUES ('codex_open', '/work', 'Old Codex', 0), ('codex_archived', '/work', 'Archived', 1), ('codex_unknown', '/work', 'Unknown', NULL)`); db.close();
  const opencode = join(root, 'opencode'); const openDb = new DatabaseSync(join(opencode, 'opencode.db'));
  openDb.exec(`CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_archived INTEGER);
    INSERT INTO session VALUES ('ses_open', '/work', 'Old OpenCode', NULL), ('ses_archived', '/work', 'Archived', 1700000000000)`); openDb.close();
  state.sessions.set('trae_local', { host_id: hostname(), adapter: 'trae', session_id: 'trae_local', session_name: 'Trae' });
  state.sessions.set('workbuddy_remote', { host_id: 'another-host', adapter: 'workbuddy', session_id: 'workbuddy_remote', session_name: 'Remote' });
  const reports: Record<string, unknown>[] = [];
  const discover = sessionThreadDiscovery(agents, state, record => reports.push(record), {
    claudeDir: join(root, 'claude'), desktopRoots: [join(root, 'desktop')], codexHome: codex, opencodeData: opencode,
  });
  const found = await collect(discover);
  assert.deepEqual(found.map(item => item.session_id).sort(), ['codex_open', 'local_open', 'ses_open', 'standalone', 'trae_local']);
  assert.equal(found.find(item => item.session_id === 'standalone')?.session_name, 'standalone');
  assert.equal(found.find(item => item.session_id === 'codex_open')?.session_name, 'Old Codex');
  assert.equal(reports.length, 0);
  await agents.set('codex', false); await agents.set('claude', false);
  assert.deepEqual((await collect(discover)).map(item => item.session_id).sort(), ['ses_open', 'trae_local']);
  // A broken client catalog must not hide the remaining clients.
  await writeFile(join(opencode, 'opencode.db'), 'broken database');
  assert.deepEqual((await collect(discover)).map(item => item.session_id), ['trae_local']);
  assert.equal(reports.at(-1)?.status, 'lark_discovery_failed');
});

test('a failed Desktop catalog defers CLI aliases until identities can be read again', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nootify-desktop-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await State.open(join(root, 'state'));
  const files = Object.fromEntries(['claude', 'codex', 'opencode', 'trae', 'workbuddy'].map(agent => [agent, join(root, agent, 'rules.md')])) as Record<AgentId, string>;
  const agents = new AgentPrompts({ stateDir: state.directory, port: 9417, files });
  await agents.set('claude', true); await agents.set('codex', true);
  const desktop = join(root, 'desktop/account/profile'); await mkdir(desktop, { recursive: true });
  await writeFile(join(desktop, 'local_archived.json'), JSON.stringify({ sessionId: 'local_archived', cliSessionId: 'desktop-cli-id', isArchived: true }));
  const projects = join(root, 'claude/projects/project'); await mkdir(projects, { recursive: true });
  for (const id of ['desktop-cli-id', 'standalone']) await writeFile(join(projects, `${id}.jsonl`), '{}\n');
  const codexHome = join(root, 'codex'); const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  db.exec("CREATE TABLE threads (id TEXT, cwd TEXT, archived INTEGER); INSERT INTO threads VALUES ('codex_open', '/work', 0)"); db.close();
  // NUL produces a deterministic catalog-read error on both macOS and Windows.
  const sources = { claudeDir: join(root, 'claude'), desktopRoots: [join(root, 'desktop'), `${root}\0`], codexHome };
  const reports: Record<string, unknown>[] = [];
  const discover = sessionThreadDiscovery(agents, state, record => reports.push(record), sources);
  assert.deepEqual((await collect(discover)).map(item => item.session_id), ['codex_open']);
  assert.ok(reports.some(record => String(record.error).startsWith('Claude Desktop session metadata could not be read:')));
  sources.desktopRoots.pop(); reports.length = 0;
  assert.deepEqual((await collect(discover)).map(item => item.session_id).sort(), ['codex_open', 'standalone']);
  assert.equal(reports.length, 0);
});

test('legacy and nested sidechain transcripts are excluded while an absent Desktop installation permits its parent CLI session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nootify-cli-sidechains-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await State.open(join(root, 'state'));
  const files = Object.fromEntries(['claude', 'codex', 'opencode', 'trae', 'workbuddy'].map(agent => [agent, join(root, agent, 'rules.md')])) as Record<AgentId, string>;
  const agents = new AgentPrompts({ stateDir: state.directory, port: 9417, files }); await agents.set('claude', true);
  const parent = '12345678-1234-4234-8234-123456789abc';
  const project = join(root, 'claude/projects/project'); await mkdir(project, { recursive: true });
  for (const id of [parent, 'agent-a1b2c3d4', 'AGENT-b1c2d3e4']) {
    await writeFile(join(project, `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: parent, isSidechain: id !== parent }) + '\n');
  }
  const nested = join(project, parent, 'subagents'); await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'agent-nested.jsonl'), JSON.stringify({ sessionId: parent, isSidechain: true }));
  const reports: Record<string, unknown>[] = [];
  const discover = sessionThreadDiscovery(agents, state, record => reports.push(record), {
    claudeDir: join(root, 'claude'), desktopRoots: [join(root, 'not-installed')],
  });
  assert.deepEqual((await collect(discover)).map(item => [item.adapter, item.session_id]), [['claude-code', parent]]);
  assert.equal(reports.length, 0);
});

for (const obstruction of ['catalog-root', 'catalog-parent'] as const) {
  test(`a file at the Desktop ${obstruction} defers CLI enrollment until directory recovery`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nootify-desktop-nondirectory-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = await State.open(join(root, 'state'));
    const files = Object.fromEntries(['claude', 'codex', 'opencode', 'trae', 'workbuddy'].map(agent => [agent, join(root, agent, 'rules.md')])) as Record<AgentId, string>;
    const agents = new AgentPrompts({ stateDir: state.directory, port: 9417, files }); await agents.set('claude', true);
    const healthy = join(root, 'healthy/account/profile'); await mkdir(healthy, { recursive: true });
    await writeFile(join(healthy, 'local_active.json'), JSON.stringify({ sessionId: 'local_active', cliSessionId: 'cli_active', isArchived: false }));
    const blocked = join(root, 'blocked'); await writeFile(blocked, 'not a directory');
    const catalog = obstruction === 'catalog-root' ? blocked : join(blocked, 'sessions');
    const project = join(root, 'claude/projects/project'); await mkdir(project, { recursive: true });
    for (const id of ['cli_active', 'cli_archived', 'standalone']) await writeFile(join(project, `${id}.jsonl`), '{}\n');
    const reports: Record<string, unknown>[] = [];
    const discover = sessionThreadDiscovery(agents, state, record => reports.push(record), {
      claudeDir: join(root, 'claude'), desktopRoots: [join(root, 'healthy'), catalog, join(root, 'not-installed')],
    });
    assert.deepEqual((await collect(discover)).map(item => [item.adapter, item.session_id]), [['claude-desktop', 'local_active']]);
    assert.equal(reports.length, 1); assert.match(String(reports[0].error), /Desktop session metadata is incomplete/);
    await rm(blocked); const recovered = join(catalog, 'account/profile'); await mkdir(recovered, { recursive: true });
    await writeFile(join(recovered, 'local_archived.json'), JSON.stringify({ sessionId: 'local_archived', cliSessionId: 'cli_archived', isArchived: true }));
    reports.length = 0;
    assert.deepEqual((await collect(discover)).map(item => item.session_id).sort(), ['local_active', 'standalone']);
    assert.equal(reports.length, 0);
  });
}

for (const broken of [false, true]) {
  test(`a ${broken ? 'broken redirected Desktop root defers CLI enrollment' : 'working redirected ancestor permits an absent Desktop installation'} and recovers cleanly`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nootify-desktop-redirect-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = await State.open(join(root, 'state'));
    const files = Object.fromEntries(['claude', 'codex', 'opencode', 'trae', 'workbuddy'].map(agent => [agent, join(root, agent, 'rules.md')])) as Record<AgentId, string>;
    const agents = new AgentPrompts({ stateDir: state.directory, port: 9417, files }); await agents.set('claude', true);
    const project = join(root, 'claude/projects/project'); await mkdir(project, { recursive: true });
    await writeFile(join(project, 'standalone.jsonl'), '{}\n');
    const target = join(root, 'target'); const redirected = join(root, 'redirected'); await mkdir(target);
    await symlink(target, redirected, process.platform === 'win32' ? 'junction' : 'dir');
    if (broken) await rm(target, { recursive: true });
    const sources = { claudeDir: join(root, 'claude'), desktopRoots: [broken ? redirected : join(redirected, 'not-installed')] };
    const reports: Record<string, unknown>[] = [];
    const discover = sessionThreadDiscovery(agents, state, record => reports.push(record), sources);
    assert.deepEqual((await collect(discover)).map(item => item.session_id), broken ? [] : ['standalone']);
    assert.equal(reports.length, broken ? 1 : 0);
    const profile = join(target, 'account/profile'); await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'local_archived.json'), JSON.stringify({ sessionId: 'local_archived', cliSessionId: 'standalone', isArchived: true }));
    sources.desktopRoots[0] = redirected; reports.length = 0;
    assert.deepEqual(await collect(discover), []);
    assert.equal(reports.length, 0);
  });
}

for (const corruption of ['truncated', 'oversized', 'wrong-identity', 'non-file'] as const) {
  test(`a partial Desktop catalog with ${corruption} metadata preserves known Desktop sessions and defers CLI aliases`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nootify-partial-desktop-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = await State.open(join(root, 'state'));
    const files = Object.fromEntries(['claude', 'codex', 'opencode', 'trae', 'workbuddy'].map(agent => [agent, join(root, agent, 'rules.md')])) as Record<AgentId, string>;
    const agents = new AgentPrompts({ stateDir: state.directory, port: 9417, files }); await agents.set('claude', true);
    const desktop = join(root, 'desktop/account/profile'); await mkdir(desktop, { recursive: true });
    await writeFile(join(desktop, 'local_active.json'), JSON.stringify({ sessionId: 'local_active', cliSessionId: 'cli_active', isArchived: false }));
    const archived = { sessionId: 'local_archived', cliSessionId: 'cli_archived', isArchived: true };
    const broken = corruption === 'truncated' ? JSON.stringify(archived).slice(0, -1)
      : corruption === 'oversized' ? JSON.stringify({ ...archived, padding: 'x'.repeat(1024 * 1024) })
      : JSON.stringify({ ...archived, sessionId: 'local_mismatch' });
    const file = join(desktop, 'local_archived.json');
    if (corruption === 'non-file') await mkdir(file);
    else await writeFile(file, broken);
    const projects = join(root, 'claude/projects/project'); await mkdir(projects, { recursive: true });
    for (const id of ['cli_active', 'cli_archived', 'standalone']) await writeFile(join(projects, `${id}.jsonl`), '{}\n');
    const reports: Record<string, unknown>[] = [];
    const discover = sessionThreadDiscovery(agents, state, record => reports.push(record), {
      claudeDir: join(root, 'claude'), desktopRoots: [join(root, 'desktop')],
    });
    assert.deepEqual((await collect(discover)).map(item => [item.adapter, item.session_id]), [['claude-desktop', 'local_active']]);
    assert.equal(reports.length, 1);
    assert.match(String(reports[0].error), /Claude Desktop session metadata is incomplete/);
    await rm(file, { recursive: true });
    await writeFile(file, JSON.stringify(archived)); reports.length = 0;
    const recovered = await collect(discover);
    assert.deepEqual(recovered.map(item => item.session_id).sort(), ['local_active', 'standalone']);
    assert.equal(recovered.find(item => item.session_id === 'local_active')?.adapter, 'claude-desktop');
    assert.equal(reports.length, 0);
  });
}

for (const agent of ['opencode', 'trae'] as const) {
  test(`disabling ${agent} during discovery stops its remaining native or cooperative candidates`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nootify-enrollment-change-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = await State.open(join(root, 'state'));
    const files = Object.fromEntries(['claude', 'codex', 'opencode', 'trae', 'workbuddy'].map(id => [id, join(root, id, 'rules.md')])) as Record<AgentId, string>;
    const agents = new AgentPrompts({ stateDir: state.directory, port: 9417, files }); await agents.set(agent, true);
    const opencodeData = join(root, 'opencode');
    if (agent === 'opencode') {
      const directory = join(opencodeData, 'storage/session/project'); await mkdir(directory, { recursive: true });
      for (const id of ['ses_one', 'ses_two']) await writeFile(join(directory, `${id}.json`), JSON.stringify({ id, time: {} }));
    } else {
      for (const id of ['trae_one', 'trae_two']) state.sessions.set(id, { host_id: hostname(), adapter: 'trae', session_id: id, session_name: id });
    }
    const discover = sessionThreadDiscovery(agents, state, () => {}, { opencodeData });
    const iterator = discover(new AbortController().signal)[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).done, false);
    await agents.set(agent, false);
    assert.equal((await iterator.next()).done, true);
    await agents.set(agent, true);
    assert.equal((await collect(discover)).length, 2, 'reenrollment is picked up by the next scan');
  });
}

test('legacy OpenCode archive metadata is respected when backfilling groups', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nootify-opencode-threads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await State.open(join(root, 'state'));
  const agents = new AgentPrompts({ stateDir: state.directory, port: 9417, files: { opencode: join(root, 'rules/AGENTS.md') } });
  await agents.set('opencode', true);
  const data = join(root, 'opencode/storage/session/project'); await mkdir(data, { recursive: true });
  await writeFile(join(data, 'ses_open.json'), JSON.stringify({ id: 'ses_open', title: 'Old conversation', time: {} }));
  await writeFile(join(data, 'ses_archived.json'), JSON.stringify({ id: 'ses_archived', time: { archived: 1700000000000 } }));
  const discover = sessionThreadDiscovery(agents, state, () => {}, { opencodeData: join(root, 'opencode') });
  assert.deepEqual((await collect(discover)).map(item => item.session_id), ['ses_open']);
});
