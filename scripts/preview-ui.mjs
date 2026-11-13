#!/usr/bin/env node
/**
 * Synthetic browser preview. Build first (`npm run build`), then launch this file
 * through preview_start. Binds loopback on PORT (default 9427); occupied ports fail.
 * Open the printed ordinary local URL to edit without an authorization link.
 * The fixture serves the same browser modules embedded by the native Go host.
 * All fixture mutations disappear on restart. No storage, agent discovery,
 * provider core, OS services, or credential resolvers are constructed here.
 * Personal channel authorization is simulated (completes after fifteen status reads).
 * Legacy registration, backup/import, and folder actions fail explicitly.
 */
import QRCode from 'qrcode';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const previewPort = Number(process.env.PORT || 9427);
if (!Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535) throw new Error('Invalid preview PORT');
export const PREVIEW_ORIGIN = `http://127.0.0.1:${previewPort}`;
const copy = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const required = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `Preview: ${field} is required`);
  return value.trim();
};
const boolean = (value, field) => {
  if (typeof value !== 'boolean') throw new HttpError(400, `Preview: ${field} must be a boolean`);
  return value;
};
const unavailable = action => () => { throw new HttpError(409, `Preview only: ${action} is unavailable. No real service or filesystem action was performed.`); };

/** Plain objects implementing the UiContext sources, with no production controllers. */
export function createPreviewFixture() {
  const now = Date.now();
  const ago = minutes => new Date(now - minutes * 60_000).toISOString();
  const nodeId = 'preview-demo-local-node';
  const appId = 'cli_0000000000000000';
  let sequence = 0;
  const sessions = [
    { session_id: 'preview-ui-001', session_name: 'Preview · Refine provider setup', adapter: 'claude-code', availability: 'active', last_seen: ago(1), last_result: 'input_accepted' },
    { session_id: 'preview-core-002', session_name: 'Preview · Improve reconnect handling', adapter: 'codex', availability: 'active', last_seen: ago(3), last_result: 'session_acknowledged' },
    { session_id: 'preview-docs-003', session_name: 'Preview · Review onboarding copy', adapter: 'opencode', availability: 'offline', last_seen: ago(48), last_result: 'session_offline' },
    { session_id: 'preview-release-004', session_name: 'Preview · Prepare release notes', adapter: 'claude-desktop', availability: 'archived', last_seen: ago(120), last_result: 'session_archived' },
  ].map(session => ({ host_id: nodeId, ...session }));
  const entries = [
    ['thread_message', 'providers', 0, 'Preview: Provider setup is ready for review. Both connection types now share the same editor.', 1],
    ['session_acknowledged', 'providers', 0, 'Preview: Received your feedback. I will tighten the form spacing next.', 2],
    ['input_accepted', 'providers', 0, 'Preview: Please check the provider form on a narrow screen.', 3],
    ['received', 'providers', 0, 'Preview: Please check the provider form on a narrow screen.', 3.2],
    ['replied', 'providers', 1, 'Preview: Reconnect checks passed. The retry keeps the original message order.', 6],
    ['thread_message', 'providers', 1, 'Preview: Running the reconnect regression checks.', 8],
    ['delivery_failed', 'providers', 2, 'Preview: The demo conversation is offline; delivery was not attempted.', 12],
    ['reconnecting', 'providers', null, 'Preview: Studio relay is reconnecting. This is a simulated connection state.', 15],
    ['ignored', 'providers', 1, 'Preview: Duplicate demo reply ignored.', 21],
    ['thread_created', 'providers', 0, 'Preview: Created a synthetic notification destination for this conversation.', 24],
    ['ready', 'host', null, 'Preview/demo mode: all data is synthetic and changes stay in memory.', 30],
  ].map(([status, source, sessionIndex, preview, minutes], index) => ({
    id: `preview-log-${index + 1}`, time: ago(minutes), status, source, preview,
    ...(sessionIndex === null ? {} : { session_id: sessions[sessionIndex].session_id, session_name: sessions[sessionIndex].session_name,
      chat_id: `oc_preview${sessionIndex}`, message_id: `om_preview${index}`, sender_open_id: 'ou_previewalex' }),
    ...(status === 'delivery_failed' ? { reason: 'session_offline', error: 'Preview: demo client is offline' } : {}),
    ...(status === 'ignored' ? { reason: 'duplicate' } : {}),
  }));
  const logs = {
    recent: () => copy(entries),
    report(record) {
      entries.unshift({ id: `preview-change-${++sequence}`, time: new Date().toISOString(), ...record });
      entries.splice(1000);
    },
    async flush() {},
  };
  const report = (source, preview) => logs.report({ source, status: 'preview_changed', preview: `Preview: ${preview}` });

  let providerRows = [
    { id: 'preview-feishu', name: 'Preview · Team Feishu', type: 'feishu', connection_type: 'bot', enabled: true, status: 'connected', app_id: appId,
      recipient_open_id: 'ou_previewalex', secret_set: true },
    { id: 'preview-personal', name: 'Preview · Personal assistant', type: 'feishu', connection_type: 'personal-app', enabled: true, status: 'connected', app_id: 'cli_1111111111111111', recipient_open_id: 'ou_previewpersonal', secret_set: true },
    { id: 'preview-remote', name: 'Preview · Studio relay', type: 'remote', enabled: true, status: 'reconnecting',
      address: 'studio-preview.invalid:9418', tls: true, server_name: 'studio-preview.invalid', token_set: true },
  ];
  let defaultProviderId = 'preview-feishu';
  const secrets = new Map([['preview-feishu', 'preview-only-feishu-secret'], ['preview-remote', 'preview-only-remote-token'], ['preview-personal', 'preview-only-personal-secret']]);
  let listenerToken = 'preview-only-listener-token';
  let remoteState = { enabled: true, listen: '127.0.0.1:9418', status: 'listening', tls: false, token_set: true,
    peers: [
      { node_id: 'preview-demo-laptop', name: 'Preview · Design laptop', connected_at: ago(45), connected: true, pending: 0, last_ack: ago(2) },
      { node_id: 'preview-demo-build', name: 'Preview · Build machine', connected_at: ago(90), connected: false, pending: 2, last_ack: ago(25) },
    ] };
  const providerPage = () => copy({ node_id: nodeId, providers: providerRows, default_provider_id: defaultProviderId, remote: remoteState });
  const findProvider = id => {
    const provider = providerRows.find(item => item.id === id);
    if (!provider) throw new HttpError(404, 'Preview: provider was not found');
    return provider;
  };
  let scan;
  const providers = {
    async page() { return providerPage(); },
    async registration(body) {
      if (body.action === 'recover') {
        if (!scan || scan.page.status === 'idle') return { status: 'idle' };
        return copy({ ...scan.page, recovery: { name: scan.name, enabled: scan.enabled, ...(scan.targetId ? { id: scan.targetId } : {}) } });
      }
      if (body.action === 'start') {
        if (scan && ['waiting', 'starting', 'connecting'].includes(scan.page.status)) throw new HttpError(409, 'Preview: a demo authorization is already active');
        const previous = body.id ? findProvider(body.id) : undefined;
        if (previous && previous.connection_type !== 'personal-app') throw new HttpError(400, 'Preview: select a personal app');
        scan = { name: required(body.name, 'name'), enabled: boolean(body.enabled, 'enabled'), targetId: previous?.id, id: previous?.id ?? `preview-personal-${++sequence}`, polls: 0,
          page: { status: 'waiting', registration_id: `preview-scan-${sequence}`, url: 'https://example.invalid/nootify-demo-authorization',
            qr: await QRCode.toDataURL('https://example.invalid/nootify-demo-authorization'), expires_at: new Date(Date.now() + 600000).toISOString() } };
      } else {
        if (!scan || body.registration_id !== scan.page.registration_id) throw new HttpError(409, 'Preview: authorization session changed');
        if (body.action === 'cancel') { if (scan.page.status !== 'complete') scan.page = { status: 'idle', registration_id: scan.page.registration_id }; }
        else if (body.action === 'status') {
          if (scan.page.status === 'waiting' && !process.argv.includes('--hold-registration') && ++scan.polls >= 15) {
            const existing = providerRows.find(row => row.id === scan.id);
            const row = { id: scan.id, name: scan.name, enabled: scan.enabled, type: 'feishu', connection_type: 'personal-app', app_id: existing?.app_id ?? 'cli_2222222222222222', recipient_open_id: 'ou_previewpersonal', secret_set: true, status: scan.enabled ? 'connected' : 'disabled' };
            providerRows = [...providerRows.filter(row => row.id !== scan.id), row]; secrets.set(scan.id, 'preview-only-personal-secret'); defaultProviderId ??= scan.id;
            scan.page = { status: 'complete', registration_id: scan.page.registration_id, provider_id: scan.id, app_id: row.app_id, setup: { app_id: row.app_id, status: 'ready', missing: [], mention_only: false } };
            report('providers', 'Completed synthetic authorization automatically; no Feishu account was contacted.');
          }
        } else throw new HttpError(400, 'Preview: invalid authorization action');
      }
      return copy(scan.page);
    },
    async setup(id) {
      const row = findProvider(id); if (row.type !== 'feishu') throw new HttpError(400, 'Preview: a Feishu app is required');
      return { app_id: row.app_id, status: 'ready', missing: [], mention_only: false };
    },
    async action(body) {
      if (body.action === 'save') {
        const config = body.provider;
        if (!object(config)) throw new HttpError(400, 'Preview: expected a provider object');
        if (!['feishu', 'remote'].includes(config.type)) throw new HttpError(400, 'Preview: unsupported provider type');
        const previous = config.id ? findProvider(config.id) : undefined;
        if (previous && previous.type !== config.type) throw new HttpError(400, 'Preview: an existing provider cannot change type');
        const id = previous?.id ?? `preview-provider-${++sequence}`;
        const name = required(config.name, 'name');
        const enabled = boolean(config.enabled, 'enabled');
        const secret = config.type === 'feishu' ? config.app_secret : config.token;
        if (secret !== undefined && typeof secret !== 'string') throw new HttpError(400, 'Preview: secret must be text');
        const savedSecret = secret?.trim() || secrets.get(id);
        if (!savedSecret) throw new HttpError(400, 'Preview: a synthetic secret is required for a new provider');
        const row = { id, name, type: config.type, enabled, status: enabled ? 'connected' : 'disabled' };
        if (config.type === 'feishu') {
          Object.assign(row, { connection_type: config.connection_type ?? previous?.connection_type ?? 'bot', app_id: required(config.app_id, 'app_id'), recipient_open_id: String(config.recipient_open_id ?? ''), secret_set: true });
        } else {
          Object.assign(row, { address: required(config.address, 'address'), tls: boolean(config.tls ?? false, 'tls'),
            server_name: String(config.server_name ?? ''), token_set: true });
        }
        secrets.set(id, savedSecret);
        if (previous) providerRows = providerRows.map(item => item.id === id ? row : item);
        else { providerRows.push(row); defaultProviderId ??= id; }
        report('providers', `${previous ? 'Updated' : 'Added'} ${name} in memory; no connection was opened.`);
      } else if (body.action === 'reconnect') {
        const row = findProvider(body.id); row.status = row.enabled ? 'connected' : 'disabled';
      } else if (body.action === 'default') {
        const provider = findProvider(body.id);
        if (!provider.enabled) throw new HttpError(400, 'Preview: enable this provider before making it default');
        defaultProviderId = provider.id;
        report('providers', `Selected ${provider.name} as the demo default.`);
      } else if (body.action === 'delete') {
        const provider = findProvider(body.id);
        providerRows = providerRows.filter(item => item.id !== provider.id);
        secrets.delete(provider.id);
        if (defaultProviderId === provider.id) defaultProviderId = undefined;
        report('providers', `Deleted ${provider.name} from the demo.`);
      } else throw new HttpError(400, 'Preview: expected a provider action: save, default or delete');
      return providerPage();
    },
    async remote() { return copy({ ...remoteState, node_id: nodeId }); },
    async configureRemote(body) {
      const enabled = boolean(body.enabled, 'enabled');
      const listen = required(body.listen, 'listen');
      const token = body.token === undefined || body.token === '' ? listenerToken : required(body.token, 'token');
      const cert = String(body.tls_cert_file ?? remoteState.tls_cert_file ?? '');
      const key = String(body.tls_key_file ?? remoteState.tls_key_file ?? '');
      if (Boolean(cert) !== Boolean(key)) throw new HttpError(400, 'Preview: provide both certificate and key paths');
      listenerToken = token;
      remoteState = { ...remoteState, enabled, listen, status: enabled ? 'listening' : 'disabled', tls: Boolean(cert),
        tls_cert_file: cert, tls_key_file: key, token_set: true,
        peers: remoteState.peers.map(peer => ({ ...peer, connected: enabled && peer.node_id === 'preview-demo-laptop' })) };
      report('providers', 'Saved demo remote configuration. No listener, certificate file, or network connection was opened.');
      return providers.remote();
    },
    async remoteSecret() { return { token: listenerToken }; },
  };

  const agentRows = [
    ['claude', 'Claude Code', 'current'], ['codex', 'Codex', 'current'], ['opencode', 'OpenCode', 'outdated'],
    ['trae', 'Trae', 'absent'], ['workbuddy', 'WorkBuddy', 'missing'],
  ].map(([agent, name, status]) => ({ agent, name: `${name} · Preview`, file: `/preview/demo/${agent}/instructions.md`, status,
    injected: ['current', 'outdated'].includes(status), block: 'Preview/demo instructions only. No agent is discovered and no prompt file is read or written.' }));
  const agents = {
    async list() { return copy(agentRows); },
    async set(agent, enabled) {
      const row = agentRows.find(item => item.agent === agent);
      if (!row) throw new HttpError(404, 'Preview: unknown agent');
      Object.assign(row, { injected: boolean(enabled, 'enabled'), status: enabled ? 'current' : 'absent' });
      report('agents', `${row.name} ${enabled ? 'enabled' : 'disabled'} in memory.`);
      return copy(row);
    },
  };

  const recipientRows = [
    { open_id: 'ou_previewalex', name: 'Preview · Alex Chen', en_name: 'Alex Chen' },
    { open_id: 'ou_previewmorgan', name: 'Preview · Morgan Lin', en_name: 'Morgan Lin' },
    { open_id: 'ou_previewtaylor', name: 'Preview · Taylor Wu', en_name: 'Taylor Wu' },
    { open_id: 'ou_previewrobin', name: 'Preview · Robin Zhou', en_name: 'Robin Zhou' },
  ];
  const feishu = () => providerRows.find(provider => provider.id === 'preview-feishu') ?? providerRows.find(provider => provider.type === 'feishu');
  const channel = () => ({ name: 'feishu', configured: Boolean(feishu()?.enabled), recipient: feishu()?.recipient_open_id, groups: sessions.length });
  const settings = {
    async page() { return { version: '0.2.0-preview', exports_dir: '/preview/demo/exports (in-memory only)', lark: {
      status: feishu()?.enabled ? 'ready' : 'disabled', configured: Boolean(feishu()), connection_type: 'bot', source: 'settings',
      app_id: feishu()?.app_id, saved: Boolean(feishu()), recipient: feishu()?.recipient_open_id, groups: sessions.length } }; },
    async larkRegistration() { return { status: 'idle' }; },
    async larkSetup() { return { app_id: feishu()?.app_id ?? appId, status: 'ready', missing: [], mention_only: false }; },
    async larkRecipients(onProgress, signal) {
      signal?.throwIfAborted();
      const directory = { app_id: feishu()?.app_id ?? appId, users: copy(recipientRows), truncated: false, permission_limited: false,
        cached: true, fetched_at: now, refresh_after: now + 86_400_000, expires_at: now + 86_400_000 };
      onProgress?.({ ...directory, users: directory.users.slice(0, 2) });
      return directory;
    },
    async setRecipient(openId, requestedAppId) {
      const provider = feishu();
      if (!provider || requestedAppId !== provider.app_id) throw new HttpError(409, 'Preview: the demo Feishu app changed');
      if (!recipientRows.some(row => row.open_id === openId)) throw new HttpError(400, 'Preview: choose a synthetic recipient');
      provider.recipient_open_id = openId;
      report('providers', 'Updated the demo recipient in memory.');
    },
    async larkSecret() { return { app_id: feishu()?.app_id, app_secret: secrets.get(feishu()?.id) ?? '' }; },
    saveLark: unavailable('legacy Feishu setup; use the Providers demo editor'), clearLark: unavailable('legacy Feishu removal; use the Providers demo editor'),
    startLarkRegistration: unavailable('Feishu registration'), cancelLarkRegistration: unavailable('Feishu registration'),
    exportConfig: unavailable('configuration export'), previewImport: unavailable('configuration import'), importConfig: unavailable('configuration import'),
    reveal: unavailable('opening system folders'),
  };
  const modules = ['sessions', 'providers', 'agents'].map(name => ({
    name, status: () => 'ready',
    async handle(request) {
      if (name === 'sessions' && request.method === 'GET' && request.path === '/v1/sessions') return { body: copy(sessions) };
      // No real control endpoints are exposed by the fixture modules.
      return undefined;
    },
  }));
  return { modules, logs, options: { providers, agents, settings, channel } };
}

