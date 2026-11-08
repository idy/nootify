import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertMode } from './platform-fixtures.js';
import { test, type TestContext } from 'node:test';
import { AGENT_IDS, AgentPrompts, BEGIN, END, agentSession, isAgent, promptBlock, promptFiles, promptTargets, withBlock, withoutBlock } from '../src/agents.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nootify-agents-')); t.after(() => rm(root, { recursive: true, force: true }));
  const files = { claude: join(root, 'claude', 'CLAUDE.md'), codex: join(root, 'codex', 'AGENTS.md'), opencode: join(root, 'missing', 'opencode', 'AGENTS.md'),
    trae: join(root, 'missing', 'trae', 'user_rules', 'nootify.md'), workbuddy: join(root, 'missing', 'codebuddy', 'CODEBUDDY.md') };
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
  const command = process.platform === 'win32' ? "MSYS2_ARG_CONV_EXCL='*' /opt/nootify/node /opt/nootify/cli.js" : '/opt/nootify/node /opt/nootify/cli.js';
  assert.ok(written.includes(`\`${command} thread-open --agent claude --session-name "<short task title>" --state-dir `));
  assert.match(written, /independent Tailscale device \(`http:\/\/100\.64\.0\.7\/`\)/);
  assert.match(written, /does not expose this (?:Mac|computer)'s previews, files, or other ports/);
  assert.ok(!written.includes("this Mac's Tailscale address"));
  await assertMode(f.files.claude, 0o640, 'the file write mode is kept');
  assert.equal((await f.agents.set('claude', true)).status, 'current', 'enabling again changes nothing');
  assert.equal((await f.agents.set('claude', false)).status, 'absent');
  assert.equal(await readFile(f.files.claude, 'utf8'), original);
  const backups = (await readdir(join(f.state, 'agent-backups'))).sort();
  assert.equal(backups.length, 2, 'one backup per change, none for the no-op');
  assert.equal(await readFile(join(f.state, 'agent-backups', backups[0]), 'utf8'), original);
  await assertMode(join(f.state, 'agent-backups', backups[0]), 0o600);
  assert.deepEqual(f.reports.map(record => record.status), ['prompt_injected', 'prompt_removed']);
  const list = await f.agents.list();
  assert.deepEqual(list.map(agent => [agent.agent, agent.status]), [['claude', 'absent'], ['codex', 'absent'], ['opencode', 'missing'], ['trae', 'missing'], ['workbuddy', 'missing']]);
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
  await assertMode(join(f.root, 'missing', 'opencode'), 0o700);
});

test('a file created for the block is removed with it; symlinked prompt files keep their link', async t => {
  const f = await fixture(t);
  await f.agents.set('codex', true);
  assert.ok((await readFile(f.files.codex, 'utf8')).startsWith(BEGIN));
  await f.agents.set('codex', false);
  await assert.rejects(stat(f.files.codex), /ENOENT/);
  const target = join(f.root, 'dotfiles', 'CLAUDE.md');
  await mkdir(join(f.root, 'dotfiles')); await writeFile(target, 'shared\n');
  const link = process.platform === 'win32' ? dirname(f.files.claude) : f.files.claude;
  if (process.platform === 'win32') { await rm(link, { recursive: true }); await symlink(dirname(target), link, 'junction'); }
  else await symlink(target, link);
  await f.agents.set('claude', true);
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.ok((await readFile(target, 'utf8')).startsWith(`shared\n\n${BEGIN}`));
});

test('agents sharing one prompt target cannot overwrite each other\'s commands', async t => {
  const f = await fixture(t);
  await writeFile(f.files.claude, 'shared instructions\n');
  await f.agents.set('claude', true);
  const before = await readFile(f.files.claude, 'utf8');
  const shared = process.platform === 'win32' ? new AgentPrompts({ stateDir: f.state, port: 9417, files: { ...f.files, codex: f.files.claude } }) : f.agents;
  if (process.platform !== 'win32') await symlink(f.files.claude, f.files.codex);
  await assert.rejects(shared.set('codex', true), /share the same prompt file/);
  assert.equal(await readFile(f.files.claude, 'utf8'), before);
  if (process.platform !== 'win32') assert.ok((await lstat(f.files.codex)).isSymbolicLink());
  assert.equal((await readdir(join(f.state, 'agent-backups'))).length, 1, 'the rejected write makes no new backup');
  await f.agents.set('claude', false);
  assert.equal(await readFile(process.platform === 'win32' ? f.files.claude : f.files.codex, 'utf8'), 'shared instructions\n', 'removing a block remains possible');
});

