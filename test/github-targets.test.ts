import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectPulls, GitHubCommands, parsePullConfig, PullCollectionError } from '../src/github-api.js';
import { key, type GitHubPull } from '../src/github-model.js';

type Variables = Record<string, string | number | null>;
type Response = Awaited<ReturnType<GitHubCommands['graphql']>>;
interface Call { operation: string; query: string; variables: Variables; partial: boolean }
interface Page { nodes: (GitHubPull | null)[]; totalCount?: number; hasNextPage?: boolean; endCursor?: string | null }
interface Fixture {
  organizations?: string[];
  repositories?: Record<string, Page[]>;
  links?: GitHubPull[];
  details?: Record<string, Partial<GitHubPull> | null>;
  detailErrors?: Response['errors'];
  onCall?: (call: Call) => Response | undefined | Promise<Response | undefined>;
}
const date = '2026-10-01T00:00:00Z';
const pull = (number: number, repository = 'viewer/session', overrides: Partial<GitHubPull> = {}): GitHubPull => ({
  id: `${repository}#${number}`, number, repository: { nameWithOwner: repository }, url: `https://github.com/${repository}/pull/${number}`,
  title: `Pull ${number}`, state: 'OPEN', updatedAt: date, isDraft: false, isCrossRepository: true,
  author: { login: 'viewer' }, headRepository: { nameWithOwner: 'viewer/fork' }, ...overrides,
});
const page = <T>(nodes: T[]) => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } });

/** In-memory GraphQL only: no GitHub CLI, local repositories, or agent histories. */
class FakeCommands extends GitHubCommands {
  readonly calls: Call[] = [];
  active = 0;
  maximumActive = 0;
  constructor(private readonly fixture: Fixture = {}, signal = new AbortController().signal) { super('/unused', signal); }
  override async remotes(): Promise<{ name: string; repository: string }[]> { return assert.fail('Collection must not read git remotes.'); }
  override async graphql(query: string, variables: Variables = {}, partial = false): Promise<Response> {
    const operation = /^\s*query\s+(\w+)/.exec(query)?.[1]; assert.ok(operation, 'Only read-only queries are allowed.');
    const call = { operation, query, variables: { ...variables }, partial }; this.calls.push(call);
    this.active++; this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await new Promise<void>(done => setImmediate(done));
      const response = await this.fixture.onCall?.(call); if (response) return response;
      if (operation === 'PullViewer') return { data: { viewer: { login: 'viewer', organizations: page((this.fixture.organizations ?? []).map(login => ({ login }))) } } };
      const repository = `${variables.owner}/${variables.name}`;
      if (operation === 'PullRepository') {
        const pages = Object.entries(this.fixture.repositories ?? {}).find(([name]) => key(name) === key(repository))?.[1] ?? [{ nodes: [] }];
        const index = Number(variables.cursor ?? 0); const current = pages[index]; assert.ok(current, 'Unexpected repository page.');
        const hasNextPage = current.hasNextPage ?? index < pages.length - 1;
        return { data: { repository: { pullRequests: { nodes: structuredClone(current.nodes),
          totalCount: current.totalCount ?? pages.reduce((sum, item) => sum + item.nodes.length, 0),
          pageInfo: { hasNextPage, endCursor: current.endCursor === undefined ? hasNextPage ? String(index + 1) : null : current.endCursor },
        } } } };
      }
      if (operation === 'PullTarget') {
        const pr = this.fixture.links?.find(pr => key(pr.repository.nameWithOwner) === key(repository) && pr.number === variables.number);
        return { data: { repository: { pullRequest: pr ? structuredClone(pr) : null } } };
      }
      if (operation === 'PullDetails') {
        assert.equal(partial, true);
        const records = new Map([...Object.values(this.fixture.repositories ?? {}).flatMap(pages => pages.flatMap(page => page.nodes)), ...this.fixture.links ?? []]
          .filter((pr): pr is GitHubPull => !!pr).map(pr => [pr.id, pr]));
        const data: Response['data'] = {};
        for (const [name, id] of Object.entries(variables)) {
          assert.equal(typeof id, 'string'); const pr = records.get(id as string); assert.ok(pr, `Unknown pull ID ${id}.`);
          const detail = this.fixture.details?.[pr.id];
          data[name.replace('id', 'p')] = detail === null ? null : { id: pr.id, state: pr.state, updatedAt: pr.updatedAt,
            mergeable: 'MERGEABLE', reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
            reviews: { totalCount: 0, nodes: [] }, ...structuredClone(detail ?? {}),
          };
        }
        return { data, ...(this.fixture.detailErrors ? { errors: this.fixture.detailErrors } : {}) };
      }
      return assert.fail(`Unexpected GitHub operation ${operation}; broad searches and inventories are forbidden.`);
    } finally { this.active--; }
  }
}
const targets = (commands: FakeCommands, repositories: string[], links: GitHubPull[] = [], config: Record<string, unknown> = {}, signal = new AbortController().signal) =>
  collectPulls(parsePullConfig(config), commands, signal, { repositories, pulls: links.map(pr => ({ repository: pr.repository.nameWithOwner, number: pr.number })) });

