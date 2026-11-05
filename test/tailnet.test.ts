import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventLog } from '../src/events.js';
import type { PullSnapshot } from '../src/github.js';
import type { AgentId, AgentPrompt } from '../src/agents.js';
import { createServiceHost } from '../src/server.js';
import { parseTailnet, TailnetAccess } from '../src/tailnet.js';
import type { TailnetProbe } from '../src/tailnet.js';

const status = {
  BackendState: 'Running', User: { 42: { LoginName: 'owner@example.com' } },
  Self: { DNSName: 'mini.example.ts.net.', TailscaleIPs: ['fd7a:115c:a1e0::7', '100.64.0.7'], UserID: 42 },
};
function probe(peers: Record<string, string>, counts = { whois: 0 }): TailnetProbe {
  return {
    status: async () => status,
    whois: async ip => {
      counts.whois++;
      if (!(ip in peers)) throw new Error('not a tailnet peer');
      return { UserProfile: { LoginName: peers[ip] } };
    },
  };
}

test('parses this node\'s names, listening address and owner', () => {
  const parsed = parseTailnet(status)!;
  assert.deepEqual(new Set(parsed.names), new Set(['mini.example.ts.net', 'mini', '100.64.0.7', '[fd7a:115c:a1e0::7]']));
  assert.equal(parsed.address, '100.64.0.7');
  assert.equal(parsed.owner, 'owner@example.com');
  assert.equal(parseTailnet({ ...status, BackendState: 'Stopped' }), undefined);
});

test('tagged peers cannot inherit their creator\'s same-account access', async () => {
  let lookups = 0;
  const access = new TailnetAccess(80, { probe: {
    status: async () => status,
    whois: async () => { lookups++; return { Node: { Tags: ['tag:shared-server'] }, UserProfile: { LoginName: 'owner@example.com' } }; },
  } });
  assert.match((await access.authorize('100.64.0.7', '100.64.0.9'))!, /identity/);
  assert.match((await access.authorize('100.64.0.7', '100.64.0.9'))!, /identity/);
  assert.equal(lookups, 2, 'rejected tagged identities never enter the owner cache');
});

test('a request needs this node\'s address as Host and an allowed peer identity from Tailscale', async () => {
  const counts = { whois: 0 };
  const access = new TailnetAccess(9417, { probe: probe({ '100.64.0.9': 'owner@example.com', '100.64.0.10': 'tagged-devices' }, counts) });
  for (const host of ['100.64.0.7:9417', 'mini.example.ts.net:9417', 'MINI:9417', '[fd7a:115c:a1e0::7]:9417']) {
    assert.equal(await access.authorize(host, '100.64.0.9'), undefined, host);
  }
  assert.equal(counts.whois, 1, 'peer identity is cached');
  assert.equal(await access.authorize('100.64.0.7:9417', '::ffff:100.64.0.9'), undefined, 'IPv4-mapped peers resolve too');
  assert.match((await access.authorize('100.64.0.7:9417', '100.64.0.10'))!, /identity/, 'tagged agents are not the owner');
  assert.match((await access.authorize('100.64.0.7:9417', '192.168.1.20'))!, /identity/, 'non-tailnet sources are rejected');
  assert.match((await access.authorize('rebinding.example:9417', '100.64.0.9'))!, /Tailscale address/);
  assert.match((await access.authorize('127.0.0.1:9417', '100.64.0.9'))!, /Tailscale address/);
  const before = counts.whois;
  await access.authorize('100.64.0.7:9417', '192.168.1.20');
  assert.equal(counts.whois, before + 1, 'failed lookups are retried instead of cached');
  const restricted = new TailnetAccess(9417, { users: ['friend@example.com'], probe: probe({ a: 'owner@example.com', b: 'friend@example.com' }) });
  assert.match((await restricted.authorize('mini', 'a'))!, /identity/);
  assert.equal(await restricted.authorize('mini', 'b'), undefined);
  const offline = new TailnetAccess(9417, { probe: { status: async () => { throw new Error('not running'); }, whois: async () => ({}) } });
  assert.match((await offline.authorize('100.64.0.7:9417', '100.64.0.9'))!, /Tailscale address/);
});

function call(port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveCall, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolveCall({ status: response.statusCode ?? 0, body: text }));
    });
    req.once('error', reject); req.end(body);
  });
}

