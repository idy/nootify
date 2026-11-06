import { checkSocket } from './inbox.js';
export { checkSocket } from './inbox.js';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import type { State } from './state.js';
import { HttpError, identifier, object, text, isAdapter, SessionUnavailable } from './types.js';
export { SessionUnavailable } from './types.js';
import { ExternalSessions } from './external-sessions.js';
import type { ExternalResolver, SessionTarget } from './external-sessions.js';
import { localEndpoint } from './codex-rpc.js';
import type { Adapter, BackendConnection, DeliveryResult, PublicSession, RouteRequest, RouteResponse, ServiceModule, SessionRecord } from './types.js';
import { LocalSessions } from './local-sessions.js';
import type { SessionCatalog } from './local-sessions.js';

export async function writeInbox(path: string, content: string, token?: string, timeout = 5000): Promise<DeliveryResult> {
  await checkSocket(path);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let finished = false;
    socket.setTimeout(timeout);
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('Inbox socket write timed out')));
    socket.once('connect', () => {
      const frames: unknown[] = [];
      if (token) frames.push({ type: 'auth', token });
      frames.push({ type: 'user', message: { role: 'user', content } });
      socket.end(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
    });
    socket.once('finish', () => { finished = true; });
    socket.once('end', () => {
      socket.setTimeout(0);
      if (finished) resolve({ status: 'socket_written' });
      else reject(new Error('Inbox closed before the message was written'));
    });
    socket.once('close', hadError => {
      if (!hadError && !socket.readableEnded) reject(new Error('Inbox exchange did not finish'));
    });
  });
}
export class SessionsService implements ServiceModule {
  readonly name = 'sessions';
  private readonly observed = new Map<string, PublicSession>();
  constructor(readonly state: State, readonly catalog: SessionCatalog = new LocalSessions(),
    private readonly report: (record: Record<string, unknown>) => void = () => {},
    private readonly external: ExternalResolver = new ExternalSessions(state)) {}
  status(): string { return 'ready'; }
  sessionName(id: string, adapter: Adapter): string {
    return this.observed.get(`${adapter}:${id}`)?.session_name ?? this.state.sessions.get(id)?.session_name ?? id;
  }
  async stop(): Promise<void> { this.external.close(); }
  async send(id: string, content: string, adapter?: Adapter): Promise<DeliveryResult> {
    const saved = this.state.sessions.get(id);
    const kind = adapter ?? saved?.adapter ?? (id.startsWith('local_') ? 'claude-desktop' : 'claude-code');
    const key = `${kind}:${id}`;
    const observation: PublicSession = { session_id: id, adapter: kind, host_id: hostname(),
      session_name: this.observed.get(key)?.session_name ?? id, availability: 'unknown', last_seen: new Date().toISOString() };
    try {
      let target: SessionTarget | undefined;
      if (kind === 'codex' || kind === 'opencode') target = await this.external.resolve(id, kind);
      else {
        const session = await this.catalog.inspect(id, kind);
        if (session) target = { info: session, send: async text => {
          if (session.availability !== 'active' || !session.socket_path) {
            throw new SessionUnavailable(session.availability === 'archived' ? 'session_archived' : session.availability === 'unknown' ? 'archive_unknown' : 'session_offline');
          }
          return writeInbox(session.socket_path, text, saved?.socket_path === session.socket_path ? saved.socket_token : undefined);
        } };
      }
      if (!target) throw new SessionUnavailable('session_not_local');
      observation.session_name = target.info.session_name;
      observation.availability = target.info.availability;
      if (target.info.availability === 'archived') throw new SessionUnavailable('session_archived');
      const result = await target.send(`[Nootify: ${target.info.session_name}]\n${content}`);
      observation.last_result = result.status;
      return result;
    } catch (error) {
      const reason = error instanceof SessionUnavailable ? error.reason : 'delivery_failed';
      observation.last_result = reason;
      if (reason === 'session_not_local') observation.availability = 'missing';
      else if (reason === 'session_archived') observation.availability = 'archived';
      else if (reason === 'session_offline') observation.availability = 'offline';
      throw error;
    } finally {
      this.observed.delete(key); this.observed.set(key, observation);
      if (this.observed.size > 1000) this.observed.delete(this.observed.keys().next().value!);
    }
  }
  async handle(request: RouteRequest): Promise<RouteResponse | undefined> {
    if (request.path === '/v1/sessions' && request.method === 'GET') {
      // Rendering or polling the UI must never query any client or enumerate its sessions.
      return { body: [...this.observed.values()].reverse() };
    }
    const backendMatch = /^\/v1\/backends\/(codex|opencode)$/.exec(request.path);
    if (backendMatch && request.method === 'PUT') {
      const adapter = backendMatch[1] as 'codex' | 'opencode';
      const body = object(request.body);
      const connection: BackendConnection = { url: text(body.url, 'url') };
      for (const field of ['token', 'username', 'password', 'directory'] as const) {
        if (body[field] !== undefined) connection[field] = text(body[field], field);
      }
      localEndpoint(connection, adapter === 'codex' ? ['ws:', 'wss:'] : ['http:', 'https:']);
      this.state.backends.set(adapter, connection); await this.state.save();
      return { body: { adapter, configured: true } };
    }
    const match = /^\/v1\/sessions\/([^/]+)(\/messages)?$/.exec(request.path);
    if (!match) return;
    const id = identifier(decodeURIComponent(match[1]), 'session_id');
    const body = object(request.body);
    if (request.method === 'POST' && match[2]) {
      if (body.adapter !== undefined && !isAdapter(body.adapter)) throw new HttpError(400, 'Unsupported session adapter');
      return { body: await this.send(id, text(body.text, 'text'), body.adapter) };
    }
    if (request.method !== 'PUT' || match[2]) return;
    if (!isAdapter(body.adapter)) throw new HttpError(400, 'Unsupported session adapter');
    const record: SessionRecord = {
      session_id: id, host_id: hostname(), adapter: body.adapter,
      session_name: text(body.session_name, 'session_name'),
      ...(body.socket_path !== undefined ? { socket_path: text(body.socket_path, 'socket_path') } : {}),
      ...(body.socket_token !== undefined ? { socket_token: text(body.socket_token, 'socket_token') } : {}),
    };
    if (record.adapter === 'claude-code' || record.adapter === 'claude-desktop') await checkSocket(text(record.socket_path, 'socket_path'));
    this.state.sessions.set(id, record);
    await this.state.save();
    this.report({ source: 'sessions', status: 'registered', session_id: id, session_name: record.session_name });
    const { socket_path: _path, socket_token: _token, ...publicSession } = record;
    return { body: publicSession };
  }
}
