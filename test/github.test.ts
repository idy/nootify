import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PullRequestsService, type PullSnapshot } from '../src/github.js';
import { loadPullConfig, parsePullConfig } from '../src/github-api.js';
import { classifyPull, comparePulls, normalizePull, parseGitHubRemote, type GitHubPull } from '../src/github-model.js';
import type { ConversationSources } from '../src/conversations.js';

const date = '2026-10-01T00:00:00Z';
const pull = (number: number, overrides: Partial<GitHubPull> = {}): GitHubPull => ({
  id: `P${number}`, number, url: `https://github.com/external/project/pull/${number}`, title: `Pull ${number}`,
  state: 'OPEN', isDraft: false, isCrossRepository: true, updatedAt: date,
  repository: { nameWithOwner: 'external/project' }, author: { login: 'viewer' }, headRepository: { nameWithOwner: 'viewer/fork' }, ...overrides,
});
const internalPull = (number: number, repository = 'viewer/uncloned', overrides: Partial<GitHubPull> = {}): GitHubPull => pull(number, {
  repository: { nameWithOwner: repository }, url: `https://github.com/${repository}/pull/${number}`, author: { login: 'outside-contributor' }, ...overrides,
});
interface Data {
  orgs?: string[];
  kinds?: Record<string, string>;
  internal?: Record<string, GitHubPull[]>;
  authored?: Record<string, GitHubPull[]>;
  forks?: Record<string, { nameWithOwner: string; parent: { nameWithOwner: string } | null }[]>;
  upstream?: Record<string, GitHubPull[]>;
  details?: Record<string, Partial<GitHubPull>>;
  delay?: number;
  fail?: string;
  hang?: string;
  partialDetail?: string;
  truncate?: string;
  notGh?: boolean;
}
interface Call { operation: string; variables: Record<string, string | null>; args: string[]; pid: number }
async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > end) assert.fail('Timed out waiting for fake-gh operation');
    await delay(10);
  }
}
async function settled(service: PullRequestsService): Promise<PullSnapshot> {
  await waitFor(() => !service.snapshot().refresh.running);
  return service.snapshot();
}
async function fixture(t: TestContext, data: Data = {}, config: Record<string, unknown> = {}, conversations: ConversationSources = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ws-github-')); const directory = join(root, 'state');
  await mkdir(directory);
  const control = join(root, 'data.json'); const calls = join(root, 'calls.ndjson'); const binary = join(root, 'fake-gh.cjs');
  await writeFile(control, JSON.stringify(data));
  await writeFile(join(directory, 'pulls.config.json'), JSON.stringify({ scanRoots: [], followDefault: 'all', ...config }));
  const script = `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const control = ${JSON.stringify(control)};
const calls = ${JSON.stringify(calls)};
const args = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(control, 'utf8'));
if (args[0] === '--version') { process.stdout.write(input.notGh ? 'something else\n' : 'gh version 2.99.0 (fake)\n'); process.exit(0); }
if (args[0] !== 'api' || args[1] !== 'graphql' || !args.includes('github.com')) throw Error('Only github.com GraphQL is allowed');
const fields = {};
for (let i = 0; i < args.length; i++) if (['-f', '-F'].includes(args[i])) {
  const value = args[++i]; const at = value.indexOf('=');
  fields[value.slice(0, at)] = value.slice(at + 1) === 'null' ? null : value.slice(at + 1);
}
if (!/^query\s/.test(fields.query)) throw Error('Mutation attempted');
const operation = fields.query.match(/^query\s+(\w+)/)[1];
const variables = { ...fields }; delete variables.query;
fs.appendFileSync(calls, JSON.stringify({ operation, variables, args, pid: process.pid }) + '\n');
if (input.hang === operation) { process.on('SIGTERM', () => {}); setInterval(() => {}, 10000); }
else setTimeout(() => {
  if (input.fail === operation) { process.stderr.write('gh: HTTP 403 Resource not accessible by integration (requires repo/read:org); ghp_fakePrivateToken\n'); process.exit(1); }
  const page = (nodes, source) => ({ nodes, totalCount: input.truncate === source ? nodes.length + 1000 : nodes.length,
    issueCount: input.truncate === source ? nodes.length + 1000 : nodes.length,
    pageInfo: { hasNextPage: input.truncate === source, endCursor: input.truncate === source ? 'another-page' : null } });
  let data;
  if (operation === 'PullViewer') data = { viewer: { login: 'viewer', organizations: page((input.orgs || []).map(login => ({ login })), 'organizations') } };
  else if (operation === 'PullOwnerKind') data = { repositoryOwner: { __typename: (input.kinds || {})[fields.login] || 'Organization', login: fields.login } };
  else if (operation === 'PullInternal') {
    const owner = fields.searchQuery.match(/(?:user|org):([^\s]+)/)[1];
    data = { search: page((input.internal || {})[owner] || [], 'internal:' + owner) };
  } else if (operation === 'PullAuthored') {
    const author = fields.searchQuery.match(/author:([^\s]+)/)[1];
    data = { search: page((input.authored || {})[author] || [], 'authored:' + author) };
  } else if (operation === 'PullForks') data = { owner: { repositories: page((input.forks || {})[fields.owner || 'viewer'] || [], 'forks:' + (fields.owner || 'viewer')) } };
  else if (operation === 'PullUpstream') data = { repository: { pullRequests: page((input.upstream || {})[fields.owner + '/' + fields.name] || [], 'upstream:' + fields.owner + '/' + fields.name) } };
  else if (operation === 'PullDetails') {
    data = {};
    const records = ['internal', 'authored', 'upstream'].flatMap(source => Object.values(input[source] || {}).flat());
    for (const [name, id] of Object.entries(variables)) {
      const pr = records.find(pr => pr.id === id);
      data[name.replace('id', 'p')] = { id, state: pr.state, updatedAt: pr.updatedAt, mergeable: 'MERGEABLE', reviewDecision: null,
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] }, reviews: { totalCount: 0, nodes: [] }, ...(input.details || {})[id] };
    }
    if (input.partialDetail) {
      const variable = Object.entries(variables).find(([, id]) => id === input.partialDetail);
      if (variable) {
        const alias = variable[0].replace('id', 'p'); data[alias] = null;
        process.stdout.write(JSON.stringify({ data, errors: [{ path: [alias, 'commits'], message: 'Checks permission denied' }] })); process.exit(1);
      }
    }
  } else throw Error('Unexpected query ' + operation);
  process.stdout.write(JSON.stringify({ data }));
}, operation === 'PullViewer' ? input.delay || 0 : 0);
`;
  await writeFile(binary, script, { mode: 0o700 }); await chmod(binary, 0o700);
  const previousGh = process.env.GH_BIN; const previousConfig = process.env.NOOTIFY_PULLS_CONFIG;
  process.env.GH_BIN = binary; delete process.env.NOOTIFY_PULLS_CONFIG;
  const reports: Record<string, unknown>[] = [];
  // No conversation sources: tests never read the real ~/.claude, ~/.codex or OpenCode data.
  const service = new PullRequestsService(directory, record => reports.push(record), conversations);
  t.after(async () => {
    await service.stop();
    if (previousGh === undefined) delete process.env.GH_BIN; else process.env.GH_BIN = previousGh;
    if (previousConfig === undefined) delete process.env.NOOTIFY_PULLS_CONFIG; else process.env.NOOTIFY_PULLS_CONFIG = previousConfig;
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, service, reports,
    set: (value: Data) => writeFile(control, JSON.stringify(value)),
    calls: async (): Promise<Call[]> => { try { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
  };
}

test('classification separates all-author internal destinations from outgoing cross-repository contributions', () => {
  const scope = { authors: ['viewer', 'extra'], ownedOwners: ['viewer', 'OurOrg'], excludeRepositories: ['viewer/excluded'] };
  assert.equal(classifyPull(internalPull(1), scope), 'internal');
  assert.equal(classifyPull(internalPull(2, 'ourorg/not-cloned', { author: { login: 'anyone' }, isCrossRepository: false }), scope), 'internal');
  assert.equal(classifyPull(pull(3), scope), 'upstream');
  assert.equal(classifyPull(pull(4, { author: { login: 'colleague' }, headRepository: { nameWithOwner: 'OurOrg/fork' } }), scope), 'upstream');
  assert.equal(classifyPull(pull(5, { headRepository: null }), scope), 'upstream', 'Authored cross-repo PRs survive deletion of the fork');
  assert.equal(classifyPull(pull(6, { author: { login: 'unrelated' }, headRepository: { nameWithOwner: 'someone/fork' } }), scope), undefined);
  for (const pr of [pull(7, { isCrossRepository: false }), pull(8, { headRepository: { nameWithOwner: 'external/project' } }),
    pull(9, { headRepository: null, isCrossRepository: undefined }), pull(10, { state: 'MERGED' }), pull(11, { state: 'CLOSED' }), internalPull(12, 'viewer/excluded')]) {
    assert.equal(classifyPull(pr, scope), undefined);
  }
  assert.equal(classifyPull(pull(13, { author: { login: 'colleague' }, headRepository: { nameWithOwner: 'LocalTeam/fork' } }), { ...scope, localForks: ['localteam/fork'] }), 'upstream');
});

test('oldest-first sorting uses repository, numeric PR number, then URL for deterministic ties', () => {
  const values = [normalizePull(pull(20, { updatedAt: '2026-10-03T00:00:00Z' })), normalizePull(pull(9)), normalizePull(pull(2)),
    normalizePull(internalPull(1, 'aaa/project')), normalizePull(pull(30, { updatedAt: '' }))];
  assert.deepEqual(values.sort(comparePulls).map(pr => pr.number), [1, 2, 9, 20, 30]);
  assert.deepEqual([...values].reverse().sort(comparePulls), values);
});

test('CI distinguishes unavailable checks, no checks, failures, pending checks and partial context counts', () => {
  assert.equal(normalizePull(pull(1)).ci.state, 'UNKNOWN');
  assert.equal(normalizePull(pull(2, { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })).ci.state, 'NONE');
  const warnings: string[] = [];
  const pr = normalizePull(pull(3, { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { totalCount: 104, nodes: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
    { __typename: 'StatusContext', state: 'ERROR' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
  ] } } } }] } }), warning => warnings.push(warning));
  assert.deepEqual(pr.ci, { state: 'FAILURE', passed: 1, failed: 2, pending: 1, total: 104 });
  assert.match(warnings[0], /counts are partial/);
  const reviewed = normalizePull(pull(4, { reviews: { nodes: [
    { author: { login: 'reviewer' }, state: 'APPROVED', submittedAt: date },
    { author: { login: 'reviewer' }, state: 'COMMENTED', submittedAt: '2026-10-02T00:00:00Z' },
  ] } }));
  assert.equal(reviewed.reviewDecision, 'APPROVED');
});

