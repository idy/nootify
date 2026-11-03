import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { conversationDirectories, decodeProjectPath } from '../src/conversations.js';

const encode = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-');

test('Claude transcripts give exact working directories; cleaned-up folders decode their names', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nootify-conv-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'Repos', 'my.repo'); const remembered = join(root, 'Repos', 'side-project');
  await mkdir(repo, { recursive: true }); await mkdir(remembered, { recursive: true });
  const projects = join(root, 'claude', 'projects');
  await mkdir(join(projects, encode(repo)), { recursive: true });
  await writeFile(join(projects, encode(repo), 'a.jsonl'), '{"type":"summary"}\n' + JSON.stringify({ type: 'user', cwd: repo, message: 'private text' }) + '\n');
  await writeFile(join(projects, encode(repo), 'b.jsonl'), JSON.stringify({ cwd: repo }) + '\n');
  await utimes(join(projects, encode(repo), 'b.jsonl'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
  await mkdir(join(projects, encode(remembered), 'memory'), { recursive: true });
  const { directories, warnings } = await conversationDirectories({ claudeDir: join(root, 'claude') });
  assert.deepEqual(warnings, []);
  const byPath = new Map(directories.map(item => [item.directory, item]));
  assert.equal(byPath.get(repo)?.sessions, 2);
  assert.ok(byPath.get(repo)?.lastActive! > '2026-10-02', 'the newest transcript sets the activity time');
  assert.equal(byPath.get(remembered)?.sessions, 0, 'a memory-only folder still names an involved directory');
  assert.ok(!JSON.stringify(directories).includes('private text'));
});

test('project names decode against real entries, preserving hyphens and dots inside segments', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nootify-decode-'))); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'a-b', 'c.d'), { recursive: true });
  assert.equal(await decodeProjectPath('-a-b-c-d', root), join(root, 'a-b', 'c.d'));
  assert.equal(await decodeProjectPath('-a-b-missing', root), undefined);
  assert.equal(await decodeProjectPath('relative', root), undefined);
});

test('Codex and OpenCode databases are read read-only with the columns each version has', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nootify-db-')); t.after(() => rm(root, { recursive: true, force: true }));
  const codex = join(root, 'codex'); await mkdir(codex);
  const old = new DatabaseSync(join(codex, 'state_4.sqlite'));
  old.exec('CREATE TABLE threads (id TEXT, cwd TEXT)'); old.exec("INSERT INTO threads VALUES ('t0', '/old')"); old.close();
  const state = new DatabaseSync(join(codex, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads (id TEXT, cwd TEXT, updated_at INTEGER, git_origin_url TEXT, archived INTEGER)');
  state.exec(`INSERT INTO threads VALUES ('t1', '/work/a', 1793000000, 'https://github.com/viewer/a.git', 0),
    ('t2', '/work/a', 1793100000, NULL, 1), ('t3', '/work/b', 1793050000, NULL, 0), ('t4', 'relative', 1, NULL, 0)`);
  state.close();
  const data = join(root, 'opencode'); await mkdir(data);
  const opencode = new DatabaseSync(join(data, 'opencode.db'));
  opencode.exec('CREATE TABLE session (id TEXT, directory TEXT, time_updated INTEGER)');
  opencode.exec("INSERT INTO session VALUES ('ses_1', '/work/c', 1793000000000), ('ses_2', '/work/c', 1793200000000)");
  opencode.close();
  const { directories } = await conversationDirectories({ codexHome: codex, opencodeData: data });
  const a = directories.find(item => item.directory === '/work/a');
  assert.deepEqual({ ...a }, { directory: '/work/a', agent: 'codex', sessions: 2, lastActive: new Date(1793100000 * 1000).toISOString(), origin: 'https://github.com/viewer/a.git' });
  assert.ok(!directories.some(item => item.directory === '/old' || item.directory === 'relative'), 'only the latest state file and absolute paths');
  const c = directories.find(item => item.directory === '/work/c');
  assert.equal(c?.agent, 'opencode'); assert.equal(c?.sessions, 2); assert.equal(c?.lastActive, new Date(1793200000000).toISOString());
});

test('older OpenCode JSON storage and absent agents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nootify-json-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'opencode', 'storage', 'session', 'project-1'); await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, 'ses_a.json'), JSON.stringify({ id: 'ses_a', directory: '/work/d', time: { created: 1793000000000, updated: 1793000001000 } }));
  await writeFile(join(sessions, 'ses_b.json'), '{"truncated":');
  const found = await conversationDirectories({ claudeDir: join(root, 'none'), codexHome: join(root, 'none'), opencodeData: join(root, 'opencode') });
  assert.deepEqual(found.warnings, []);
  assert.deepEqual(found.directories.map(item => [item.directory, item.agent, item.sessions]), [['/work/d', 'opencode', 1]]);
});
