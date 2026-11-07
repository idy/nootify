import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AgentPrompts, type AgentId } from '../src/agents.js';
import { sessionThreadDiscovery } from '../src/session-threads.js';
import { State } from '../src/state.js';
import type { ThreadRequest } from '../src/types.js';

async function collect(discover: ReturnType<typeof sessionThreadDiscovery>): Promise<ThreadRequest[]> {
  const found: ThreadRequest[] = [];
  for await (const session of discover(new AbortController().signal)) found.push(session);
  return found;
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
