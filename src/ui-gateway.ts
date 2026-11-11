import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ownerUiRoute, requestOwnerUiSession } from './ui-owner-auth.js';
import { UiSessions, uiSessionUrl } from './ui-session-host.js';
import { UiTransport } from './ui-transport.js';
import { serveUiAsset } from './ui.js';
import { HttpError } from './types.js';

export interface OwnerUiGateway { url: string; close(): Promise<void> }
/** The independent gateway owns its origin and its static code for the complete browser session. */
export async function startOwnerUiGateway(baseUrl: string, token: string, target?: string): Promise<OwnerUiGateway> {
  const route = ownerUiRoute(target);
  let upstream: UiTransport | undefined;
  let authorizing: Promise<UiTransport> | undefined;
  let closed = false;
  const owned = new Set<UiTransport>();
  const retire = async (transport: UiTransport): Promise<void> => {
    try { await transport.close(); } catch { /* Idle expiry remains the fallback if the daemon is gone. */ }
    finally { owned.delete(transport); }
  };
  const connection = async (): Promise<UiTransport> => {
    if (closed) throw new HttpError(503, 'Owner UI gateway is closing');
    if (upstream) return upstream;
    if (authorizing) return authorizing;
    // Install the promise before awaiting proof: all simultaneous requests share
    // one fresh session, including while an interrupted connection is replaced.
    const pending = requestOwnerUiSession(baseUrl, token).then(async capability => {
      const transport = new UiTransport(new URL(baseUrl).origin, capability);
      owned.add(transport);
      if (closed) {
        await retire(transport);
        throw new HttpError(503, 'Owner UI gateway is closing');
      }
      upstream = transport;
      return transport;
    });
    authorizing = pending;
    try { return await pending; }
    finally { if (authorizing === pending) authorizing = undefined; }
  };
  await connection();
  const sessions = new UiSessions();
  const capability = sessions.create();
  let origin = ''; let stopping: Promise<void> | undefined;
  const send = (response: ServerResponse, status: number, error: string) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error }));
  };
  const proxy = async (request: IncomingMessage, response: ServerResponse) => {
    const cancelled = new AbortController();
    const disconnected = () => cancelled.abort();
    response.once('close', disconnected);
    if (response.destroyed || request.socket.destroyed) cancelled.abort();
    // One deadline covers both attempts, including time spent awaiting shared proof.
    const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(185000)]);
    let active: UiTransport | undefined;
    let accepted = false;
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      let result: Response;
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        active = await connection();
        // One cancelled waiter must neither cancel shared proof nor replay on its result.
        signal.throwIfAborted();
        try {
          result = await active.fetch(request.url!, { method: request.method, ...(body ? { body } : {}), signal });
          break;
        } catch (error) {
          // fetch resolves only after authenticated headers. Retry a read once on a
          // fresh verified session; mutations may already have taken effect.
          if (signal.aborted || request.method !== 'GET' || attempt !== 0) throw error;
          if (upstream === active) upstream = undefined;
          void retire(active);
          active = undefined;
        }
      }
      accepted = true;
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) {
        const reader = result.body.getReader();
        try { for (;;) { const value = await reader.read(); if (value.done || response.destroyed) break; response.write(value.value); } }
        finally { await reader.cancel(); }
      }
      response.end();
    } catch {
      if (cancelled.signal.aborted) return;
      if (active) {
        if (upstream === active) upstream = undefined;
        void retire(active);
      }
      // Authenticated headers (including error statuses) and partial streams are final.
      if (accepted) response.destroy();
      else send(response, 502, 'The authenticated background service connection was interrupted');
    } finally { response.off('close', disconnected); }
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host) throw new HttpError(403, 'Unexpected UI gateway host');
      const url = new URL(request.url ?? '/', origin);
      if (request.headers.origin && request.headers.origin !== origin) throw new HttpError(403, 'Cross-origin UI requests are not accepted');
      if (url.pathname === '/ui/api/secure') {
        if (request.method !== 'POST' || request.headers['x-nootify-ui'] !== '1'
          || request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) throw new HttpError(403, 'Owner UI authorization required');
        const inner = await sessions.open(request, response);
        if (!inner) return;
        resetIdle(); await proxy(inner, response); return;
      }
      if (request.method === 'GET' && !url.search && await serveUiAsset(response, url.pathname)) return;
      throw new HttpError(403, 'Open a fresh owner UI authorization link');
    } catch (error) { if (!response.destroyed) send(response, error instanceof HttpError ? error.status : 502, error instanceof HttpError ? error.message : 'Owner UI gateway is unavailable'); }
  });
  try {
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); }); });
  } catch (error) {
    closed = true;
    await Promise.all([...owned].map(retire));
    throw error;
  }
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = (): Promise<void> => stopping ??= (async () => {
    closed = true;
    clearTimeout(idle); clearTimeout(lifetime); sessions.clear();
    upstream = undefined;
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>(done => server.close(() => done())),
      ...[...owned].map(retire),
      // A proof already in flight may still issue a capability. connection()
      // observes closed and revokes that result before this close completes.
      authorizing?.catch(() => {}),
    ]);
  })();
  let idle: NodeJS.Timeout;
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => { void close(); }, 2 * 60_000); idle.unref(); };
  const lifetime = setTimeout(() => { void close(); }, 8 * 60 * 60_000); lifetime.unref(); resetIdle();
  return { url: uiSessionUrl(origin, capability, route), close };
}

/** Browser mode outlives the one-shot CLI. Its private key travels only through an anonymous stdin pipe. */
export async function launchOwnerUiGateway(baseUrl: string, token: string, target?: string): Promise<string> {
  ownerUiRoute(target);
  const allowed = /^(PATH|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./ui-gateway.js', import.meta.url))], { detached: true, windowsHide: true, env, stdio: ['pipe', 'pipe', 'ignore'] });
  return new Promise<string>((done, fail) => {
    let output = ''; let settled = false;
    const timer = setTimeout(() => finish(new Error('Owner UI gateway startup timed out')), 15000);
    const finish = (error?: Error, url?: string) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.stdin.destroy(); child.stdout.destroy();
      if (error) { child.kill(); fail(error); } else { child.unref(); done(url!); }
    };
    child.once('error', () => finish(new Error('Cannot launch owner UI gateway')));
    child.once('exit', () => { if (!settled) finish(new Error('Owner UI gateway stopped before ready')); });
    child.stdin.once('error', () => finish(new Error('Cannot initialize owner UI gateway')));
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 4096) return finish(new Error('Invalid owner UI gateway response'));
      if (!output.includes('\n')) return;
      try {
        const result = JSON.parse(output.slice(0, output.indexOf('\n'))) as { url: string };
        const url = new URL(result.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || !url.hash.startsWith('#nootify-ui=')) throw new Error();
        finish(undefined, url.href);
      } catch { finish(new Error('Invalid owner UI gateway response')); }
    });
    child.stdin.end(JSON.stringify({ baseUrl, token, target }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 16384) throw new Error('Invalid gateway initialization'); chunks.push(Buffer.from(chunk)); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { baseUrl: string; token: string; target?: string };
    const gateway = await startOwnerUiGateway(input.baseUrl, input.token, input.target);
    process.stdout.end(JSON.stringify({ url: gateway.url }) + '\n');
    process.once('SIGTERM', () => { void gateway.close(); });
    process.once('SIGINT', () => { void gateway.close(); });
  })().catch(() => { process.stderr.write('Owner UI gateway initialization failed\n'); process.exitCode = 1; });
}
