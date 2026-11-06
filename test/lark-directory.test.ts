import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, type LarkApi } from '../src/lark-metadata.js';
import { larkDirectory, LarkDirectoryPermissionError, type LarkDirectory } from '../src/lark-directory.js';
import { HttpError } from '../src/types.js';

function api(read: (url: URL, signal?: AbortSignal) => unknown | Promise<unknown>): LarkApi {
  return { appId: 'cli_0123456789abcdef', async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    assert.equal(method, 'GET'); assert.equal(body, undefined);
    return await read(new URL(path, 'https://open.feishu.cn'), signal) as T;
  } };
}

test('directory expands only authorized scopes, paginates departments, deduplicates and filters inactive users', async () => {
  const calls: string[] = [];
  const directory = await larkDirectory(api((url, signal) => {
    calls.push(url.pathname); assert.ok(signal);
    assert.equal(url.searchParams.get('user_id_type') ?? 'open_id', 'open_id');
    if (url.pathname.endsWith('/scopes')) return url.searchParams.has('page_token')
      ? { department_ids: ['od-root'], group_ids: ['group-1'] } : { user_ids: ['ou_direct'], has_more: true, page_token: 'scope/page2' };
    if (url.pathname.endsWith('/users/batch')) return { items: url.searchParams.getAll('user_ids').map(id => ({ open_id: id, name: id === 'ou_direct' ? 'Alice' : 'Group member', email: 'private@example.com' })) };
    if (url.pathname.includes('/departments/od-root/children')) return { items: [{ open_department_id: 'od-child' }] };
    if (url.pathname.endsWith('/find_by_department')) {
      if (url.searchParams.get('department_id') === 'od-child') return { items: [{ open_id: 'ou_child', name: 'Child' }, { open_id: 'ou_direct', name: 'Alice' }] };
      return url.searchParams.has('page_token') ? { items: [{ open_id: 'ou_second', name: 'Second page' }] }
        : { items: [{ open_id: 'ou_root', name: 'Root' }, { open_id: 'ou_left', name: 'Left', status: { is_resigned: true } }, { user_id: 'not-an-open-id' }], has_more: true, page_token: 'users/page2' };
    }
    if (url.pathname.endsWith('/member/simplelist')) return { memberlist: url.searchParams.get('member_type') === 'user' ? [{ member_type: 'user', member_id: 'ou_group' }] : [] };
    assert.fail('Unexpected request: ' + url);
  }));
  assert.deepEqual(directory.users.map(user => user.open_id).sort(), ['ou_child', 'ou_direct', 'ou_group', 'ou_root', 'ou_second']);
  assert.equal(directory.app_id, 'cli_0123456789abcdef');
  assert.deepEqual([directory.truncated, directory.permission_limited], [false, false]);
  assert.ok(!JSON.stringify(directory).includes('private@example.com'));
  assert.ok(!calls.some(path => path.includes('/departments/0/')), 'limited-scope apps must not query the tenant root');
});

test('a user-only scope uses batch lookup without requiring department or group access', async () => {
  const directory = await larkDirectory(api(url => {
    if (url.pathname.endsWith('/scopes')) return { user_ids: ['ou_only'] };
    assert.equal(url.pathname, '/open-apis/contact/v3/users/batch');
    assert.deepEqual(url.searchParams.getAll('user_ids'), ['ou_only']);
    return { items: [{ open_id: 'ou_only', en_name: 'Only user' }] };
  }));
  assert.deepEqual(directory.users, [{ open_id: 'ou_only', name: 'Only user', en_name: 'Only user' }]);
});

test('missing group access keeps readable users and marks the directory incomplete', async () => {
  const directory = await larkDirectory(api(url => {
    if (url.pathname.endsWith('/scopes')) return { user_ids: ['ou_owner'], group_ids: ['restricted'] };
    if (url.pathname.endsWith('/users/batch')) return { items: [{ open_id: 'ou_owner', name: 'Owner' }] };
    throw new ApiError(99991672, 'raw provider text');
  }));
  assert.equal(directory.users.length, 1);
  assert.equal(directory.permission_limited, true);
});

