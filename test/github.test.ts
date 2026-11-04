import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PullRequestsService, type PullRequest, type PullSnapshot } from '../src/github.js';
import { GitHubCommands, GitHubSignedOut, loadPullConfig, parsePullConfig, type PullCollection, type PullTargets } from '../src/github-api.js';
import { classifyPull, comparePulls, normalizePull, parseGitHubRemote, type GitHubPull } from '../src/github-model.js';

const date = '2026-10-01T00:00:00Z';
const pull = (number: number, overrides: Partial<GitHubPull> = {}): GitHubPull => ({
  id: `P${number}`, number, url: `https://github.com/external/project/pull/${number}`, title: `Pull ${number}`,
  state: 'OPEN', isDraft: false, isCrossRepository: true, updatedAt: date,
  repository: { nameWithOwner: 'external/project' }, author: { login: 'viewer' }, headRepository: { nameWithOwner: 'viewer/fork' }, ...overrides,
});
const internalPull = (number: number, repository = 'viewer/active', overrides: Partial<GitHubPull> = {}): GitHubPull => pull(number, {
  repository: { nameWithOwner: repository }, url: `https://github.com/${repository}/pull/${number}`, author: { login: 'outside-contributor' }, ...overrides,
});
function collection(internal: PullRequest[] = [], upstream: PullRequest[] = []): PullCollection {
  return { internal, upstream, warnings: [], scope: { authors: ['viewer'], ownedOwners: ['viewer', 'OurOrg'], excludeRepositories: [], localForks: [] },
    incompleteInternal: false, incompleteUpstream: false, observedUrls: [...internal, ...upstream].map(pr => pr.url.toLowerCase()) };
}
async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > end) assert.fail('Timed out waiting for refresh'); await delay(5); }
}
async function settled(service: PullRequestsService): Promise<PullSnapshot> { await waitFor(() => !service.snapshot().refresh.running); return service.snapshot(); }
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nootify-pulls-'))); const directory = join(root, 'state'); await mkdir(directory);
  const checkout = join(root, 'checkout'); await mkdir(checkout);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', checkout, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('remote', 'add', 'origin', 'https://github.com/viewer/active.git');
  git('remote', 'add', 'upstream', 'https://github.com/External/Upstream.git');
  const desktop = join(root, 'desktop/account/profile'); await mkdir(desktop, { recursive: true });
  const session = async (id: string, extra: Record<string, unknown> = {}) => writeFile(join(desktop, `${id}.json`), JSON.stringify({ sessionId: id, title: id, cwd: checkout, prs: [], ...extra }));
  await session('local_a', { title: 'Fix login', branch: 'new-session-branch', prs: [
    { repo: 'external/project', prNumber: 9, url: 'https://github.com/external/project/pull/9', branch: 'earlier-branch' },
    { repo: 'viewer/active', prNumber: 2, url: 'https://github.com/viewer/active/pull/2' },
  ] });
  let result = collection([normalizePull(internalPull(1)), normalizePull(internalPull(2))], [normalizePull(pull(9))]);
  let behavior = async (_signal: AbortSignal, _targets: PullTargets): Promise<PullCollection> => structuredClone(result);
  const calls: PullTargets[] = []; const reports: Record<string, unknown>[] = [];
  const service = new PullRequestsService(directory, record => reports.push(record), { desktopRoots: [join(root, 'desktop')] }, async (_config, _commands, signal, targets) => {
    const selected = targets ?? { repositories: [], pulls: [] };
    calls.push(structuredClone(selected)); return behavior(signal, selected);
  });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, directory, checkout, service, calls, reports, session,
    setResult: (value: PullCollection) => { result = value; },
    setBehavior: (value: typeof behavior) => { behavior = value; } };
}