test('remote parsing accepts GitHub HTTPS/SSH remotes and strips credentials', () => {
  assert.equal(parseGitHubRemote('https://user:password@github.com/Owner/repo.git'), 'Owner/repo');
  assert.equal(parseGitHubRemote('git@github.com:Owner/repo.git'), 'Owner/repo');
  assert.equal(parseGitHubRemote('ssh://git@github.com/Owner/repo.git'), 'Owner/repo');
  assert.equal(parseGitHubRemote('https://github.com.evil.example/Owner/repo'), undefined);
  assert.equal(parseGitHubRemote('/local/repo'), undefined);
});

test('configuration precedence supports private state and explicit paths, preserving legacy owner overrides/authors', async t => {
  const f = await fixture(t, {}, { authors: ['Extra', 'extra'], ownedOwners: ['ManualOrg'], upstreamOwners: ['ExternalOrg'] });
  const loaded = await loadPullConfig(f.directory);
  assert.equal(loaded.source, join(f.directory, 'pulls.config.json'));
  assert.deepEqual(loaded.config.authors, ['extra']);
  assert.deepEqual(loaded.config.ownedOwners, ['ManualOrg']);
  const explicit = join(f.root, 'alternate.json');
  await writeFile(explicit, JSON.stringify({ ownedOwners: ['OtherOrg'], refreshMinutes: 1 }));
  process.env.NOOTIFY_PULLS_CONFIG = explicit;
  const override = await loadPullConfig(f.directory);
  assert.deepEqual(override.config.ownedOwners, ['OtherOrg']); assert.match(override.warnings[0], /every 5 minutes/);
  assert.throws(() => parsePullConfig({ authors: ['bad login'] }), /GitHub logins/);
  assert.throws(() => parsePullConfig({ maxSearchPages: -1 }), /integer/);
});

