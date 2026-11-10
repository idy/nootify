import type { TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

let active = 0;
export async function settleUiFixture(): Promise<void> {
  // Let WebCrypto completions and the UI's follow-on rendering settle before its
  // synthetic document globals are removed. No production network is involved.
  let quiet = 0;
  for (let attempt = 0; attempt < 1000 && quiet < 8; attempt++) {
    await delay(2); quiet = active === 0 ? quiet + 1 : 0;
  }
}
import { UiCodec, encode, type UiEnvelope, type UiRequest } from '../src/ui-transport.js';

/** Adapt existing synthetic API fixtures to the real browser encryption boundary. No production auth bypass. */
export function authorizeUiFixture(t: TestContext): void {
  for (const method of ['encrypt', 'decrypt'] as const) {
    const operation = crypto.subtle[method].bind(crypto.subtle);
    t.mock.method(crypto.subtle, method, async (...args: Parameters<typeof operation>) => {
      active++; try { return await operation(args[0], args[1], args[2]); } finally { active--; }
    });
  }
  const capability = { id: randomBytes(24).toString('base64url'), key: randomBytes(32).toString('base64url'), expires: Date.now() + 60000 };
  const codec = new UiCodec(capability);
  const route = location.hash;
  location.hash = new URLSearchParams({ 'nootify-ui': `${capability.id}.${capability.key}`, route }).toString();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'history');
  Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState(_data: unknown, _title: string, value: string) { location.href = new URL(value, location.href).href; } } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'history', descriptor); else Reflect.deleteProperty(globalThis, 'history'); });
  const api = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    active++;
    try {
    const envelope = JSON.parse(String(init?.body)) as UiEnvelope;
    const input = await codec.open(envelope, envelope.request, 'request') as UiRequest;
    const response = await api(input.path, { ...init, method: input.method, body: input.body });
    let sequence = 0;
    const lines: string[] = [];
    lines.push(JSON.stringify(await codec.seal({ type: 'headers', status: response.status, headers: Object.fromEntries(response.headers) }, envelope.request, `response:${sequence++}`)));
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length) lines.push(JSON.stringify(await codec.seal({ type: 'data', data: encode(body) }, envelope.request, `response:${sequence++}`)));
    lines.push(JSON.stringify(await codec.seal({ type: 'end' }, envelope.request, `response:${sequence++}`)));
    return new Response(lines.join('\n') + '\n', { headers: { 'content-type': 'application/x-nootify-encrypted' } });
    } finally { active--; }
  });
}