test('classification separates internal destinations from outgoing contributions', () => {
  const scope = { authors: ['viewer', 'extra'], ownedOwners: ['viewer', 'OurOrg'], excludeRepositories: ['viewer/excluded'] };
  assert.equal(classifyPull(internalPull(1), scope), 'internal');
  assert.equal(classifyPull(internalPull(2, 'ourorg/project', { isCrossRepository: false }), scope), 'internal');
  assert.equal(classifyPull(pull(3), scope), 'upstream');
  assert.equal(classifyPull(pull(4, { author: { login: 'colleague' }, headRepository: { nameWithOwner: 'OurOrg/fork' } }), scope), 'upstream');
  assert.equal(classifyPull(pull(5, { headRepository: null }), scope), 'upstream');
  assert.equal(classifyPull(pull(6, { author: { login: 'unrelated' }, headRepository: { nameWithOwner: 'someone/fork' } }), scope), undefined);
  for (const pr of [pull(7, { isCrossRepository: false }), pull(8, { headRepository: { nameWithOwner: 'external/project' } }),
    pull(9, { headRepository: null, isCrossRepository: undefined }), pull(10, { state: 'MERGED' }), pull(11, { state: 'CLOSED' }), internalPull(12, 'viewer/excluded')]) assert.equal(classifyPull(pr, scope), undefined);
  assert.equal(classifyPull(pull(13, { author: { login: 'colleague' }, headRepository: { nameWithOwner: 'LocalTeam/fork' } }), { ...scope, localForks: ['localteam/fork'] }), 'upstream');
});

test('oldest-first sorting has deterministic repository and PR-number ties', () => {
  const values = [normalizePull(pull(20, { updatedAt: '2026-10-03T00:00:00Z' })), normalizePull(pull(9)), normalizePull(pull(2)),
    normalizePull(internalPull(1, 'aaa/project')), normalizePull(pull(30, { updatedAt: '' }))];
  assert.deepEqual(values.sort(comparePulls).map(pr => pr.number), [1, 2, 9, 20, 30]);
  assert.deepEqual([...values].reverse().sort(comparePulls), values);
});

test('CI and reviews preserve unknown, partial, failed and pending states', () => {
  assert.equal(normalizePull(pull(1)).ci.state, 'UNKNOWN');
  assert.equal(normalizePull(pull(2, { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })).ci.state, 'NONE');
  const warnings: string[] = [];
  const pr = normalizePull(pull(3, { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { totalCount: 104, nodes: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }, { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
    { __typename: 'StatusContext', state: 'ERROR' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
  ] } } } }] } }), warning => warnings.push(warning));
  assert.deepEqual(pr.ci, { state: 'FAILURE', passed: 1, failed: 2, pending: 1, total: 104 }); assert.match(warnings[0], /counts are partial/);
  const reviewed = normalizePull(pull(4, { headRefName: 'task', reviews: { nodes: [
    { author: { login: 'reviewer' }, state: 'APPROVED', submittedAt: date },
    { author: { login: 'reviewer' }, state: 'COMMENTED', submittedAt: '2026-10-02T00:00:00Z' },
  ] } }));
  assert.equal(reviewed.reviewDecision, 'APPROVED'); assert.equal(reviewed.headBranch, 'task');
});

test('remote parsing strips credentials and only accepts GitHub', () => {
  assert.equal(parseGitHubRemote('https://user:password@github.com/Owner/repo.git'), 'Owner/repo');
  assert.equal(parseGitHubRemote('git@github.com:Owner/repo.git'), 'Owner/repo');
  assert.equal(parseGitHubRemote('ssh://git@github.com/Owner/repo.git'), 'Owner/repo');
  assert.equal(parseGitHubRemote('https://github.com.evil.example/Owner/repo'), undefined);
  assert.equal(parseGitHubRemote('/local/repo'), undefined);
});

test('configuration reads state and explicit paths without changing owner/author overrides', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'pulls.config.json'), JSON.stringify({ authors: ['Extra', 'extra'], ownedOwners: ['ManualOrg'], upstreamOwners: ['ExternalOrg'] }));
  const loaded = await loadPullConfig(f.directory);
  assert.deepEqual(loaded.config.authors, ['extra']); assert.deepEqual(loaded.config.ownedOwners, ['ManualOrg']);
  const explicit = join(f.root, 'alternate.json'); await writeFile(explicit, JSON.stringify({ ownedOwners: ['OtherOrg'], refreshMinutes: 1 }));
  const prior = process.env.NOOTIFY_PULLS_CONFIG; process.env.NOOTIFY_PULLS_CONFIG = explicit;
  t.after(() => { if (prior === undefined) delete process.env.NOOTIFY_PULLS_CONFIG; else process.env.NOOTIFY_PULLS_CONFIG = prior; });
  const override = await loadPullConfig(f.directory);
  assert.deepEqual(override.config.ownedOwners, ['OtherOrg']); assert.match(override.warnings[0], /every 5 minutes/);
  assert.throws(() => parsePullConfig({ authors: ['bad login'] }), /GitHub logins/);
});