test('fake-gh collection includes uncloned internal repos, configured owners, extra authors and other authors from our forks', async t => {
  const old = internalPull(1, 'viewer/uncloned', { updatedAt: '2026-09-01T00:00:00Z' });
  const colleague = pull(6, { author: { login: 'colleague' }, headRepository: { nameWithOwner: 'InternalOrg/fork' } });
  const f = await fixture(t, {
    orgs: ['InternalOrg', 'ExternalOrg'],
    internal: { viewer: [internalPull(2, 'viewer/uncloned', { isDraft: true }), old, internalPull(9, 'viewer/excluded'), internalPull(10, 'viewer/closed', { state: 'CLOSED' })],
      InternalOrg: [internalPull(3, 'InternalOrg/uncloned')], ManualOrg: [internalPull(4, 'ManualOrg/uncloned')] },
    authored: { viewer: [pull(5), pull(7, { isCrossRepository: false }), pull(8, { state: 'MERGED' })], extra: [pull(11, { author: { login: 'extra' }, headRepository: null })] },
    forks: { InternalOrg: [{ nameWithOwner: 'InternalOrg/fork', parent: { nameWithOwner: 'external/project' } }] },
    upstream: { 'external/project': [colleague, pull(12, { author: { login: 'stranger' }, headRepository: { nameWithOwner: 'stranger/fork' } })] },
  }, { authors: ['extra'], upstreamOwners: ['InternalOrg', 'ExternalOrg'], ownedOwners: ['InternalOrg', 'ManualOrg'], excludeRepositories: ['viewer/excluded'] });
  const previousPath = process.env.PATH; process.env.PATH = '/usr/bin:/bin';
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  await f.service.start();
  const result = await settled(f.service);
  assert.equal(result.refresh.error, undefined); assert.equal(f.service.status(), 'ready');
  assert.deepEqual(result.internal.map(pr => pr.number), [1, 3, 4, 2]);
  assert.equal(result.internal.find(pr => pr.number === 2)?.isDraft, true);
  assert.deepEqual(result.upstream.map(pr => pr.number), [5, 6, 11]);
  const calls = await f.calls();
  const queries = calls.filter(call => call.operation === 'PullInternal').map(call => call.variables.searchQuery!);
  assert.ok(queries.some(query => query.includes('user:viewer')));
  assert.ok(queries.some(query => query.includes('org:InternalOrg')));
  assert.ok(queries.every(query => !query.includes('ExternalOrg') && !query.includes('author:') && query.includes('sort:updated-asc')));
  assert.equal(calls.filter(call => call.operation === 'PullAuthored').length, 2);
  assert.ok(result.warnings.some(warning => /private repositories.*permissions/i.test(warning)));
  const detached = f.service.snapshot(); detached.internal.length = 0; assert.equal(f.service.snapshot().internal.length, 4);
  assert.equal((await f.service.handle({ method: 'GET', path: '/v1/pulls', body: undefined }))?.status, undefined);
  assert.equal(await f.service.handle({ method: 'DELETE', path: '/v1/pulls', body: undefined }), undefined);
});