test('the tailnet listener serves the owner, starts background PR refreshes and keeps control APIs token-only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-tailnet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshot: PullSnapshot = { internal: [], upstream: [], hidden: { internal: 0, upstream: 0 }, repositories: [], refresh: { running: false }, warnings: ['coverage note'] };
  let refreshes = 0;
  const choices: [string, boolean | null][] = [];
  const pulls = { snapshot: () => snapshot, refresh: () => { refreshes++; },
    setChoice: async (repository: string, follow: boolean | null) => { choices.push([repository, follow]); return { repository, followed: follow !== false, agents: [], sessions: 0, sources: [], allPulls: false, linkedPulls: 0, authored: 0, pulls: { internal: 0, upstream: 0 } }; } };
  // The test listener uses loopback, so the fake Tailscale lookup maps that peer address.
  const peers: Record<string, string> = { '127.0.0.1': 'owner@example.com' };
  const tailnet = new TailnetAccess(9417, { probe: probe(peers), ttl: 0 });
  tailnet.setListening('100.64.0.7');
  const logs = await EventLog.open(dir);
  const agentCalls: [AgentId, boolean][] = [];
  const agents = { list: async (): Promise<AgentPrompt[]> => [],
    set: async (agent: AgentId, enabled: boolean): Promise<AgentPrompt> => { agentCalls.push([agent, enabled]); return { agent, name: agent, file: '/x', status: 'current', injected: enabled, block: '' }; } };
  const server = createServiceHost([], 'test-token', logs, { pulls, tailnet, agents, via: 'tailnet' });
  const local = createServiceHost([], 'test-token', logs, { pulls, tailnet, agents });
  for (const listener of [server, local]) { listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); }
  t.after(() => { for (const listener of [server, local]) { listener.closeAllConnections(); listener.close(); } });
  const port = (server.address() as AddressInfo).port;
  const owner = { host: '100.64.0.7:9417' };
  const browser = { ...owner, origin: 'http://100.64.0.7:9417', 'sec-fetch-site': 'same-origin' };

  assert.equal((await call(port, '/', owner)).status, 200);
  const page = await call(port, '/ui/api/snapshot', browser);
  assert.equal(page.status, 200);
  assert.equal(JSON.parse(page.body).access.tailnet_url, 'http://100.64.0.7:9417/');
  assert.deepEqual(JSON.parse((await call(port, '/ui/api/pulls', browser)).body), snapshot);
  assert.equal((await call(port, '/ui/api/snapshot', { host: '127.0.0.1:9417' })).status, 403, 'the tailnet listener needs its tailnet Host');
  assert.equal((await call((local.address() as AddressInfo).port, '/ui/api/snapshot', owner)).status, 403, 'the loopback listener keeps loopback Hosts');

  assert.equal((await call(port, '/ui/api/pulls/refresh', { ...browser, 'x-nootify-ui': '1' }, 'POST')).status, 202);
  assert.equal((await call(port, '/ui/api/pulls/refresh', browser, 'POST')).status, 403, 'a plain cross-site form cannot add the header');
  assert.equal((await call(port, '/ui/api/pulls/refresh', { ...browser, origin: 'http://attacker.example', 'x-nootify-ui': '1' }, 'POST')).status, 403);
  assert.equal(refreshes, 1);
  const choice = JSON.stringify({ repository: 'viewer/tool', follow: false });
  assert.equal((await call(port, '/ui/api/repos', { ...browser, 'x-nootify-ui': '1', 'content-type': 'application/json' }, 'POST', choice)).status, 200);
  assert.equal((await call(port, '/ui/api/repos', browser, 'POST', choice)).status, 403, 'follow choices need the UI header too');
  assert.equal((await call(port, '/ui/api/repos', { ...browser, 'x-nootify-ui': '1' }, 'POST', 'x'.repeat(5000))).status, 413);
  assert.deepEqual(choices, [['viewer/tool', false]]);
  const prompt = JSON.stringify({ agent: 'claude', enabled: true });
  assert.equal((await call(port, '/ui/api/agents', { ...browser, 'x-nootify-ui': '1' }, 'POST', prompt)).status, 403, 'agent prompts cannot be changed over Tailscale');
  assert.equal(JSON.parse((await call(port, '/ui/api/agents', browser)).body).editable, false);
  const localPort = (local.address() as AddressInfo).port;
  const here = { host: `127.0.0.1:${localPort}` };
  assert.equal((await call(localPort, '/ui/api/agents', { ...here, 'x-nootify-ui': '1' }, 'POST', prompt)).status, 200);
  assert.equal((await call(localPort, '/ui/api/agents', here, 'POST', prompt)).status, 403, 'the UI header is required on this Mac too');
  assert.equal((await call(localPort, '/ui/api/agents', { ...here, 'x-nootify-ui': '1' }, 'POST', JSON.stringify({ agent: 'other', enabled: true }))).status, 400);
  assert.equal(JSON.parse((await call(localPort, '/ui/api/agents', here)).body).editable, true);
  assert.deepEqual(agentCalls, [['claude', true]]);
  assert.equal((await call(port, '/v1/services', owner)).status, 401, 'a Tailscale identity is not a control-API credential');

  peers['127.0.0.1'] = 'someone@example.com';
  assert.equal((await call(port, '/ui/api/snapshot', owner)).status, 403, 'other tailnet users are rejected');
});