test('subscriptions come from session PRs and checkout repos, with exact source sessions on every PR', async t => {
  const f = await fixture(t);
  await f.session('local_b', { title: 'Feature task', branch: 'feature' });
  f.setResult(collection([normalizePull(internalPull(1, 'viewer/active', { headRefName: 'feature' })),
    normalizePull(internalPull(2, 'viewer/active', { headRefName: 'feature' })), normalizePull(internalPull(50, 'viewer/unrelated'))], [normalizePull(pull(9))]));
  await f.service.start(); const result = await settled(f.service);
  assert.deepEqual(f.calls[0].repositories.sort(), ['External/Upstream', 'viewer/active']);
  assert.deepEqual(f.calls[0].pulls.map(pull => `${pull.repository}#${pull.number}`).sort(), ['external/project#9', 'viewer/active#2']);
  assert.deepEqual(f.calls[0].localForks, ['viewer/active']);
  assert.equal(result.repositories.length, 3, 'an unrelated owned repository never becomes a candidate');
  assert.deepEqual(result.internal.map(pr => pr.number), [1, 2]);
  assert.deepEqual(result.internal[0].sessions?.map(session => session.id), ['local_b']); assert.equal(result.internal[0].subscription, 'session-branch');
  assert.deepEqual(result.internal[1].sessions?.map(session => session.id), ['local_a']); assert.equal(result.internal[1].subscription, 'session-pr', 'explicit links take precedence over a different current branch');
  const linked = result.repositories.find(entry => entry.repository === 'external/project')!;
  assert.equal(linked.allPulls, false, 'a linked PR does not subscribe to every PR in its external repository');
  assert.equal(linked.linkedPulls, 1); assert.equal(linked.sources[0].name, 'Fix login');
  assert.deepEqual(result.upstream[0].sessions?.map(session => session.id), ['local_a']);
  const detached = f.service.snapshot(); detached.repositories[0].sources.length = 0;
  assert.ok(f.service.repositories()[0].sources.length > 0, 'snapshot callers cannot mutate subscriptions');
});

test('follow choices persist, filter scoped data, and refresh query targets', async t => {
  const f = await fixture(t); await f.service.start(); await settled(f.service);
  await f.service.setChoice('VIEWER/ACTIVE', false); await settled(f.service);
  assert.deepEqual(f.service.snapshot().internal, []);
  assert.ok(!f.calls.at(-1)!.repositories.includes('viewer/active'));
  assert.ok(!f.calls.at(-1)!.pulls.some(pull => pull.repository === 'viewer/active'));
  assert.equal((await stat(join(f.directory, 'repo-preferences.json'))).mode & 0o777, 0o600);
  await f.service.stop(); await f.service.start(); await settled(f.service);
  assert.equal(f.service.repositories().find(entry => entry.repository === 'viewer/active')?.choice, 'mute');
  assert.equal((await f.service.setChoice('viewer/active', true)).choice, undefined);
  await settled(f.service); assert.equal(f.service.snapshot().internal.length, 2);
  await assert.rejects(f.service.setChoice('not a repo', true), /owner\/name/);
});

test('refresh is coalesced and failure retains the last session-scoped snapshot privately', async t => {
  const f = await fixture(t);
  f.setBehavior(async () => { await delay(60); return collection([normalizePull(internalPull(1))]); });
  await f.service.start(); for (let index = 0; index < 8; index++) f.service.refresh();
  const response = await Promise.race([f.service.handle({ method: 'POST', path: '/v1/pulls/refresh', body: {} }), delay(30).then(() => assert.fail('Refresh waited for GitHub'))]);
  assert.equal(response?.status, 202); const good = await settled(f.service); assert.equal(f.calls.length, 1);
  await f.service.stop();
  const cache = await readFile(join(f.directory, 'pulls-cache.json'), 'utf8');
  assert.equal((await stat(join(f.directory, 'pulls-cache.json'))).mode & 0o777, 0o600);
  await f.service.stop(); f.setBehavior(async () => { throw new Error('HTTP 403 ghp_fakePrivateToken'); });
  await f.service.start(); const failed = await settled(f.service);
  assert.deepEqual(failed.internal, good.internal); assert.equal(f.service.status(), 'stale');
  assert.ok(!JSON.stringify(failed).includes('ghp_fakePrivateToken'));
  assert.equal(await readFile(join(f.directory, 'pulls-cache.json'), 'utf8'), cache);
});

