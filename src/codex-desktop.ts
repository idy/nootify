import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { checkSocket } from './inbox.js';
import { HttpError, RetryableDeliveryError, SessionUnavailable, UnconfirmedDeliveryError, type DeliveryResult } from './types.js';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
interface Response {
  type: string; requestId?: string; method?: string; resultType?: string;
  handledByClientId?: string; result?: unknown; error?: string;
}
interface Receipt { owner: string; result: unknown }
interface Pending {
  method: string; owner?: string; mutation: boolean; idleRejection?: string;
  resolve(receipt: Receipt): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;
}
class InactiveTurn extends Error {}

/** Codex Desktop's versioned local owner router; this never starts or resumes a thread. */
export class CodexDesktop {
  private socket?: Socket;
  private opening?: Promise<void>;
  private clientId = 'initializing-client';
  private buffered: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, Pending>();
  constructor(readonly path: string, private readonly timeout = 8000, private readonly inputTimeout = 30_000) {}

  async open(): Promise<void> {
    if (this.opening) return this.opening;
    const opening = (async () => {
      try { await checkSocket(this.path); }
      catch { throw new RetryableDeliveryError('Codex Desktop connection is unavailable'); }
      const socket = createConnection(this.path);
      this.socket = socket;
      this.buffered = Buffer.alloc(0);
      socket.on('data', data => { if (this.socket === socket) this.receive(socket, data); });
      socket.on('error', () => this.disconnected(socket));
      socket.on('close', () => this.disconnected(socket));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new RetryableDeliveryError('Codex Desktop connection is unavailable')); socket.destroy(); }, this.timeout);
        const failed = () => { clearTimeout(timer); reject(new RetryableDeliveryError('Codex Desktop connection is unavailable')); };
        socket.once('error', failed);
        socket.once('connect', () => { clearTimeout(timer); socket.off('error', failed); resolve(); });
      });
      const receipt = await this.request('initialize', 0, { clientType: 'nootify' });
      const id = (receipt.result as { clientId?: unknown } | null)?.clientId;
      if (typeof id !== 'string' || !id || receipt.owner !== id) throw new RetryableDeliveryError('Invalid Codex Desktop initialization receipt');
      this.clientId = id;
    })();
    this.opening = opening;
    try { await opening; }
    catch (error) {
      if (this.opening === opening) {
        // Validation may fail before a socket exists for close() to disconnect.
        this.opening = undefined;
        this.close();
      }
      throw error;
    }
  }

  async owner(threadId: string): Promise<string> {
    await this.open();
    const receipt = await this.request('thread-owner-discovery', 1, { hostId: 'local', conversationId: threadId });
    if ((receipt.result as { supportsUntrustedAppInput?: unknown } | null)?.supportsUntrustedAppInput !== true) {
      throw new SessionUnavailable('unsupported_adapter');
    }
    return receipt.owner;
  }

  async ready(threadId: string): Promise<string> {
    const owner = await this.owner(threadId);
    const receipt = await this.request('thread-follower-read-model-settings', 1, { conversationId: threadId }, owner);
    if ((receipt.result as { settings?: { resumeState?: unknown } } | null)?.settings?.resumeState !== 'resumed') {
      throw new SessionUnavailable('session_offline');
    }
    return owner;
  }

  async send(threadId: string, text: string): Promise<DeliveryResult> {
    const owner = await this.ready(threadId);
    const clientUserMessageId = randomUUID();
    const input = [{ type: 'text', text, text_elements: [] }];
    let receipt: Receipt;
    let started = false;
    try {
      // The owner selects its current turn atomically. Its exact inactive-turn guard
      // runs before input submission; only that proven rejection permits turn/start.
      receipt = await this.request('thread-follower-steer-turn', 1, { conversationId: threadId, clientUserMessageId, input,
        restoreMessage: { id: clientUserMessageId, text, cwd: null, createdAt: Date.now(), context: { prompt: text,
          addedFiles: [], fileAttachments: [], imageAttachments: [], commentAttachments: [], ideContext: null, workspaceRoots: [] } } },
        owner, true, `Cannot steer conversation ${threadId} because its active turn already ended`);
    } catch (error) {
      if (!(error instanceof InactiveTurn)) throw error;
      started = true;
      receipt = await this.request('thread-follower-start-turn', 2, { conversationId: threadId,
        turnStart: { request: { threadId, clientUserMessageId, input }, context: { inheritThreadSettings: true } } }, owner, true);
    }
    const result = (receipt.result as { result?: { turn?: { id?: unknown }; turnId?: unknown } } | null)?.result;
    const turnId = started ? result?.turn?.id : result?.turnId;
    if (typeof turnId !== 'string' || !turnId) throw new UnconfirmedDeliveryError('Codex Desktop did not return an input receipt; delivery is unconfirmed');
    return { status: 'input_accepted' };
  }

  /** Requests are never replayed: losing a mutation receipt is an uncertain delivery. */
  private request(method: string, version: number, params: unknown, owner?: string, mutation = false, idleRejection?: string): Promise<Receipt> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new RetryableDeliveryError('Codex Desktop is disconnected'));
    const requestId = randomUUID();
    const timeout = mutation ? this.inputTimeout : this.timeout;
    const body = Buffer.from(JSON.stringify({ type: 'request', requestId, sourceClientId: this.clientId,
      version, method, params, ...(owner ? { targetClientId: owner } : {}), timeoutMs: timeout }));
    if (body.length > MAX_FRAME_BYTES) return Promise.reject(new HttpError(413, 'Codex Desktop input is too large'));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(mutation ? new UnconfirmedDeliveryError('Codex Desktop input receipt timed out; delivery is unconfirmed')
          : new RetryableDeliveryError('Codex Desktop request timed out'));
      }, timeout);
      this.pending.set(requestId, { method, owner, mutation, idleRejection, resolve, reject, timer });
      try { socket.write(Buffer.concat([header, body]), error => { if (error) this.disconnected(socket); }); }
      catch { this.disconnected(socket); }
    });
  }

  private receive(socket: Socket, chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) { this.disconnected(socket); return; }
      if (this.buffered.length < length + 4) return;
      let response: Response;
      try { response = JSON.parse(this.buffered.subarray(4, length + 4).toString()) as Response; }
      catch { this.disconnected(socket); return; }
      this.buffered = this.buffered.subarray(length + 4);
      if (response?.type === 'client-discovery-request' && typeof response.requestId === 'string') {
        const body = Buffer.from(JSON.stringify({ type: 'client-discovery-response', requestId: response.requestId, response: { canHandle: false } }));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        try { socket.write(Buffer.concat([header, body]), error => { if (error) this.disconnected(socket); }); }
        catch { this.disconnected(socket); }
        continue;
      }
      if (!response || response.type !== 'response' || typeof response.requestId !== 'string') continue;
      const request = this.pending.get(response.requestId);
      if (!request) continue;
      this.pending.delete(response.requestId); clearTimeout(request.timer);
      if (response.resultType !== 'success') {
        const unavailable = response.error === 'no-client-found';
        const unsupported = response.error === 'request-version-mismatch' || response.error === 'no-handler-for-request';
        request.reject(request.idleRejection && response.error === request.idleRejection ? new InactiveTurn()
          : unavailable ? new SessionUnavailable('session_offline') : unsupported ? new SessionUnavailable('unsupported_adapter')
          : request.mutation ? new UnconfirmedDeliveryError('Codex Desktop input failed without a confirmed outcome')
          : new RetryableDeliveryError('Codex Desktop request failed'));
      } else if (response.method !== request.method || typeof response.handledByClientId !== 'string'
        || !response.handledByClientId || (request.owner && response.handledByClientId !== request.owner)) {
        request.reject(request.mutation ? new UnconfirmedDeliveryError('Invalid Codex Desktop input receipt; delivery is unconfirmed')
          : new RetryableDeliveryError('Invalid Codex Desktop response'));
      } else request.resolve({ owner: response.handledByClientId, result: response.result });
    }
  }

  private disconnected(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = undefined; this.opening = undefined; this.clientId = 'initializing-client'; this.buffered = Buffer.alloc(0);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(request.mutation ? new UnconfirmedDeliveryError('Codex Desktop disconnected after input submission; delivery is unconfirmed')
        : new RetryableDeliveryError('Codex Desktop is unavailable'));
    }
    this.pending.clear(); socket.destroy();
  }
  close(): void { if (this.socket) this.disconnected(this.socket); }
}
