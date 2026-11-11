/** Browser-safe authenticated framing. Capabilities stay in memory and never enter HTTP headers, cookies or storage. */
export interface UiCapability { id: string; key: string; expires: number }
export interface UiEnvelope { id: string; request: string; iv: string; data: string }
export const uiNonce = (): string => encode(crypto.getRandomValues(new Uint8Array(24)));
export function encode(value: Uint8Array): string {
  let text = ''; for (const byte of value) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid UI envelope');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}
const bytes = (value: string) => new TextEncoder().encode(value);
const aad = (id: string, request: string, direction: string) => bytes(JSON.stringify(['nootify-ui-v1', id, request, direction]));
export class UiCodec {
  private readonly key: Promise<CryptoKey>;
  constructor(readonly capability: UiCapability) {
    const key = decode(capability.key);
    if (key.length !== 32 || !/^[A-Za-z0-9_-]{32}$/.test(capability.id)) throw new Error('Invalid UI capability');
    this.key = crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async seal(value: unknown, request: string, direction: string): Promise<UiEnvelope> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(this.capability.id, request, direction) }, await this.key, bytes(JSON.stringify(value)));
    return { id: this.capability.id, request, iv: encode(iv), data: encode(new Uint8Array(encrypted)) };
  }
  async open(envelope: UiEnvelope, request: string, direction: string): Promise<unknown> {
    if (envelope.id !== this.capability.id || envelope.request !== request || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') throw new Error('Invalid UI envelope');
    const iv = decode(envelope.iv); if (iv.length !== 12) throw new Error('Invalid UI envelope');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(this.capability.id, request, direction) }, await this.key, decode(envelope.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }
}
export interface UiRequest { method: string; path: string; body?: string }
export type UiFrame = { type: 'headers'; status: number; headers: Record<string, string> } | { type: 'data'; data: string } | { type: 'end' };

/** No fallback to plaintext after a capability has been accepted, including failed/replaced listeners. */
export class UiTransport {
  private readonly codec?: UiCodec;
  private broken = false;
  private revocation?: Promise<void>;
  constructor(private readonly origin: string, capability?: UiCapability, private readonly network: typeof fetch = globalThis.fetch.bind(globalThis)) {
    if (capability) this.codec = new UiCodec(capability);
  }
  get authorized(): boolean { return !!this.codec && !this.broken; }
  close(): Promise<void> {
    if (!this.codec) return Promise.resolve();
    return this.revocation ??= (async () => {
      try { await (await this.fetch('/ui/api/auth/revoke', { method: 'POST', signal: AbortSignal.timeout(1500) })).text(); }
      finally { this.broken = true; }
    })();
  }
  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith('/ui/api/') || url.search || url.hash) throw new Error('Invalid UI request target');
    if (!this.codec) {
      const method = init.method ?? 'GET';
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      const repositoryAction = method === 'POST' && !local && ['/ui/api/repos', '/ui/api/pulls/refresh'].includes(url.pathname);
      if (method !== 'GET' && !(method === 'POST' && local) && !repositoryAction) throw new Error('Local access is required');
      const headers = new Headers(init.headers);
      if (method === 'POST') headers.set('x-nootify-ui', '1');
      return this.network(url, { ...init, headers, credentials: 'omit', redirect: 'error' });
    }
    // Revocation is an idempotent encrypted control request, safe to attempt
    // even after a broken response. It never revives ordinary API authority.
    const revoking = url.pathname === '/ui/api/auth/revoke' && init.method === 'POST';
    if (this.broken && !revoking) throw new Error('The authorized UI connection was lost; authorize this window again');
    const request = uiNonce();
    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('Unsupported UI request body');
    const payload: UiRequest = { method: init.method ?? 'GET', path: url.pathname, ...(typeof body === 'string' ? { body } : {}) };
    const envelope = await this.codec.seal(payload, request, 'request');
    let received = false;
    try {
      const response = await this.network(new URL('/ui/api/secure', this.origin), { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-nootify-ui': '1' }, body: JSON.stringify(envelope), ...(init.signal ? { signal: init.signal } : {}) });
      received = true;
      if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/x-nootify-encrypted')) throw new Error('The UI listener could not be authenticated');
      const reader = response.body.getReader(); let buffer = ''; let sequence = 0; let ended = false;
      const next = async (): Promise<UiFrame> => {
        while (!buffer.includes('\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('The authenticated UI response was interrupted');
          buffer += new TextDecoder().decode(chunk.value);
          if (buffer.length > 4 * 1024 * 1024) throw new Error('UI frame exceeds limit');
        }
        const newline = buffer.indexOf('\n'); const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        return await this.codec!.open(JSON.parse(line) as UiEnvelope, request, `response:${sequence++}`) as UiFrame;
      };
      const first = await next();
      if (first.type !== 'headers' || !Number.isInteger(first.status) || first.status < 200 || first.status > 599) throw new Error('Invalid authenticated UI response');
      const stream = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try {
            const frame = await next();
            if (frame.type === 'end') {
              // END authenticates completion; natural EOF must follow. Cancelling a
              // successful HTTP body here turns every normal poll into ERR_ABORTED.
              if (buffer.trim() || !(await reader.read()).done) throw new Error('Unexpected bytes after authenticated UI completion');
              ended = true; reader.releaseLock(); controller.close();
            }
            else if (frame.type === 'data') controller.enqueue(decode(frame.data));
            else throw new Error('Invalid authenticated UI frame');
          } catch (error) { if (!init.signal?.aborted) this.broken = true; controller.error(error); await reader.cancel(); }
        },
        cancel: async () => { if (!ended) await reader.cancel(); },
      });
      return new Response(stream, { status: first.status, headers: first.headers });
    } catch (error) { if (received && !init.signal?.aborted) this.broken = true; throw error; }
  };
}

export function browserUiTransport(location: Location, history: History): UiTransport {
  const parameters = new URLSearchParams(location.hash.slice(1));
  const capsule = parameters.get('nootify-ui');
  let capability: UiCapability | undefined;
  if (capsule) {
    // Clear even malformed capsules before imports, links or later navigations can observe them.
    const route = parameters.get('route');
    history.replaceState(null, '', location.pathname + (/^#\/[a-z-]+(?:\/[a-z-]+)?$/.test(route ?? '') ? route : '#/logs'));
    const [id, key, extra] = capsule.split('.');
    if (!extra && /^[A-Za-z0-9_-]{32}$/.test(id ?? '') && /^[A-Za-z0-9_-]{43}$/.test(key ?? '')) capability = { id: id!, key: key!, expires: Number.MAX_SAFE_INTEGER };
  }
  return new UiTransport(location.origin, capability);
}