test('only session-targeted repositories and exact PR numbers are queried, regardless of legacy discovery settings', async () => {
  const linked = pull(77, 'elsewhere/direct');
  const commands = new FakeCommands({ organizations: ['OurOrg', 'OtherOrg'], repositories: {
    'viewer/session': [{ nodes: [pull(1, 'viewer/session', { author: { login: 'someone-else' } })] }],
    'OurOrg/unrelated': [{ nodes: [pull(2, 'OurOrg/unrelated')] }],
    'viewer/unrelated': [{ nodes: [pull(3, 'viewer/unrelated')] }],
  }, links: [linked] });
  const result = await targets(commands, ['viewer/session'], [linked], { authors: ['extra'], ownedOwners: ['ManualOrg'],
    upstreamOwners: ['OtherOrg'], scanRoots: ['/must-not-be-scanned'], maxScanDepth: 0, maxSearchPages: 1, maxForkPages: 1, followDefault: 'all' });
  assert.deepEqual(result.internal.map(pr => pr.number), [1]); assert.deepEqual(result.upstream.map(pr => pr.number), [77]);
  assert.deepEqual(commands.calls.filter(call => call.operation === 'PullRepository').map(call => call.variables), [{ owner: 'viewer', name: 'session', cursor: null }]);
  assert.deepEqual(commands.calls.filter(call => call.operation === 'PullTarget').map(call => call.variables), [{ owner: 'elsewhere', name: 'direct', number: 77 }]);
  assert.deepEqual(new Set(result.scope.ownedOwners), new Set(['viewer', 'OurOrg', 'ManualOrg']));
  assert.deepEqual(result.scope.authors, ['viewer', 'extra']);
  for (const call of commands.calls) {
    assert.doesNotMatch(call.query, /\bsearch\s*\(|\brepositories\s*\(|\bisFork\b/);
    if (['PullRepository', 'PullTarget'].includes(call.operation)) assert.match(call.query, /\bheadRefName\b/);
  }
  assert.equal(result.incompleteInternal, false); assert.equal(result.incompleteUpstream, false);
  assert.ok(!result.warnings.some(warning => /local:|could not scan|authored searches/i.test(warning)));
});

test('empty default targets perform identity discovery without enumerating any PRs or forks', async () => {
  const commands = new FakeCommands({ organizations: ['OurOrg'] });
  const result = await collectPulls(parsePullConfig({ scanRoots: ['/must-not-be-scanned'] }), commands, new AbortController().signal);
  assert.deepEqual(commands.calls.map(call => call.operation), ['PullViewer']);
  assert.deepEqual(result.internal, []); assert.deepEqual(result.upstream, []); assert.deepEqual(result.observedUrls, []);
});

test('repository, exact-link and local-fork targets deduplicate case-insensitively', async () => {
  const first = pull(1); const second = pull(2, 'external/project');
  const commands = new FakeCommands({ repositories: { 'viewer/session': [{ nodes: [first] }] }, links: [first, second] });
  const result = await collectPulls(parsePullConfig({}), commands, new AbortController().signal, {
    repositories: ['Viewer/Session', 'viewer/session', 'VIEWER/SESSION'],
    pulls: [{ repository: 'VIEWER/SESSION', number: 1 }, { repository: 'viewer/session', number: 1 },
      { repository: 'External/Project', number: 2 }, { repository: 'external/project', number: 2 }],
    localForks: ['Local/Fork', 'local/fork'],
  });
  assert.equal(commands.calls.filter(call => call.operation === 'PullRepository').length, 1);
  assert.equal(commands.calls.filter(call => call.operation === 'PullTarget').length, 2);
  assert.deepEqual(result.internal.map(pr => pr.number), [1]); assert.deepEqual(result.upstream.map(pr => pr.number), [2]);
  assert.deepEqual(result.scope.localForks, ['local/fork']);
  assert.equal(commands.calls.filter(call => call.operation === 'PullDetails').flatMap(call => Object.values(call.variables)).length, 2);
});

test('explicit links retain same-repository and other-author PRs while repository lists use the existing classification', async () => {
  const sameRepository = pull(1, 'external/project', { author: { login: 'stranger' }, isCrossRepository: false, headRepository: { nameWithOwner: 'external/project' } });
  const otherAuthor = pull(2, 'elsewhere/direct', { author: { login: 'stranger' }, headRepository: { nameWithOwner: 'stranger/fork' } });
  const internal = pull(3, 'ManualOrg/project', { author: { login: 'stranger' }, isCrossRepository: false });
  const unlinked = pull(4, 'external/project', { author: { login: 'stranger' }, headRepository: { nameWithOwner: 'stranger/fork' } });
  const localFork = pull(5, 'external/project', { author: { login: 'colleague' }, headRepository: { nameWithOwner: 'Local/Fork' } });
  const extraAuthor = pull(6, 'external/project', { author: { login: 'extra' }, headRepository: null });
  const ownedFork = pull(7, 'external/project', { author: { login: 'colleague' }, headRepository: { nameWithOwner: 'OurOrg/fork' } });
  const commands = new FakeCommands({ organizations: ['OurOrg'], repositories: { 'external/project': [{ nodes: [sameRepository, unlinked, localFork, extraAuthor, ownedFork] }] },
    links: [sameRepository, otherAuthor, internal] });
  const result = await collectPulls(parsePullConfig({ authors: ['extra'], ownedOwners: ['ManualOrg'] }), commands, new AbortController().signal, {
    repositories: ['external/project'], pulls: [sameRepository, otherAuthor, internal].map(pr => ({ repository: pr.repository.nameWithOwner, number: pr.number })),
    localForks: ['local/fork'],
  });
  assert.deepEqual(result.internal.map(pr => pr.number), [3]);
  assert.deepEqual(result.upstream.map(pr => pr.number), [2, 1, 5, 6, 7]);
});

test('closed and merged links remain observed during partial coverage, even when an older open repository page arrives later', async () => {
  const closed = pull(1, 'viewer/session', { state: 'CLOSED' }); const merged = pull(2, 'external/project', { state: 'MERGED' });
  const commands = new FakeCommands({ repositories: {
    'viewer/session': [{ nodes: [{ ...closed, state: 'OPEN' }], totalCount: 200, hasNextPage: true }],
    'external/project': [{ nodes: [{ ...merged, state: 'OPEN' }], totalCount: 200, hasNextPage: true }],
  }, links: [closed, merged], onCall: async call => {
    if (call.operation === 'PullRepository') await new Promise<void>(done => setImmediate(done));
    return undefined;
  } });
  const result = await targets(commands, ['viewer/session', 'external/project'], [closed, merged], { maxUpstreamPages: 1 });
  assert.deepEqual(result.internal, []); assert.deepEqual(result.upstream, []);
  assert.deepEqual(new Set(result.observedUrls), new Set([key(closed.url), key(merged.url)]));
  assert.equal(result.incompleteInternal, true); assert.equal(result.incompleteUpstream, true);
  assert.ok(result.warnings.some(warning => /truncated/.test(warning)));
  assert.ok(!commands.calls.some(call => call.operation === 'PullDetails'));
});

test('excluded repositories are skipped for both listing and direct links regardless of case', async () => {
  const excluded = pull(1, 'OurOrg/Excluded'); const included = pull(2);
  const commands = new FakeCommands({ repositories: { 'viewer/session': [{ nodes: [included] }] }, links: [excluded, included] });
  const result = await targets(commands, ['OURORG/EXCLUDED', 'viewer/session'], [excluded, included], { excludeRepositories: ['ourorg/excluded'] });
  assert.deepEqual(result.internal.map(pr => pr.number), [2]); assert.deepEqual(result.upstream, []);
  assert.ok(commands.calls.filter(call => ['PullRepository', 'PullTarget'].includes(call.operation)).every(call => key(`${call.variables.owner}/${call.variables.name}`) === 'viewer/session'));
  assert.ok(!result.observedUrls.includes(key(excluded.url)));
});

test('both queues sort oldest first after review, CI and mergeability enrichment', async () => {
  const oldest = pull(2); const tied = pull(9); const newest = pull(20, 'viewer/session', { updatedAt: '2026-10-03T00:00:00Z' });
  const upstreamNew = pull(1, 'external/project', { updatedAt: '2026-10-03T00:00:00Z' }); const upstreamOld = pull(3, 'external/project');
  const commands = new FakeCommands({ repositories: { 'viewer/session': [{ nodes: [newest, tied, oldest] }] }, links: [upstreamNew, upstreamOld], details: {
    [oldest.id]: { updatedAt: '2026-09-01T00:00:00Z', mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED', commits: { nodes: [{ commit: { statusCheckRollup: {
      state: 'FAILURE', contexts: { totalCount: 1, nodes: [{ __typename: 'StatusContext', state: 'FAILURE' }] },
    } } }] } },
  } });
  const result = await targets(commands, ['viewer/session'], [upstreamNew, upstreamOld]);
  assert.deepEqual(result.internal.map(pr => pr.number), [2, 9, 20]); assert.deepEqual(result.upstream.map(pr => pr.number), [3, 1]);
  assert.equal(result.internal[0].mergeable, 'CONFLICTING'); assert.equal(result.internal[0].reviewDecision, 'CHANGES_REQUESTED');
  assert.deepEqual(result.internal[0].ci, { state: 'FAILURE', passed: 0, failed: 1, pending: 0, total: 1 });
});

