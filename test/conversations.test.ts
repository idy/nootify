import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { conversationSessions, decodeProjectPath } from '../src/conversations.js';
import { parseGitHubPull } from '../src/github-model.js';

const encode = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-');
async function temporary(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nootify-sessions-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function transcript(root: string, id: string, cwd: string, records: unknown[]): Promise<void> {
  const directory = join(root, 'claude/projects', encode(cwd));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.jsonl`), records.map(value => JSON.stringify(value)).join('\n') + '\n');
}
const link = (sessionId: string, number: number) => ({ type: 'pr-link', sessionId, prRepository: 'team/project', prNumber: number, prUrl: `https://github.com/team/project/pull/${number}` });

test('CLI session IDs retain explicit pr-link events; arbitrary message URLs do not become subscriptions', async t => {
  const root = await temporary(t); const cwd = join(root, 'Repos/my.repo'); await mkdir(cwd, { recursive: true });
  await transcript(root, 'cli-1', cwd, [
    { type: 'custom-title', sessionId: 'cli-1', customTitle: 'Fix login' },
    { type: 'user', sessionId: 'cli-1', cwd, gitBranch: 'fix-login', message: 'private text https://github.com/unrelated/project/pull/99' },
    link('cli-1', 12), link('cli-1', 12), link('another-session', 13),
  ]);
  const { sessions, warnings } = await conversationSessions({ claudeDir: join(root, 'claude') });
  assert.deepEqual(warnings, []); assert.equal(sessions.length, 1);
  assert.deepEqual({ ...sessions[0], lastActive: undefined }, { id: 'cli-1', agent: 'claude', adapter: 'claude-code', title: 'Fix login',
    directory: cwd, directories: [cwd], branch: 'fix-login', lastActive: undefined,
    pulls: [{ repository: 'team/project', number: 12, url: 'https://github.com/team/project/pull/12' }] });
  assert.ok(!JSON.stringify(sessions).includes('private text'));
  await mkdir(join(root, 'claude/projects', encode(join(root, 'only-memory')), 'memory'), { recursive: true });
  assert.equal((await conversationSessions({ claudeDir: join(root, 'claude') })).sessions.length, 1, 'memory folders without session records are not sessions');
});

test('Desktop prs[] and repository anchors join current and previous CLI IDs without duplicate sessions', async t => {
  const root = await temporary(t); const desktop = join(root, 'desktop/account/profile'); await mkdir(desktop, { recursive: true });
  const cwd = join(root, 'deleted-worktree'); const origin = join(root, 'checkout'); const anchor = join(root, 'second-repo');
  const id = 'local_12345678-1234-1234-1234-123456789abc';
  await writeFile(join(desktop, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: 'cli-current', priorCliSessionIds: ['cli-before'], title: 'Session title',
    cwd, originCwd: origin, worktreePath: cwd, branch: 'new-branch', isArchived: false, gitAnchors: [{ gitRoot: anchor }],
    prs: [{ repo: 'team/project', host: 'github.com', provider: 'github', prNumber: 12, url: 'https://github.com/team/project/pull/12', branch: 'old-pr-branch' }] }));
  await transcript(root, 'cli-current', cwd, [{ cwd }, link('cli-current', 99)]);
  await transcript(root, 'cli-before', origin, [{ cwd: origin }, link('cli-before', 98)]);
  const result = await conversationSessions({ claudeDir: join(root, 'claude'), desktopRoots: [join(root, 'desktop')] });
  assert.equal(result.sessions.length, 1);
  const session = result.sessions[0];
  assert.equal(session.id, id); assert.equal(session.adapter, 'claude-desktop'); assert.equal(session.title, 'Session title');
  assert.equal(session.branch, 'new-branch'); assert.deepEqual(session.directories, [cwd, origin, anchor]);
  assert.deepEqual(session.pulls.map(pr => pr.number), [12], 'the persisted list wins even when the PR branch differs from the session branch');
  await writeFile(join(desktop, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: 'cli-current', cwd, prs: [] }));
  const unlinked = await conversationSessions({ claudeDir: join(root, 'claude'), desktopRoots: [join(root, 'desktop')] });
  assert.deepEqual(unlinked.sessions.find(session => session.id === id)?.pulls, [], 'an empty current list does not resurrect unlinked PRs from history');
});

