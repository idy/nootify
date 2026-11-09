import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { HttpError } from './types.js';
import { UiCodec, encode, type UiCapability, type UiEnvelope, type UiFrame, type UiRequest } from './ui-transport.js';

export const uiSessionAge = 8 * 60 * 60_000;
export const privateNonce = () => randomBytes(24).toString('base64url');
export function uiSessionUrl(origin: string, capability: UiCapability, route: string): string {
  return `${origin}/#${new URLSearchParams({ 'nootify-ui': `${capability.id}.${capability.key}`, route })}`;
}
export async function limitedJson(request: IncomingMessage, maximum = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); size += chunk.length;
    if (size > maximum) throw new HttpError(413, 'UI request exceeds limit');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid UI request'); }
}

export class UiSessions {
  private readonly sessions = new Map<string, { codec: UiCodec; used: Set<string> }>();
  create(deriveKey?: (id: string, expires: number) => string): UiCapability {
    for (const [id, session] of this.sessions) if (session.codec.capability.expires <= Date.now()) this.sessions.delete(id);
    if (this.sessions.size >= 32) throw new HttpError(429, 'Too many authorized UI windows');
    const id = privateNonce(), expires = Date.now() + uiSessionAge;
    const capability = { id, key: deriveKey ? deriveKey(id, expires) : randomBytes(32).toString('base64url'), expires };
    this.sessions.set(capability.id, { codec: new UiCodec(capability), used: new Set() });
    return capability;
  }
  async open(request: IncomingMessage, response: ServerResponse): Promise<IncomingMessage> {
    const value = await limitedJson(request) as UiEnvelope;
    if (!value || typeof value.id !== 'string' || typeof value.request !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.request)) throw new HttpError(403, 'Owner UI authorization required');
    const session = this.sessions.get(value.id);
    if (!session || session.codec.capability.expires <= Date.now() || session.used.has(value.request) || session.used.size >= 32768) throw new HttpError(403, 'Owner UI authorization expired');
    let input: UiRequest;
    try { input = await session.codec.open(value, value.request, 'request') as UiRequest; }
    catch { throw new HttpError(403, 'Invalid owner UI authorization'); }
    // Record before dispatch, including malformed operations; an authenticated request is never replayable.
    if (session.used.has(value.request)) throw new HttpError(403, 'Owner UI request replayed');
    session.used.add(value.request);
    if (!input || !['GET', 'POST'].includes(input.method) || typeof input.path !== 'string'
      || !/^\/ui\/api\/[a-z/-]+$/.test(input.path) || input.path === '/ui/api/secure'
      || input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 1024 * 1024)) throw new HttpError(400, 'Invalid owner UI operation');
    encryptResponse(response, session.codec, value.request);
    const inner = Readable.from(input.body === undefined ? [] : [Buffer.from(input.body)]) as IncomingMessage;
    Object.assign(inner, { method: input.method, url: input.path, headers: { ...request.headers, 'x-nootify-ui': '1' }, socket: request.socket });
    request.once('aborted', () => inner.destroy());
    return inner;
  }
}

/** Encrypt each response/stream frame before any bytes reach the HTTP socket. */
function encryptResponse(response: ServerResponse, codec: UiCodec, request: string): void {
  const networkWrite = response.write.bind(response), networkEnd = response.end.bind(response);
  response.writeHead(200, { 'content-type': 'application/x-nootify-encrypted; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  let sequence = 0; let pending = Promise.resolve(); let headersSent = false; let ended = false; let queued = 0;
  let innerStatus = 200; let innerHeaders: Record<string, string> = {};
  const append = (frame: UiFrame) => {
    queued += JSON.stringify(frame).length;
    if (queued > 4 * 1024 * 1024) { response.destroy(new Error('Encrypted UI response exceeds queue limit')); return; }
    pending = pending.then(async () => {
      const envelope = await codec.seal(frame, request, `response:${sequence++}`);
      if (!response.destroyed) networkWrite(JSON.stringify(envelope) + '\n');
      queued -= JSON.stringify(frame).length;
    }).catch(() => { response.destroy(); });
  };
  const sendHeaders = () => { if (!headersSent) { headersSent = true; append({ type: 'headers', status: innerStatus, headers: innerHeaders }); } };
  response.writeHead = ((status: number, headers?: OutgoingHttpHeaders) => {
    innerStatus = status; innerHeaders = {};
    for (const [key, value] of Object.entries(headers ?? {})) if (typeof value === 'string' && ['content-type', 'content-disposition'].includes(key.toLowerCase())) innerHeaders[key] = value;
    return response;
  }) as typeof response.writeHead;
  response.flushHeaders = sendHeaders;
  response.write = ((chunk: string | Uint8Array) => {
    if (ended || response.destroyed) return false;
    sendHeaders(); const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    // Keep authenticated frames bounded even when an API returns a large backup/summary.
    for (let offset = 0; offset < data.length; offset += 64 * 1024) append({ type: 'data', data: encode(data.subarray(offset, offset + 64 * 1024)) });
    return true;
  }) as typeof response.write;
  response.end = ((chunk?: string | Uint8Array) => {
    if (ended) return response;
    if (chunk !== undefined) response.write(chunk);
    sendHeaders(); ended = true; append({ type: 'end' });
    void pending.then(() => { if (!response.destroyed) networkEnd(); });
    return response;
  }) as typeof response.end;
}