test('a follow change during refresh queues one fresh scoped query and stop cancels pending work', async t => {
  const f = await fixture(t); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); let count = 0;
  f.setBehavior(async () => { if (++count === 1) await gate; return collection(); });
  await f.service.start(); await waitFor(() => f.calls.length === 1);
  await f.service.setChoice('viewer/active', false); release(); await settled(f.service);
  assert.equal(f.calls.length, 2); assert.ok(!f.calls[1].repositories.includes('viewer/active'));
  let aborted = false;
  f.setBehavior(signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }); }));
  f.service.refresh(); await waitFor(() => f.calls.length === 3); await f.service.stop();
  assert.equal(aborted, true); assert.equal(f.service.status(), 'stopped');
  f.service.refresh(); await delay(10); assert.equal(f.calls.length, 3);
});

test('partial coverage only retains still-subscribed cache and never revives an observed closed PR', async t => {
  const f = await fixture(t); await f.service.start(); await settled(f.service);
  const partial = collection(); partial.incompleteInternal = true; partial.observedUrls = ['https://github.com/viewer/active/pull/1'];
  f.setResult(partial); f.service.refresh(); const result = await settled(f.service);
  assert.deepEqual(result.internal.map(pr => pr.number), [2]); assert.ok(result.warnings.some(warning => /retained 1/.test(warning)));
});

test('account-wide legacy caches cannot populate session subscriptions', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'pulls-cache.json'), JSON.stringify({ version: 2, snapshot: { ...collection([normalizePull(internalPull(50, 'viewer/unrelated'))]),
    involved: [{ repository: 'viewer/unrelated', agents: [], sessions: 0 }], refresh: { running: false, lastSuccessAt: date } } }));
  await f.service.start(); assert.equal(f.service.snapshot().internal.length, 0);
  await settled(f.service); assert.ok(!f.service.repositories().some(entry => entry.repository === 'viewer/unrelated'));
});

test('stop reaps an unresponsive child process', async t => {
  const f = await fixture(t); const script = join(f.root, 'stubborn.cjs'); const childPid = join(f.root, 'child.pid');
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`);
  const controller = new AbortController(); const commands = new GitHubCommands(f.directory, controller.signal);
  const run = (commands as unknown as { run(file: string, args: string[]): Promise<string> }).run.bind(commands);
  const pending = run(process.execPath, [script]).catch(error => error);
  await waitFor(async () => { try { await stat(childPid); return true; } catch { return false; } });
  const pid = Number(await readFile(childPid, 'utf8')); controller.abort(); await commands.stop(); await pending;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('nobody signed in keeps session subscriptions and the last data, without calling it a failure', async t => {
  const f = await fixture(t); await f.service.start(); const good = await settled(f.service);
  f.setBehavior(async () => { throw new GitHubSignedOut(); });
  f.service.refresh(); const signedOut = await settled(f.service);
  assert.deepEqual([signedOut.refresh.signedOut, signedOut.refresh.error, f.service.status()], [true, undefined, 'signed_out']);
  assert.deepEqual(signedOut.internal, good.internal);
  assert.deepEqual(signedOut.repositories.map(entry => entry.repository), good.repositories.map(entry => entry.repository));
  assert.ok(!f.reports.some(record => record.status === 'refresh_failed'));
  f.setBehavior(async () => { throw new Error('HTTP 502'); });
  f.service.refresh(); const failed = await settled(f.service);
  assert.deepEqual([failed.refresh.signedOut, failed.refresh.error, f.service.status()], [undefined, 'HTTP 502', 'stale']);
});

test('a sign-in during a refresh gets a query of its own', async t => {
  const f = await fixture(t); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setBehavior(async () => { await gate; throw new GitHubSignedOut(); });
  await f.service.start(); await waitFor(() => f.calls.length === 1);
  f.setBehavior(async () => collection([normalizePull(internalPull(1))]));
  f.service.refreshSoon(); release();
  await waitFor(() => f.calls.length === 2);
  assert.deepEqual([(await settled(f.service)).refresh.signedOut, f.service.status()], [undefined, 'ready']);
});

test('without a token the real collection stops before any request', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => assert.fail('No request may be sent without a token'));
  const f = await fixture(t);
  const service = new PullRequestsService(f.directory, () => {}, { desktopRoots: [join(f.root, 'desktop')] });
  t.after(() => service.stop());
  await service.start();
  assert.equal((await settled(service)).refresh.signedOut, true);
  assert.equal(request.mock.calls.length, 0);
});