test('refresh returns immediately, coalesces requests, persists privately and keeps the last good snapshot on permission failures/restart', async t => {
  const initial: Data = { delay: 250, internal: { viewer: [internalPull(1)] } };
  const f = await fixture(t, initial);
  await f.service.start(); assert.equal(f.service.snapshot().refresh.running, true);
  await waitFor(async () => (await f.calls()).some(call => call.operation === 'PullViewer'));
  for (let index = 0; index < 8; index++) f.service.refresh();
  const response = await Promise.race([f.service.handle({ method: 'POST', path: '/v1/pulls/refresh', body: {} }), delay(100).then(() => assert.fail('Refresh endpoint waited for GitHub'))]);
  assert.equal(response?.status, 202); assert.equal((response?.body as PullSnapshot).refresh.running, true);
  const good = await settled(f.service); assert.equal(good.internal.length, 1);
  assert.equal((await f.calls()).filter(call => call.operation === 'PullViewer').length, 1);
  await f.service.stop();
  const cache = await readFile(join(f.directory, 'pulls-cache.json'), 'utf8');
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, 'pulls-cache.json'))).mode & 0o777, 0o600);
  await f.set({ fail: 'PullInternal' });
  await f.service.start(); const failed = await settled(f.service);
  assert.deepEqual(failed.internal, good.internal); assert.deepEqual(failed.upstream, good.upstream);
  assert.equal(failed.refresh.lastSuccessAt, good.refresh.lastSuccessAt); assert.equal(f.service.status(), 'stale');
  assert.match(failed.refresh.error!, /403.*Resource not accessible/);
  assert.ok(!JSON.stringify(failed).includes('ghp_fakePrivateToken'));
  assert.ok(failed.warnings.some(warning => /source failed|source collection|Coverage for this source failed/.test(warning)));
  assert.equal(await readFile(join(f.directory, 'pulls-cache.json'), 'utf8'), cache);
  await f.service.stop();
  await f.set({ delay: 250, fail: 'PullViewer' });
  await f.service.start(); assert.deepEqual(f.service.snapshot().internal, good.internal);
  assert.equal(f.service.snapshot().refresh.running, true);
  await f.service.stop(); assert.equal(f.service.snapshot().refresh.running, false);
  assert.ok(f.reports.some(record => record.status === 'refresh_completed'));
  assert.ok(f.reports.some(record => record.status === 'refresh_failed'));
});

