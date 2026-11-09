import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, object } from './types.js';

const challengeAge = 30_000;
const grantAge = 30_000;
const sessionAge = 8 * 60 * 60_000;
const cookieName = 'nootify_owner';
const noncePattern = /^[A-Za-z0-9_-]{32,128}$/;
const nonce = () => randomBytes(32).toString('base64url');
const mac = (token: string, ...parts: unknown[]) => createHmac('sha256', token).update(JSON.stringify(parts)).digest('base64url');
function equal(first: string, second: string): boolean {
  const a = Buffer.from(first), b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length;
    if (bytes > 4096) throw new HttpError(413, 'Authorization request is too large');
    parts.push(chunk);
  }
  try { return object(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
  catch { throw new HttpError(400, 'Invalid authorization request'); }
}
function route(value: unknown): string {
  if (value === undefined) return '#/settings/general';
  if (typeof value !== 'string' || !/^#\/[a-z-]+(?:\/[a-z-]+)?$/.test(value)) throw new HttpError(400, 'Invalid local UI route');
  return value;
}

/** One service owner's private bearer and short-lived browser grants; loopback alone is never authority. */
export class UiOwnerAuth {
  private readonly usedProofs = new Map<string, number>();
  private readonly grants = new Map<string, { host: string; route: string; expires: number }>();
  constructor(private readonly token: string) {}

  authenticated(request: IncomingMessage): boolean {
    if (equal(String(request.headers.authorization ?? ''), `Bearer ${this.token}`)) return true;
    const host = String(request.headers.host ?? '').toLowerCase();
    const cookies = String(request.headers.cookie ?? '').split(';').map(part => part.trim());
    const value = cookies.find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!value || value.length > 256) return false;
    const [id, expires, proof, extra] = value.split('.');
    return !extra && noncePattern.test(id ?? '') && /^\d{13}$/.test(expires ?? '') && Number(expires) > Date.now()
      && Number(expires) <= Date.now() + sessionAge && equal(proof ?? '', mac(this.token, 'ui-cookie', host, id, expires));
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL, local: boolean): Promise<boolean> {
    const redeem = request.method === 'GET' && url.pathname === '/' && url.searchParams.has('ui-grant');
    const authorization = url.pathname === '/ui/api/auth/challenge' || url.pathname === '/ui/api/auth/grant';
    if (!redeem && !authorization) return false;
    if (!local) { request.resume(); send(response, 403, { error: 'Owner authorization is local-only' }); return true; }
    this.prune();
    const host = String(request.headers.host ?? '').toLowerCase();
    if (redeem) {
      const key = url.searchParams.get('ui-grant')!; const grant = this.grants.get(key);
      this.grants.delete(key);
      if (!grant || grant.host !== host || grant.expires <= Date.now()) { send(response, 403, { error: 'Authorization link expired or already used' }); return true; }
      const id = nonce(), expires = String(Date.now() + sessionAge);
      const value = `${id}.${expires}.${mac(this.token, 'ui-cookie', host, id, expires)}`;
      response.writeHead(303, { location: `/${grant.route}`, 'set-cookie': `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/`,
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end(); return true;
    }
    if (url.pathname.endsWith('/challenge')) {
      request.resume();
      const client = url.searchParams.get('nonce') ?? '';
      if (request.method !== 'GET' || !noncePattern.test(client)) { send(response, 400, { error: 'Invalid authorization challenge' }); return true; }
      const challenge = nonce(), issued_at = Date.now();
      send(response, 200, { challenge, issued_at, proof: mac(this.token, 'ui-server', host, client, challenge, issued_at) });
      return true;
    }
    if (request.method !== 'POST' || request.headers['x-nootify-ui'] !== '1') { request.resume(); send(response, 403, { error: 'Owner authorization proof required' }); return true; }
    const fields = await body(request);
    const target = route(fields.route);
    if (!equal(String(request.headers.authorization ?? ''), `Bearer ${this.token}`)) {
      const { client_nonce: client, challenge, issued_at: issued, server_proof: serverProof, proof } = fields;
      if (typeof client !== 'string' || !noncePattern.test(client) || typeof challenge !== 'string' || !noncePattern.test(challenge)
        || !Number.isSafeInteger(issued) || Number(issued) > Date.now() || Date.now() - Number(issued) > challengeAge
        || typeof serverProof !== 'string' || typeof proof !== 'string'
        || !equal(serverProof, mac(this.token, 'ui-server', host, client, challenge, issued))
        || !equal(proof, mac(this.token, 'ui-client', host, client, challenge, issued, serverProof))
        || this.usedProofs.has(serverProof) || this.usedProofs.size >= 256) {
        send(response, 403, { error: 'Service owner authorization required' }); return true;
      }
      this.usedProofs.set(serverProof, Number(issued) + challengeAge);
    }
    if (this.grants.size >= 128) { send(response, 429, { error: 'Too many pending authorization links' }); return true; }
    const key = nonce(); this.grants.set(key, { host, route: target, expires: Date.now() + grantAge });
    const grantUrl = `http://${host}/?ui-grant=${key}`;
    send(response, 200, { url: grantUrl, proof: mac(this.token, 'ui-grant', host, grantUrl) });
    return true;
  }

  private prune(): void {
    for (const [key, expires] of this.usedProofs) if (expires <= Date.now()) this.usedProofs.delete(key);
    for (const [key, grant] of this.grants) if (grant.expires <= Date.now()) this.grants.delete(key);
  }
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw new Error('Cannot authorize local UI');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); throw new Error('Invalid local authorization response'); }
      chunks.push(next.value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { reader.releaseLock(); }
}

/** Prove the server owns the same private key before signing a one-use browser grant; never send that key over HTTP. */
export async function requestOwnerUiGrant(baseUrl: string, token: string, target = '#/settings/general'): Promise<string> {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || base.username || base.password || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.pathname !== '/' || base.search || base.hash) throw new Error('Owner authorization requires a local service origin');
  route(target);
  const host = base.host.toLowerCase(), client = nonce();
  const challengeUrl = new URL('/ui/api/auth/challenge', base); challengeUrl.searchParams.set('nonce', client);
  const challenge = await readResponse(await fetch(challengeUrl, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) }));
  const issued = challenge.issued_at;
  if (typeof challenge.challenge !== 'string' || !noncePattern.test(challenge.challenge) || !Number.isSafeInteger(issued)
    || Number(issued) > Date.now() || Date.now() - Number(issued) > challengeAge || typeof challenge.proof !== 'string'
    || !equal(challenge.proof, mac(token, 'ui-server', host, client, challenge.challenge, issued))) throw new Error('Local service owner identity could not be verified');
  const result = await readResponse(await fetch(new URL('/ui/api/auth/grant', base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-nootify-ui': '1' }, body: JSON.stringify({ client_nonce: client, challenge: challenge.challenge,
      issued_at: issued, server_proof: challenge.proof, proof: mac(token, 'ui-client', host, client, challenge.challenge, issued, challenge.proof), route: target }) }));
  if (typeof result.url !== 'string' || typeof result.proof !== 'string' || !equal(result.proof, mac(token, 'ui-grant', host, result.url))) throw new Error('Invalid owner authorization grant');
  const url = new URL(result.url);
  if (url.origin !== base.origin || url.pathname !== '/' || !noncePattern.test(url.searchParams.get('ui-grant') ?? '') || [...url.searchParams].length !== 1) throw new Error('Invalid owner authorization URL');
  return url.href;
}
