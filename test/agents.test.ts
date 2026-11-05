import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AgentPrompts, BEGIN, END, agentSession, promptBlock, withBlock, withoutBlock } from '../src/agents.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nootify-agents-')); t.after(() => rm(root, { recursive: true, force: true }));
  const files = { claude: join(root, 'claude', 'CLAUDE.md'), codex: join(root, 'codex', 'AGENTS.md'), opencode: join(root, 'missing', 'opencode', 'AGENTS.md') };
  await mkdir(join(root, 'claude')); await mkdir(join(root, 'codex'));
  const state = join(root, 'state');
  const reports: Record<string, unknown>[] = [];
  const agents = new AgentPrompts({ stateDir: state, port: 9417, files, command: ['/opt/nootify/node', '/opt/nootify/cli.js'], tailnetAddress: () => '100.64.0.7' },
    record => reports.push(record));
  return { root, files, state, agents, reports };
}

test('the block is appended and removed again without touching the rest of the prompt file', async t => {
  const f = await fixture(t);
  const original = '# Mine\n\n<Lark>\nkeep this\n</Lark>\n';
  await writeFile(f.files.claude, original, { mode: 0o640 });
  assert.equal((await f.agents.inspect('claude')).status, 'absent');
  const enabled = await f.agents.set('claude', true);
  assert.equal(enabled.status, 'current'); assert.equal(enabled.injected, true);
  const written = await readFile(f.files.claude, 'utf8');
  assert.ok(written.startsWith(`${original}\n${BEGIN}`)); assert.ok(written.endsWith(`${END}\n`));
  assert.match(written, /`\/opt\/nootify\/node \/opt\/nootify\/cli\.js thread-open --agent claude --session-name "<short task title>" --state-dir /);
  assert.match(written, /independent Tailscale device \(`http:\/\/100\.64\.0\.7\/`\)/);
  assert.match(written, /does not expose this Mac's previews, files, or other ports/);
  assert.ok(!written.includes("this Mac's Tailscale address"));
  assert.equal((await stat(f.files.claude)).mode & 0o777, 0o640, 'the file mode is kept');
  assert.equal((await f.agents.set('claude', true)).status, 'current', 'enabling again changes nothing');
  assert.equal((await f.agents.set('claude', false)).status, 'absent');
  assert.equal(await readFile(f.files.claude, 'utf8'), original);
  const backups = (await readdir(join(f.state, 'agent-backups'))).sort();
  assert.equal(backups.length, 2, 'one backup per change, none for the no-op');
  assert.equal(await readFile(join(f.state, 'agent-backups', backups[0]), 'utf8'), original);
  assert.equal((await stat(join(f.state, 'agent-backups', backups[0]))).mode & 0o777, 0o600);
  assert.deepEqual(f.reports.map(record => record.status), ['prompt_injected', 'prompt_removed']);
  const list = await f.agents.list();
  assert.deepEqual(list.map(agent => [agent.agent, agent.status]), [['claude', 'absent'], ['codex', 'absent'], ['opencode', 'missing']]);
});

test('outdated blocks are refreshed in place and unbalanced markers are never edited', async t => {
  const f = await fixture(t);
  await writeFile(f.files.codex, `before\n${BEGIN}\nold text\n${END}\nafter\n`);
  assert.equal((await f.agents.inspect('codex')).status, 'outdated');
  await f.agents.set('codex', true);
  const refreshed = await readFile(f.files.codex, 'utf8');
  assert.ok(refreshed.startsWith(`before\n${BEGIN}`)); assert.ok(refreshed.endsWith(`${END}\nafter\n`));
  assert.match(refreshed, /thread-send --agent codex --text "<message>"/);
  assert.equal((await f.agents.inspect('codex')).status, 'current');
  const broken = `${BEGIN}\nno end marker\n`;
  await writeFile(f.files.codex, broken);
  assert.equal((await f.agents.inspect('codex')).status, 'conflict');
  await assert.rejects(f.agents.set('codex', false), /unbalanced/);
  assert.equal(await readFile(f.files.codex, 'utf8'), broken);
  assert.equal((await f.agents.set('opencode', false)).status, 'missing');
  await assert.rejects(stat(f.files.opencode), /ENOENT/);
  assert.equal((await f.agents.set('opencode', true)).status, 'current');
  assert.ok((await readFile(f.files.opencode, 'utf8')).includes('--agent opencode'));
  assert.equal((await stat(join(f.root, 'missing', 'opencode'))).mode & 0o777, 0o700);
});

test('a file created for the block is removed with it; symlinked prompt files keep their link', async t => {
  const f = await fixture(t);
  await f.agents.set('codex', true);
  assert.ok((await readFile(f.files.codex, 'utf8')).startsWith(BEGIN));
  await f.agents.set('codex', false);
  await assert.rejects(stat(f.files.codex), /ENOENT/);
  const target = join(f.root, 'dotfiles', 'CLAUDE.md');
  await mkdir(join(f.root, 'dotfiles')); await writeFile(target, 'shared\n'); await symlink(target, f.files.claude);
  await f.agents.set('claude', true);
  assert.ok((await lstat(f.files.claude)).isSymbolicLink());
  assert.ok((await readFile(target, 'utf8')).startsWith(`shared\n\n${BEGIN}`));
});

test('agents sharing one prompt target cannot overwrite each other\'s commands', async t => {
  const f = await fixture(t);
  await writeFile(f.files.claude, 'shared instructions\n');
  await f.agents.set('claude', true);
  const before = await readFile(f.files.claude, 'utf8');
  await symlink(f.files.claude, f.files.codex);
  await assert.rejects(f.agents.set('codex', true), /share the same prompt file/);
  assert.equal(await readFile(f.files.claude, 'utf8'), before);
  assert.ok((await lstat(f.files.codex)).isSymbolicLink());
  assert.equal((await readdir(join(f.state, 'agent-backups'))).length, 1, 'the rejected write makes no new backup');
  await f.agents.set('claude', false);
  assert.equal(await readFile(f.files.codex, 'utf8'), 'shared instructions\n', 'removing a block remains possible');
});

test('sessions come from each client\'s variables; commands quote paths and name non-default service locations', () => {
  assert.deepEqual(agentSession('claude', { CLAUDE_CODE_HOST_SESSION_ID: 'local_x', CLAUDE_CODE_SESSION_ID: 'cli' }), { adapter: 'claude-desktop', session_id: 'local_x' });
  assert.deepEqual(agentSession('claude', { CLAUDE_CODE_SESSION_ID: 'cli' }), { adapter: 'claude-code', session_id: 'cli' });
  assert.deepEqual(agentSession('codex', { CODEX_THREAD_ID: 't1' }), { adapter: 'codex', session_id: 't1' });
  assert.deepEqual(agentSession('codex', {}), { adapter: 'codex', session_id: undefined });
  const block = promptBlock('opencode', { stateDir: '/x/state dir', port: 9500, command: ['/a b/node', '/c/cli.js'] });
  assert.ok(block.includes("`'/a b/node' /c/cli.js thread-open --agent opencode --session-id <this ses_… session ID> --session-name \"<short task title>\" --state-dir '/x/state dir' --port 9500`"));
  assert.ok(!block.includes('Tailscale address ('));
  const marked = `${BEGIN}\nx\n${END}`;
  assert.equal(withoutBlock(withBlock('no final newline', marked)), 'no final newline\n');
  assert.equal(withBlock('', marked), `${marked}\n`);
  assert.equal(withoutBlock(`a\n\n${marked}\nb\n`), 'a\nb\n');
  assert.throws(() => withBlock(`${END}\n${BEGIN}`, marked), /unbalanced/);
});
