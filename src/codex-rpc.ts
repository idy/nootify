import WebSocket from 'ws';
import { HttpError, SessionUnavailable, RetryableDeliveryError, UnconfirmedDeliveryError } from './types.js';
import type { BackendConnection } from './types.js';

export function localEndpoint(connection: BackendConnection, protocols: string[]): URL {
  const url = new URL(connection.url);
  if (!protocols.includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Backend endpoint must be a local URL without embedded credentials');
  }
  return url;
}
export class CodexRpc {
  private socket?: WebSocket;
  private nextId = 1;
  private opening?: Promise<void>;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly connection: BackendConnection, private readonly timeout = 8000) {}
  private fail(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.socket = undefined; this.opening = undefined;
  }
  async open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const url = localEndpoint(this.connection, ['ws:', 'wss:']);
      const socket = new WebSocket(url, { handshakeTimeout: this.timeout,
        ...(this.connection.token ? { headers: { Authorization: `Bearer ${this.connection.token}` } } : {}) });
      this.socket = socket;
      socket.on('message', data => {
        let message: { id?: number; method?: string; result?: unknown; error?: { code?: number; message?: string } };
        try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
        if (message.method) {
          if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'This bridge cannot answer interactive requests' } }));
          return;
        }
        if (message.id === undefined) return;
        const request = this.pending.get(message.id); if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) {
          const detail = `Codex RPC ${message.error.code ?? 'error'}: ${message.error.message ?? 'request failed'}`;
          request.reject([-32600, -32601, -32602].includes(message.error.code ?? 0) ? new HttpError(400, detail) : new Error(detail));
        } else request.resolve(message.result);
      });
      socket.on('error', () => { if (this.socket === socket) this.fail(new SessionUnavailable('backend_unavailable')); });
      socket.on('close', () => { if (this.socket === socket) this.fail(new SessionUnavailable('backend_unavailable')); });
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(new SessionUnavailable('backend_unavailable'))); });
      await this.call('initialize', { clientInfo: { name: 'nootify', title: 'Nootify', version: '0.1.0' } });
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    })();
    const opening = this.opening;
    try { await opening; } catch (error) { if (this.opening === opening) this.close(); throw error; }
  }
  async call<T>(method: string, params: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new RetryableDeliveryError('backend_unavailable');
    const id = this.nextId++;
    let frame: string;
    try { frame = JSON.stringify({ id, method, params }); }
    catch { throw new HttpError(400, 'Codex request could not be serialized'); }
    const mutation = method === 'turn/start' || method === 'turn/steer';
    let submitted = false;
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RetryableDeliveryError(`Codex ${method} timed out`));
        }, this.timeout);
        this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
        const failed = (error: Error) => { clearTimeout(timer); this.pending.delete(id); reject(error); };
        submitted = true;
        try {
          socket.send(frame, error => { if (error) failed(error); });
        } catch (error) { failed(error as Error); }
      });
    } catch (error) {
      // A response timeout or disconnect cannot prove that a submitted turn had no effect.
      if (mutation && submitted && !(error instanceof HttpError && error.status >= 400 && error.status < 500)) {
        throw new UnconfirmedDeliveryError(`${(error as Error).message}; delivery is unconfirmed`);
      }
      throw error;
    }
  }
  close(): void { const socket = this.socket; this.fail(new SessionUnavailable('backend_unavailable')); socket?.terminate(); }
}