test('obsolete provider instructions are replaced with the Feishu-only prompt', async t => {
  const f = await fixture(t);
  await writeFile(f.files.claude, `${BEGIN}\n## Legacy notification provider\nUse chat-ack and chat-reply.\n${END}\n`);
  assert.equal((await f.agents.inspect('claude')).status, 'outdated');
  await f.agents.set('claude', true);
  const block = await readFile(f.files.claude, 'utf8');
  assert.match(block, /Feishu updates through Nootify/); assert.match(block, /lark-ack/); assert.match(block, /lark-reply/);
  assert.ok(!block.includes('chat-ack')); assert.ok(!block.includes('--channel'));
  assert.equal((await f.agents.inspect('claude')).status, 'current');
});

test('sessions come from each client\'s variables; commands quote paths and name non-default service locations', () => {
  assert.deepEqual(agentSession('claude', { CLAUDE_CODE_HOST_SESSION_ID: 'local_x', CLAUDE_CODE_SESSION_ID: 'cli' }), { adapter: 'claude-desktop', session_id: 'local_x' });
  assert.deepEqual(agentSession('claude', { CLAUDE_CODE_SESSION_ID: 'cli' }), { adapter: 'claude-code', session_id: 'cli' });
  assert.deepEqual(agentSession('codex', { CODEX_THREAD_ID: 't1' }), { adapter: 'codex', session_id: 't1' });
  assert.deepEqual(agentSession('codex', {}), { adapter: 'codex', session_id: undefined });
  const block = promptBlock('opencode', { stateDir: '/x/state dir', port: 9500, command: ['/a b/node', '/c/cli.js'] });
  const command = process.platform === 'win32' ? "& '/a b/node' '/c/cli.js'" : "'/a b/node' /c/cli.js";
  assert.ok(block.includes(`\`${command} thread-open --agent opencode --session-id <this ses_… session ID> --session-name "<short task title>" --state-dir '/x/state dir' --port 9500\``));
  assert.ok(!block.includes('Tailscale address ('));
  const marked = `${BEGIN}\nx\n${END}`;
  assert.equal(withoutBlock(withBlock('no final newline', marked)), 'no final newline\n');
  assert.equal(withBlock('', marked), `${marked}\n`);
  assert.equal(withoutBlock(`a\n\n${marked}\nb\n`), 'a\nb\n');
  assert.throws(() => withBlock(`${END}\n${BEGIN}`, marked), /unbalanced/);
});

for (const agent of ['trae', 'workbuddy'] as const) {
  test(`${agent} instructions preserve existing rules, use Feishu, and require explicit conversation IDs after opening`, async t => {
    const f = await fixture(t);
    assert.ok(AGENT_IDS.includes(agent)); assert.ok(isAgent(agent));
    assert.deepEqual(agentSession(agent, { CLAUDE_CODE_HOST_SESSION_ID: 'unrelated', CODEX_THREAD_ID: 'unrelated' }), { adapter: agent });
    await f.agents.set(agent, true);
    if (agent === 'trae') assert.match(await readFile(f.files[agent], 'utf8'), /^---\nalwaysApply: true\n---\n/);
    await f.agents.set(agent, false);
    const original = '---\nalwaysApply: true\n---\n\n# My instructions\nKeep this.\n';
    await writeFile(f.files[agent], original);
    await f.agents.handle({ method: 'PUT', path: `/v1/agents/${agent}`, body: { enabled: true } });
    assert.equal((await f.agents.inspect(agent)).status, 'current');
    const written = await readFile(f.files[agent], 'utf8'); assert.ok(written.startsWith(original));
    assert.match(written, new RegExp(`thread-open --agent ${agent} --session-name`));
    assert.match(written, new RegExp(`thread-send --agent ${agent} --session-id "<returned session_id>"`));
    assert.match(written, new RegExp(`thread-receive --agent ${agent} --session-id`));
    assert.match(written, /thread-ack.*--message-id "<returned message.id>"/);
    assert.match(written, /cannot wake an idle or closed conversation/);
    assert.match(written, /Feishu group/);
    assert.ok(!written.includes('--channel'));
    await f.agents.set(agent, false);
    assert.equal(await readFile(f.files[agent], 'utf8'), original);
  });
}