test('older Desktop metadata without prs[] can recover explicit links from its CLI transcript', async t => {
  const root = await temporary(t); const desktop = join(root, 'desktop/account/profile'); await mkdir(desktop, { recursive: true });
  const id = 'local_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await writeFile(join(desktop, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: 'old-cli', cwd: '/deleted' }));
  await transcript(root, 'old-cli', '/deleted', [{ cwd: '/deleted' }, link('old-cli', 7)]);
  const result = await conversationSessions({ claudeDir: join(root, 'claude'), desktopRoots: [join(root, 'desktop')] });
  assert.equal(result.sessions.length, 1); assert.deepEqual(result.sessions[0].pulls.map(pr => pr.number), [7]);
});

test('project names decode against real entries, preserving hyphens and dots inside segments', async t => {
  const root = await temporary(t); await mkdir(join(root, 'a-b/c.d'), { recursive: true });
  assert.equal(await decodeProjectPath('-a-b-c-d', root), join(root, 'a-b/c.d'));
  assert.equal(await decodeProjectPath('-a-b-missing', root), undefined);
});

test('Codex and OpenCode preserve individual session identities, repositories and branches', async t => {
  const root = await temporary(t); const codex = join(root, 'codex'); await mkdir(codex);
  const old = new DatabaseSync(join(codex, 'state_4.sqlite')); old.exec('CREATE TABLE threads (id TEXT, cwd TEXT)'); old.exec("INSERT INTO threads VALUES ('old', '/old')"); old.close();
  const state = new DatabaseSync(join(codex, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, git_branch TEXT, updated_at INTEGER, git_origin_url TEXT, archived INTEGER)');
  state.exec(`INSERT INTO threads VALUES ('t1', '/work/a', 'First task', 'first', 1793000000, 'https://github.com/viewer/a.git', 0),
    ('t2', '/work/a', 'Second task', 'second', 1793100000, NULL, 1)`); state.close();
  const data = join(root, 'opencode'); await mkdir(data);
  const opencode = new DatabaseSync(join(data, 'opencode.db'));
  opencode.exec('CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_updated INTEGER)');
  opencode.exec("INSERT INTO session VALUES ('ses_1', '/work/c', 'OpenCode task', 1793000000000)"); opencode.close();
  const { sessions } = await conversationSessions({ codexHome: codex, opencodeData: data });
  assert.deepEqual(sessions.map(session => session.id), ['t1', 't2', 'ses_1']);
  assert.equal(sessions[0].origin, 'https://github.com/viewer/a.git'); assert.equal(sessions[0].branch, 'first');
  assert.equal(sessions[1].archived, true); assert.equal(sessions[1].branch, 'second');
  assert.equal(sessions[2].title, 'OpenCode task'); assert.equal(sessions[2].lastActive, new Date(1793000000000).toISOString());
});

test('older OpenCode JSON metadata and absent clients', async t => {
  const root = await temporary(t); const directory = join(root, 'opencode/storage/session/project'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'ses_a.json'), JSON.stringify({ id: 'ses_a', title: 'Task', directory: '/work/d', time: { updated: 1793000001000 } }));
  await writeFile(join(directory, 'ses_b.json'), '{"truncated":');
  const found = await conversationSessions({ claudeDir: join(root, 'absent'), codexHome: join(root, 'absent'), opencodeData: join(root, 'opencode') });
  assert.deepEqual(found.warnings, []); assert.deepEqual(found.sessions.map(session => [session.id, session.title, session.directory]), [['ses_a', 'Task', '/work/d']]);
});

test('PR references normalize GitHub links and reject other hosts or credentials', () => {
  assert.deepEqual(parseGitHubPull('https://github.com/Owner/repo/pull/12/files?diff=split#L1'), { repository: 'Owner/repo', number: 12, url: 'https://github.com/Owner/repo/pull/12' });
  for (const value of ['https://github.com.evil.test/Owner/repo/pull/12', 'https://user:secret@github.com/Owner/repo/pull/12', 'http://github.com/Owner/repo/pull/12', 'https://github.com/Owner/repo/pull/0']) {
    assert.equal(parseGitHubPull(value), undefined);
  }
});