test('source truncation is explicit and retains uncovered cache without reviving a PR observed closed during detail retrieval', async t => {
  const f = await fixture(t, { internal: { viewer: [internalPull(1), internalPull(2)] } }, { maxSearchPages: 1 });
  await f.service.start(); await settled(f.service); await f.service.stop();
  await f.set({ internal: { viewer: [internalPull(1)] }, truncate: 'internal:viewer', details: { P1: { state: 'CLOSED' } } });
  await f.service.start(); const result = await settled(f.service);
  assert.equal(result.refresh.error, undefined);
  assert.deepEqual(result.internal.map(pr => pr.number), [2]);
  assert.ok(result.warnings.some(warning => /truncated.*1,000 results/.test(warning)));
  assert.ok(result.warnings.some(warning => /retained 1 cached PRs/.test(warning)));
});

test('partial GraphQL detail errors isolate unavailable CI/review/merge data without losing the queue', async t => {
  const f = await fixture(t, { internal: { viewer: [internalPull(1), internalPull(2)] }, partialDetail: 'P1' });
  await f.service.start(); const result = await settled(f.service);
  assert.equal(result.internal.length, 2); assert.equal(result.refresh.error, undefined);
  assert.equal(result.internal[0].ci.state, 'UNKNOWN'); assert.equal(result.internal[0].reviewDecision, 'UNKNOWN');
  assert.equal(result.internal[1].ci.state, 'NONE');
  assert.ok(result.warnings.some(warning => /Checks permission denied/.test(warning)));
});

test('stop cancels refresh, kills an unresponsive gh child and prevents later refreshes', async t => {
  const f = await fixture(t, { hang: 'PullViewer' });
  await f.service.start();
  await waitFor(async () => (await f.calls()).some(call => call.operation === 'PullViewer'));
  const child = (await f.calls()).find(call => call.operation === 'PullViewer')!;
  await f.service.stop();
  assert.equal(f.service.status(), 'stopped'); assert.equal(f.service.snapshot().refresh.running, false);
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  const count = (await f.calls()).length;
  f.service.refresh(); await delay(30); assert.equal((await f.calls()).length, count);
});