test('Nootify-specific rule file overrides select explicit Trae and WorkBuddy targets', () => {
  const files = promptFiles({ NOOTIFY_TRAE_RULES_FILE: '/custom/trae/nootify.md', NOOTIFY_WORKBUDDY_RULES_FILE: '/custom/codebuddy/CODEBUDDY.md' });
  assert.equal(files.trae, '/custom/trae/nootify.md'); assert.equal(files.workbuddy, '/custom/codebuddy/CODEBUDDY.md');
  assert.deepEqual(promptTargets({ NOOTIFY_TRAE_RULES_FILE: '/custom/trae/nootify.md' }).trae, ['/custom/trae/nootify.md']);
  const defaults = promptTargets({}).trae;
  assert.equal(defaults.length, 2);
  assert.equal(defaults[0], join(homedir(), '.trae', 'user_rules', 'nootify.md'));
  assert.equal(defaults[1], join(homedir(), '.trae-cn', 'user_rules', 'nootify.md'));
});

test('Trae enables both editions before installation and refreshes/removes both without restarting the service', async t => {
  const f = await fixture(t);
  const files = [join(f.root, 'trae', 'user_rules', 'nootify.md'), join(f.root, 'trae-cn', 'user_rules', 'nootify.md')];
  const agents = new AgentPrompts({ stateDir: f.state, port: 9417, files: { ...f.files, trae: files } });
  assert.equal((await agents.inspect('trae')).status, 'missing');
  const enabled = await agents.set('trae', true);
  assert.equal(enabled.status, 'current'); assert.deepEqual(enabled.files, files);
  for (const file of files) assert.match(await readFile(file, 'utf8'), /alwaysApply: true[\s\S]*thread-open --agent trae/);
  const ownRule = join(f.root, 'trae-cn', 'user_rules', 'mine.md');
  await writeFile(ownRule, 'China edition user instructions\n');
  await writeFile(files[1], 'China edition existing rules\n');
  const partial = await agents.inspect('trae');
  assert.equal(partial.status, 'outdated'); assert.equal(partial.injected, true);
  await agents.set('trae', true);
  assert.equal((await agents.inspect('trae')).status, 'current');
  assert.match(await readFile(files[1], 'utf8'), /^China edition existing rules\n/);
  await agents.set('trae', false);
  for (const file of files) assert.ok(!(await readFile(file, 'utf8')).includes(BEGIN));
  assert.equal(await readFile(files[1], 'utf8'), 'China edition existing rules\n');
  assert.equal(await readFile(ownRule, 'utf8'), 'China edition user instructions\n');
});

test('Trae checks all edition targets for conflicting markers and shared files before editing either', async t => {
  const f = await fixture(t);
  const international = join(f.root, 'claude', 'trae.md'); const cn = join(f.root, 'claude', 'trae-cn.md');
  const agents = new AgentPrompts({ stateDir: f.state, port: 9417, files: { ...f.files, trae: [international, cn] } });
  await writeFile(international, 'International rules\n');
  await writeFile(cn, `${BEGIN}\nbroken markers\n`);
  assert.equal((await agents.inspect('trae')).status, 'conflict');
  await assert.rejects(agents.set('trae', true), /unbalanced/);
  assert.equal(await readFile(international, 'utf8'), 'International rules\n');
  await writeFile(f.files.codex, 'Codex rules\n');
  if (process.platform !== 'win32') { await rm(cn); await symlink(f.files.codex, cn); }
  const shared = process.platform === 'win32'
    ? new AgentPrompts({ stateDir: f.state, port: 9417, files: { ...f.files, trae: [international, f.files.codex] } }) : agents;
  await assert.rejects(shared.set('trae', true), /share the same prompt file/);
  assert.equal(await readFile(international, 'utf8'), 'International rules\n');
  assert.equal(await readFile(f.files.codex, 'utf8'), 'Codex rules\n');
});
