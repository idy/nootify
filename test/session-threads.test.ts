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