test('missing and partial detail results warn per PR without discarding healthy details or reviving closed links', async () => {
  const missing = pull(1); const partial = pull(2); const healthy = pull(3); const closes = pull(4, 'external/direct');
  const commands = new FakeCommands({ repositories: { 'viewer/session': [{ nodes: [missing, partial, healthy] }] }, links: [closes],
    details: { [missing.id]: null, [closes.id]: { state: 'CLOSED' } },
    detailErrors: [{ path: ['p1', 'commits'], message: 'Checks permission denied' }, { path: ['p3', 'reviews'], message: 'Reviews permission denied' }],
  });
  const result = await targets(commands, ['viewer/session'], [closes]);
  assert.deepEqual(result.internal.map(pr => pr.ci.state), ['UNKNOWN', 'UNKNOWN', 'NONE']); assert.deepEqual(result.upstream, []);
  assert.equal(result.internal[0].reviewDecision, 'UNKNOWN'); assert.equal(result.internal[1].mergeable, 'UNKNOWN');
  assert.equal(result.internal[2].mergeable, 'MERGEABLE');
  assert.ok(result.warnings.some(warning => /viewer\/session#1:.*details unavailable/.test(warning)));
  assert.ok(result.warnings.some(warning => /viewer\/session#2:.*Checks permission denied/.test(warning)));
  assert.ok(result.observedUrls.includes(key(closes.url)));
  assert.equal(result.incompleteInternal, false); assert.equal(result.incompleteUpstream, false);
});

test('an incomplete detail object and a failed detail batch preserve PRs with UNKNOWN values and warnings', async t => {
  for (const failure of ['missing-fields', 'failed-batch']) await t.test(failure, async () => {
    const pr = pull(1);
    const commands = new FakeCommands({ links: [pr], onCall: call => {
      if (call.operation !== 'PullDetails') return;
      if (failure === 'failed-batch') throw new Error('Details permission denied');
      return { data: { p0: { id: pr.id, state: pr.state, updatedAt: pr.updatedAt } } };
    } });
    const result = await targets(commands, [], [pr]);
    assert.equal(result.internal[0].ci.state, 'UNKNOWN'); assert.equal(result.internal[0].reviewDecision, 'UNKNOWN');
    assert.ok(result.warnings.some(warning => failure === 'failed-batch' ? /details:.*UNKNOWN.*permission denied/.test(warning) : /Missing fields:/.test(warning)));
  });
});

test('repository pagination reports invisible nodes and truncation for the affected queue only', async t => {
  await t.test('internal invisible node', async () => {
    const commands = new FakeCommands({ repositories: { 'viewer/session': [{ nodes: [pull(1)] }, { nodes: [null, pull(2)] }] } });
    const result = await targets(commands, ['viewer/session']);
    assert.deepEqual(commands.calls.filter(call => call.operation === 'PullRepository').map(call => call.variables.cursor), [null, '1']);
    assert.deepEqual(result.internal.map(pr => pr.number), [1, 2]);
    assert.equal(result.incompleteInternal, true); assert.equal(result.incompleteUpstream, false);
    assert.ok(result.warnings.some(warning => /node was not visible/.test(warning)));
  });
  await t.test('upstream truncation', async () => {
    const commands = new FakeCommands({ repositories: { 'external/project': [{ nodes: [pull(1, 'external/project')], totalCount: 200, hasNextPage: true }] } });
    const result = await targets(commands, ['external/project'], [], { maxUpstreamPages: 1 });
    assert.equal(result.incompleteInternal, false); assert.equal(result.incompleteUpstream, true);
    assert.ok(result.warnings.some(warning => /repository:external\/project: truncated at 1 of 200/.test(warning)));
  });
});

test('a failed repository or exact-link source fails the collection rather than replacing a good snapshot', async t => {
  for (const operation of ['PullRepository', 'PullTarget']) await t.test(operation, async () => {
    const linked = pull(1, 'external/direct');
    const commands = new FakeCommands({ links: [linked], onCall: call => {
      if (call.operation === operation) return { data: { repository: null } };
      return undefined;
    } });
    await assert.rejects(targets(commands, ['viewer/session'], [linked]), error => {
      assert.ok(error instanceof PullCollectionError); assert.match(error.message, /GitHub source collection failed/);
      assert.ok(error.warnings.some(warning => /Coverage for this source failed/.test(warning))); return true;
    });
    assert.ok(!commands.calls.some(call => call.operation === 'PullDetails'));
  });
});

test('target queries keep concurrency bounded and detail batches contain at most eight PRs', async () => {
  const repositories = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`viewer/session${index}`, [{ nodes: Array.from({ length: 3 }, (_, number) => pull(number + 1, `viewer/session${index}`)) }]]));
  const commands = new FakeCommands({ repositories });
  const result = await targets(commands, Object.keys(repositories));
  assert.equal(result.internal.length, 36); assert.equal(commands.maximumActive, 4);
  const batches = commands.calls.filter(call => call.operation === 'PullDetails');
  assert.equal(batches.length, 5); assert.ok(batches.every(call => Object.keys(call.variables).length <= 8));
});

test('abort prevents queued target queries and is never converted into a partial result', async () => {
  const controller = new AbortController(); const reason = new Error('Stopped refresh');
  const commands = new FakeCommands({ onCall: call => { if (call.operation === 'PullRepository') controller.abort(reason); return undefined; } }, controller.signal);
  await assert.rejects(targets(commands, Array.from({ length: 12 }, (_, index) => `viewer/session${index}`), [], {}, controller.signal), error => error === reason);
  assert.ok(commands.calls.filter(call => call.operation === 'PullRepository').length <= 4);
  assert.ok(!commands.calls.some(call => call.operation === 'PullDetails'));
  const untouched = new FakeCommands();
  await assert.rejects(targets(untouched, ['viewer/session'], [], {}, controller.signal), error => error === reason);
  assert.deepEqual(untouched.calls, []);
});

test('GitHubCommands passes numeric PR variables with gh -F and still rejects mutations', async t => {
  const commands = new GitHubCommands('/unused', new AbortController().signal);
  t.mock.method(commands, 'findGh', async () => '/fake/gh');
  const run = t.mock.method(commands as unknown as { run: (file: string, args: string[]) => Promise<string> }, 'run', async (_file: string, _args: string[]) => JSON.stringify({ data: {} }));
  await commands.graphql('query PullTarget($owner: String!, $number: Int!, $cursor: String) { viewer { login } }', { owner: 'viewer', number: 42, cursor: null });
  const [file, args] = run.mock.calls[0].arguments;
  assert.equal(file, '/fake/gh');
  assert.deepEqual(args.slice(-6), ['-f', 'owner=viewer', '-F', 'number=42', '-F', 'cursor=null']);
  await assert.rejects(commands.graphql('mutation Update { viewer { login } }'), /Only read-only/);
  assert.equal(run.mock.calls.length, 1);
});