test('scope refusal produces a useful permission error without provider text', async () => {
  await assert.rejects(larkDirectory(api(() => { throw new ApiError(99991672, 'secret-provider-text'); })), (error: unknown) => {
    assert.ok(error instanceof HttpError); assert.equal(error.status, 403);
    assert.match(error.message, /contact permissions/); assert.ok(!error.message.includes('secret-provider-text')); return true;
  });
});

test('no accessible profiles reports permission failure instead of an empty successful list', async () => {
  await assert.rejects(larkDirectory(api(url => {
    if (url.pathname.endsWith('/scopes')) return { user_ids: ['ou_owner'] };
    throw new ApiError(41050, 'outside contact scope');
  })), (error: unknown) => error instanceof HttpError && error.status === 403);
});

test('repeated pagination tokens fail promptly instead of looping', async () => {
  let count = 0;
  await assert.rejects(larkDirectory(api(() => { count++; return { has_more: true, page_token: 'same' }; })), /Could not read/);
  assert.equal(count, 2);
});

test('request failures are sanitized, and cancellation has a distinct timeout result', async () => {
  await assert.rejects(larkDirectory(api(() => { throw new Error('private auth header'); })), (error: unknown) => error instanceof HttpError && error.status === 502 && !error.message.includes('private'));
  const controller = new AbortController();
  await assert.rejects(larkDirectory(api(() => { controller.abort(); throw new Error('aborted'); }), controller.signal), (error: unknown) => error instanceof HttpError && error.status === 504);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('progress publishes users before a slow final page and preserves pagination', async () => {
  const lastPage = deferred<unknown>();
  const firstProgress = deferred<LarkDirectory>();
  let completed = false;
  const result = larkDirectory(api(url => {
    if (url.pathname.endsWith('/scopes')) return { department_ids: ['od-root'] };
    if (url.pathname.endsWith('/children')) return {};
    if (url.searchParams.has('page_token')) return lastPage.promise;
    return { items: [{ open_id: 'ou_first', name: 'First' }], has_more: true, page_token: 'last' };
  }), undefined, snapshot => firstProgress.resolve(snapshot)).then(value => { completed = true; return value; });
  const snapshot = await firstProgress.promise;
  assert.deepEqual(snapshot.users.map(user => user.open_id), ['ou_first']);
  assert.equal(completed, false);
  lastPage.resolve({ items: [{ open_id: 'ou_last', name: 'Last' }] });
  assert.equal((await result).users.length, 2);
  assert.equal(snapshot.users.length, 1, 'published snapshots do not mutate');
});

test('profile batches and departments share a four-request concurrency limit', async () => {
  let active = 0; let maximum = 0; const queries: string[] = [];
  const result = await larkDirectory(api(async url => {
    if (url.pathname.endsWith('/scopes')) return { user_ids: Array.from({ length: 250 }, (_, i) => `ou_${i}`), department_ids: ['od-one', 'od-two'] };
    active++; maximum = Math.max(maximum, active); queries.push(url.pathname + url.search);
    await turn(); active--;
    if (url.pathname.endsWith('/children')) return { items: [{ open_department_id: 'od-shared' }] };
    if (url.pathname.endsWith('/users/batch')) return { items: url.searchParams.getAll('user_ids').map(open_id => ({ open_id })) };
    return { items: [{ open_id: `ou_${url.searchParams.get('department_id')?.replaceAll('-', '')}` }] };
  }));
  assert.equal(maximum, 4);
  assert.equal(result.users.length, 253);
  assert.equal(queries.filter(query => query.includes('department_id=od-shared')).length, 1);
  assert.equal(queries.filter(query => query.includes('/users/batch')).length, 5);
});

test('first missing group permission stops all optional group expansion and retains metadata', async () => {
  const permission = { url: 'https://open.feishu.cn/app/cli_test/auth?q=contact:group:readonly', scopes: ['contact:group:readonly'] };
  let groupCalls = 0;
  const snapshots: LarkDirectory[] = [];
  const result = await larkDirectory(api(url => {
    if (url.pathname.endsWith('/scopes')) return { user_ids: ['ou_owner'], group_ids: ['one', 'two', 'three'] };
    if (url.pathname.endsWith('/users/batch')) return { items: [{ open_id: 'ou_owner' }] };
    groupCalls++; throw Object.assign(new ApiError(99991672, 'secret-provider-text'), { permission });
  }), undefined, value => snapshots.push(value));
  assert.equal(groupCalls, 1);
  assert.deepEqual(result.permission, permission);
  assert.deepEqual(snapshots.at(-1)?.permission, permission);
  assert.ok(!JSON.stringify(result).includes('secret-provider-text'));
  await assert.rejects(larkDirectory(api(() => { throw Object.assign(new ApiError(99991672, 'secret-provider-text'), { permission }); })), error => {
    assert.ok(error instanceof LarkDirectoryPermissionError);
    assert.equal(error.status, 403); assert.deepEqual(error.permission, permission);
    assert.ok(!error.message.includes('secret-provider-text')); return true;
  });
});

test('abort settles ignored signals without users or phantom results', async () => {
  const controller = new AbortController(); const started = deferred<void>();
  const result = larkDirectory(api(() => { started.resolve(); return new Promise(() => {}); }), controller.signal);
  await started.promise; controller.abort();
  await assert.rejects(result, error => error instanceof HttpError && error.status === 504);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(larkDirectory(api(() => assert.fail('must not request')), alreadyAborted.signal), error => error instanceof HttpError && error.status === 504);
});

test('abort returns partial users promptly and ignores late SDK results and callbacks', async () => {
  const controller = new AbortController(); const slowPage = deferred<unknown>(); const started = deferred<void>();
  const snapshots: LarkDirectory[] = [];
  const result = larkDirectory(api(url => {
    if (url.pathname.endsWith('/scopes')) return { department_ids: ['od-root'] };
    if (url.pathname.endsWith('/children')) return {};
    if (url.searchParams.has('page_token')) { started.resolve(); return slowPage.promise; }
    return { items: [{ open_id: 'ou_first' }], has_more: true, page_token: 'slow' };
  }), controller.signal, value => snapshots.push(value));
  await started.promise; controller.abort();
  const directory = await result;
  assert.deepEqual(directory.users.map(user => user.open_id), ['ou_first']);
  assert.equal(directory.truncated, true);
  const count = snapshots.length;
  slowPage.resolve({ items: [{ open_id: 'ou_late' }] });
  await turn();
  assert.equal(snapshots.length, count);
  assert.equal(directory.users.length, 1);
});

test('a failed parallel request settles while another SDK request hangs', async () => {
  const late = deferred<unknown>(); const snapshots: LarkDirectory[] = [];
  const result = larkDirectory(api(url => {
    if (url.pathname.endsWith('/scopes')) return { user_ids: Array.from({ length: 100 }, (_, i) => `ou_${i}`) };
    if (url.searchParams.get('user_ids') === 'ou_0') return late.promise;
    throw new Error('private upstream failure');
  }), undefined, value => snapshots.push(value));
  await assert.rejects(result, error => error instanceof HttpError && error.status === 502 && !error.message.includes('private'));
  late.resolve({ items: [{ open_id: 'ou_late' }] });
  await turn(); assert.deepEqual(snapshots, []);
});

test('large directory pagination is bounded and explicitly reports truncation', async () => {
  let requests = 0;
  const directory = await larkDirectory(api(() => ({ user_ids: [], has_more: true, page_token: String(++requests) })));
  assert.equal(requests, 100);
  assert.equal(directory.truncated, true);
});
