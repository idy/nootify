import { createHmac, timingSafeEqual } from 'node:crypto';
import { Agent, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { HttpError } from './types.js';
import { limitedJson, privateNonce, UiSessions } from './ui-session-host.js';
import type { UiCapability } from './ui-transport.js';

const challengeAge = 30_000;
const mac = (token: string, ...parts: unknown[]) => createHmac('sha256', token).update(JSON.stringify(parts)).digest('base64url');
const noncePattern = /^[A-Za-z0-9_-]{32,128}$/;
function equal(first: string, second: string): boolean {
  const a = Buffer.from(first), b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  response.end(JSON.stringify(body));
}
export function ownerUiRoute(value: unknown): string {
  if (value === undefined) return '#/logs';
  if (typeof value !== 'string' || !/^#\/[a-z-]+(?:\/[a-z-]+)?$/.test(value)) throw new HttpError(400, 'Invalid local UI route');
  return value;
}

/** Cookie-free private UI sessions. Bootstrap proofs are bound to the exact accepted TCP socket. */
export class UiOwnerAuth {
  readonly sessions = new UiSessions();
  private readonly challenges = new WeakMap<Socket, { client: string; challenge: string; issued: number; proof: string }>();
  constructor(private readonly token: string) {}
  authenticated(request: IncomingMessage): boolean {
    return equal(String(request.headers.authorization ?? ''), `Bearer ${this.token}`);
  }
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, local: boolean): Promise<boolean> {
    if (url.pathname !== '/ui/api/auth/challenge' && url.pathname !== '/ui/api/auth/grant') return false;
    if (!local) { request.resume(); send(response, 403, { error: 'Owner authorization is local-only' }); return true; }
    const host = String(request.headers.host ?? '').toLowerCase();
    if (url.pathname.endsWith('/challenge')) {
      request.resume(); const client = url.searchParams.get('nonce') ?? '';
      if (request.method !== 'GET' || !noncePattern.test(client)) throw new HttpError(400, 'Invalid authorization challenge');
      const challenge = privateNonce(), issued = Date.now();
      const proof = mac(this.token, 'ui-server', host, client, challenge, issued);
      this.challenges.set(request.socket, { client, challenge, issued, proof });
      send(response, 200, { challenge, issued_at: issued, proof }); return true;
    }
    if (request.method !== 'POST' || request.headers['x-nootify-ui'] !== '1') throw new HttpError(403, 'Owner authorization proof required');
    const expected = this.challenges.get(request.socket); this.challenges.delete(request.socket);
    const fields = await limitedJson(request, 4096) as Record<string, unknown>;
    if (!expected || !fields || expected.issued > Date.now() || Date.now() - expected.issued > challengeAge
      || fields.client_nonce !== expected.client || fields.challenge !== expected.challenge || fields.issued_at !== expected.issued || fields.server_proof !== expected.proof
      || typeof fields.proof !== 'string' || !equal(fields.proof, mac(this.token, 'ui-client', host, expected.client, expected.challenge, expected.issued, expected.proof))) {
      throw new HttpError(403, 'Service owner authorization required on the verified connection');
    }
    // A forwarding listener can relay a proof on one backend socket. Derive the
    // actual traffic key from the private PSK and complete verified transcript;
    // neither that key nor the PSK is ever returned over the HTTP connection.
    const session = this.sessions.create((id, expires) => mac(this.token, 'ui-session-key', host, expected.client, expected.challenge, expected.issued, expected.proof, id, expires));
    send(response, 200, { session: { id: session.id, expires: session.expires }, proof: mac(this.token, 'ui-session', host, expected.client, expected.challenge, expected.issued, session.id, session.expires) });
    return true;
  }
}

/** A dedicated keep-alive connection, never automatically replaced between challenge and proof. */
export async function requestOwnerUiSession(baseUrl: string, token: string): Promise<UiCapability> {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || base.username || base.password || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.pathname !== '/' || base.search || base.hash) throw new Error('Owner authorization requires a local service origin');
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  let socket: Socket | undefined;
  const exchange = (path: string, body?: unknown): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(new URL(path, base), { agent, method: text === undefined ? 'GET' : 'POST', timeout: 5000,
      headers: { 'x-nootify-ui': '1', ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}) } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4096) request.destroy(new Error('Invalid local authorization response')); else chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('Local service owner authorization is unavailable');
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        } catch (error) { reject(error); }
      });
    });
    request.once('socket', current => {
      if (socket && (current !== socket || socket.destroyed)) request.destroy(new Error('Local owner authorization connection changed'));
      else socket = current;
    });
    request.once('timeout', () => request.destroy(new Error('Local owner authorization timed out')));
    request.once('error', reject); request.end(text);
  });
  try {
    const host = base.host.toLowerCase(), client = privateNonce();
    const challenge = await exchange('/ui/api/auth/challenge?nonce=' + client);
    const issued = challenge.issued_at;
    if (typeof challenge.challenge !== 'string' || !noncePattern.test(challenge.challenge) || !Number.isSafeInteger(issued)
      || Number(issued) > Date.now() || Date.now() - Number(issued) > challengeAge || typeof challenge.proof !== 'string'
      || !equal(challenge.proof, mac(token, 'ui-server', host, client, challenge.challenge, issued))) throw new Error('Local service owner identity could not be verified');
    const result = await exchange('/ui/api/auth/grant', { client_nonce: client, challenge: challenge.challenge, issued_at: issued,
      server_proof: challenge.proof, proof: mac(token, 'ui-client', host, client, challenge.challenge, issued, challenge.proof) });
    const session = result.session as Pick<UiCapability, 'id' | 'expires'>;
    if (!session || typeof session.id !== 'string' || !noncePattern.test(session.id)
      || !Number.isSafeInteger(session.expires) || session.expires <= Date.now() || typeof result.proof !== 'string'
      || !equal(result.proof, mac(token, 'ui-session', host, client, challenge.challenge, issued, session.id, session.expires))) throw new Error('Invalid owner authorization session');
    return { ...session, key: mac(token, 'ui-session-key', host, client, challenge.challenge, issued, challenge.proof, session.id, session.expires) };
  } finally { agent.destroy(); }
}