export function createPreviewServer(fixture = createPreviewFixture()) {
  const { providers, agents, settings, channel } = fixture.options;
  const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  const editable = value => ({ ...value, editable: true });
  return createServer(async (request, response) => {
    const json = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    try {
      const origin = `http://${request.headers.host}`;
      if (![PREVIEW_ORIGIN, `http://localhost:${previewPort}`].includes(origin) || request.headers.origin && request.headers.origin !== origin
        || request.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(request.headers['sec-fetch-site'])) {
        throw new HttpError(403, 'Preview requests must use the local origin');
      }
      const url = new URL(request.url, origin);
      const path = url.pathname;
      if (!path.startsWith('/ui/api/')) {
        if (request.method !== 'GET' || url.search) throw new HttpError(404, 'No such preview asset');
        let asset;
        if (path === '/' || path === '/ui' || path === '/ui/') asset = 'index.html';
        else if (path === '/ui/styles.css') asset = 'styles.css';
        else if (path.startsWith('/ui/vendor/magpie/')) asset = path.slice(4);
        else if (path.startsWith('/ui/')) asset = path.slice(1);
        if (!asset || !mime[extname(asset)]) throw new HttpError(404, 'No such preview asset');
        const file = resolve(publicDirectory, asset);
        if (!file.startsWith(resolve(publicDirectory) + sep)) throw new HttpError(404, 'No such preview asset');
        let bytes;
        try { bytes = await readFile(file); } catch { throw new HttpError(404, 'No such preview asset'); }
        response.writeHead(200, { 'content-type': mime[extname(file)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.end(bytes);
        return;
      }
      if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Unsupported preview method');
      let body = {};
      if (request.method === 'POST') {
        if (request.headers['x-nootify-ui'] !== '1') throw new HttpError(403, 'UI request header required');
        const chunks = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 65536) throw new HttpError(413, 'Preview request is too large');
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
        if (!object(body)) throw new HttpError(400, 'Expected a JSON object');
      }
      const read = request.method === 'GET';
      if (path === '/ui/api/snapshot' && read) {
        const { body: sessions } = await fixture.modules[0].handle({ method: 'GET', path: '/v1/sessions' });
        return json({ time: new Date().toISOString(), sessions, logs: fixture.logs.recent(),
          modules: fixture.modules.map(module => ({ name: module.name, status: module.status() })), channel: channel(),
          access: { owner_authenticated: false, lan_url: 'http://192.168.1.20:9417/', tailscale_url: 'http://100.101.102.103:9417/' } });
      }
      if (path === '/ui/api/providers') return json(editable(await (read ? providers.page() : providers.action(body))));
      if (path === '/ui/api/providers/registration' && !read) return json(await providers.registration(body));
      if (path === '/ui/api/providers/setup' && !read) return json(await providers.setup(body.id));
      if (path === '/ui/api/settings/remote') return json(editable(await (read ? providers.remote() : providers.configureRemote(body))));
      if (path === '/ui/api/settings/remote/secret' && !read) return json(await providers.remoteSecret());
      if (path === '/ui/api/agents') {
        if (!read) await agents.set(body.agent, body.enabled);
        return json(editable({ agents: await agents.list() }));
      }
      if (path === '/ui/api/settings' && read) return json(editable(await settings.page()));
      if (path === '/ui/api/settings/lark/registration' && !read && body.action === 'status') return json(await settings.larkRegistration());
      if (path === '/ui/api/settings/lark/permissions' && !read) return json(await settings.larkSetup());
      if (path === '/ui/api/settings/lark/secret' && !read) return json(await settings.larkSecret());
      if (path === '/ui/api/settings/lark/recipients/stream' && !read) {
        const directory = await settings.larkRecipients();
        response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ type: 'complete', directory }) + '\n');
        return;
      }
      if (path === '/ui/api/settings/recipient' && !read) {
        await settings.setRecipient(body.open_id, body.app_id);
        return json(editable(await settings.page()));
      }
      throw new HttpError(409, 'Preview only: this operation is unavailable. No real service or filesystem action was performed.');
    } catch (error) {
      if (!response.headersSent) json({ error: error.message }, error.status ?? 500);
      else response.destroy();
    }
  });
}

export async function main() {
  const server = createPreviewServer();
  const close = () => { server.closeAllConnections(); server.close(); };
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(previewPort, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
    });
    server.on('error', error => { console.error(`Nootify Preview failed: ${error.message}`); close(); process.exitCode = 1; });
    console.log('Nootify Preview/demo ready. Synthetic data only; edits reset on restart.');
    console.log(`Preview URL: ${PREVIEW_ORIGIN}/#/providers`);
    console.log('Routes: #/providers, #/logs, #/sessions, #/agents, #/settings/remote, #/settings/lark');
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return server;
  } catch (error) {
    close();
    throw new Error(`Nootify Preview could not start at ${PREVIEW_ORIGIN}: ${error.message}`, { cause: error });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