test('GH_BIN must identify itself as GitHub CLI before any authenticated query is attempted', async t => {
  const f = await fixture(t, { notGh: true });
  await f.service.start(); const result = await settled(f.service);
  assert.equal(f.service.status(), 'error'); assert.match(result.refresh.error!, /did not identify itself as GitHub CLI/);
  assert.equal((await f.calls()).length, 0);
});

test('repositories from local conversations are followed by default; explicit choices persist and filter both queues', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nootify-follow-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'tool');
  await mkdir(checkout);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', checkout, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('remote', 'add', 'origin', 'https://github.com/viewer/tool.git'); git('remote', 'add', 'upstream', 'git@github.com:External/Upstream.git');
  const projects = join(root, 'claude', 'projects', checkout.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(projects, { recursive: true });
  await writeFile(join(projects, 'one.jsonl'), JSON.stringify({ cwd: checkout }) + '\n');
  const upstreamPull = pull(21, { repository: { nameWithOwner: 'External/Upstream' }, url: 'https://github.com/External/Upstream/pull/21',
    author: { login: 'colleague' }, headRepository: { nameWithOwner: 'viewer/tool' } });
  const f = await fixture(t, {
    internal: { viewer: [internalPull(1, 'viewer/tool'), internalPull(2, 'viewer/other')] },
    authored: { viewer: [pull(5)] },
    upstream: { 'External/Upstream': [upstreamPull] },
  }, { followDefault: 'involved' }, { claudeDir: join(root, 'claude') });
  await f.service.start();
  const first = await settled(f.service);
  assert.equal(first.refresh.error, undefined);
  assert.deepEqual(first.internal.map(pr => pr.number), [1], 'viewer/other has no conversation and no PR of ours');
  assert.deepEqual(first.hidden, { internal: 1, upstream: 0 });
  assert.deepEqual(first.upstream.map(pr => pr.number).sort(), [21, 5], 'an upstream remote in a conversation joins outgoing coverage');
  assert.ok((await f.calls()).some(call => call.operation === 'PullUpstream' && call.variables.owner === 'External'));
  const entries = new Map(first.repositories.map(entry => [entry.repository, entry]));
  assert.deepEqual(entries.get('viewer/tool')?.agents, ['claude']);
  assert.equal(entries.get('viewer/tool')?.followed, true);
  assert.equal(entries.get('External/Upstream')?.followed, true);
  assert.equal(entries.get('external/project')?.authored, 1, 'PRs we authored make a repository involved');
  assert.equal(entries.get('viewer/other')?.followed, false);

  assert.equal((await f.service.setChoice('viewer/other', true)).followed, true);
  await f.service.setChoice('VIEWER/TOOL', false);
  assert.deepEqual(f.service.snapshot().internal.map(pr => pr.number), [2]);
  assert.equal((await stat(join(f.directory, 'repo-preferences.json'))).mode & 0o777, 0o600);
  await f.service.stop(); await f.service.start(); await settled(f.service);
  const reloaded = new Map(f.service.repositories().map(entry => [entry.repository, entry]));
  assert.equal(reloaded.get('viewer/tool')?.choice, 'mute', 'choices survive a restart and keep the known spelling');
  assert.equal((await f.service.setChoice('viewer/tool', null)).followed, true, 'clearing a choice restores the default');
  await f.service.setChoice('viewer/tool', false);
  assert.equal((await f.service.setChoice('viewer/tool', true)).choice, undefined, 'choosing the default again clears the choice');
  await assert.rejects(f.service.setChoice('not a repo', true), /owner\/name/);
  const put = await f.service.handle({ method: 'PUT', path: '/v1/repos/viewer/other', body: { follow: false } });
  assert.equal((put?.body as { followed: boolean }).followed, false);
  assert.ok(Array.isArray((await f.service.handle({ method: 'GET', path: '/v1/repos', body: undefined }))?.body));
});
