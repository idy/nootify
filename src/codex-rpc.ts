import WebSocket from 'ws';
import { SessionUnavailable } from './types.js';
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
        if (message.error) request.reject(new Error(`Codex RPC ${message.error.code ?? 'error'}: ${message.error.message ?? 'request failed'}`));
        else request.resolve(message.result);
      });
      socket.on('error', () => { if (this.socket === socket) this.fail(new SessionUnavailable('backend_unavailable')); });
      socket.on('close', () => { if (this.socket === socket) this.fail(new SessionUnavailable('backend_unavailable')); });
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(new SessionUnavailable('backend_unavailable'))); });
      await this.call('initialize', { clientInfo: { name: 'nootify', title: 'Nootify', version: '0.1.0' } });
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    })();
    try { await this.opening; } catch (error) { this.close(); throw error; }
  }
  async call<T>(method: string, params: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new SessionUnavailable('backend_unavailable');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out; delivery is unconfirmed`)); }, this.timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      socket.send(JSON.stringify({ id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new SessionUnavailable('backend_unavailable')); }
      });
    });
  }
  close(): void { const socket = this.socket; this.fail(new SessionUnavailable('backend_unavailable')); socket?.terminate(); }
}
