import { readdir, stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { Session as OpenCodeSession } from '@opencode-ai/sdk/v2';
import { CodexRpc, localEndpoint } from './codex-rpc.js';
import { CodexDesktop } from './codex-desktop.js';
import { HttpError, SessionUnavailable, RetryableDeliveryError, UnconfirmedDeliveryError } from './types.js';
import type { Adapter, BackendConnection, DeliveryResult, PublicSession } from './types.js';
import type { State } from './state.js';

export interface SessionTarget { info: PublicSession; send(content: string): Promise<DeliveryResult> }
export interface ExternalResolver {
  resolve(id: string, adapter: 'codex' | 'opencode'): Promise<SessionTarget | undefined>;
  close(): void;
}
export async function findCodexThread(id: string, home = process.env.CODEX_HOME ?? join(homedir(), '.codex')): Promise<{ id: string; title: string; archived: boolean } | undefined> {
  let files: string[];
  try { files = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0])); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!files.length) return;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(home, files[0]), { readOnly: true });
  try {
    const row = db.prepare('SELECT id, title, archived FROM threads WHERE id = ?').get(id);
    if (!row) return;
    if (typeof row.id !== 'string' || typeof row.title !== 'string' || (row.archived !== 0 && row.archived !== 1)) throw new SessionUnavailable('archive_unknown');
    return { id: row.id, title: row.title, archived: row.archived === 1 };
  } finally { db.close(); }
}
export class ExternalSessions implements ExternalResolver {
  private codex?: { key: string; rpc: CodexRpc };
  private desktop?: CodexDesktop;
  constructor(private readonly state: State, private readonly options: { codexHome?: string; codexDesktopSocket?: string } = {}) {}
  private connection(adapter: Adapter): BackendConnection | undefined {
    const configured = this.state.backends.get(adapter);
    if (configured) return configured;
    if (adapter === 'codex') return process.env.CODEX_APP_SERVER_URL ? { url: process.env.CODEX_APP_SERVER_URL, token: process.env.CODEX_APP_SERVER_TOKEN } : undefined;
    return { url: process.env.OPENCODE_SERVER_URL ?? 'http://127.0.0.1:4096', username: process.env.OPENCODE_SERVER_USERNAME ?? 'opencode', password: process.env.OPENCODE_SERVER_PASSWORD };
  }
  async resolve(id: string, adapter: 'codex' | 'opencode'): Promise<SessionTarget | undefined> {
    return adapter === 'codex' ? this.resolveCodex(id) : this.resolveOpenCode(id);
  }
  private async resolveCodex(id: string): Promise<SessionTarget | undefined> {
    const row = await findCodexThread(id, this.options.codexHome);
    if (!row) return;
    const info: PublicSession = { adapter: 'codex', session_id: id, host_id: hostname(), session_name: row.title, availability: row.archived ? 'archived' : 'unknown' };
    const blocked = (reason: string): SessionTarget => ({ info, async send() { throw new SessionUnavailable(reason); } });
    if (row.archived) return blocked('session_archived');
    const connection = this.connection('codex');
    if (!connection) {
      // Desktop already owns its stdio app-server. Reuse its local owner router
      // instead of starting a second app-server or resuming saved history.
      if (process.platform !== 'darwin' && !this.options.codexDesktopSocket) return blocked('backend_unavailable');
      const home = this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
      const path = this.options.codexDesktopSocket ?? join(home, 'ipc', 'ipc.sock');
      try { await stat(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // A selected Desktop transport may remove its socket while restarting.
          if (this.desktop?.path === path) throw new RetryableDeliveryError('Codex Desktop socket is temporarily unavailable');
          return blocked('backend_unavailable');
        }
        throw error;
      }
      if (this.desktop?.path !== path) { this.desktop?.close(); this.desktop = new CodexDesktop(path); }
      const desktop = this.desktop;
      await desktop.ready(id);
      info.availability = 'active';
      return { info, send: async content => {
        const latest = await findCodexThread(id, this.options.codexHome);
        if (!latest) throw new SessionUnavailable('session_not_local');
        if (latest.archived) throw new SessionUnavailable('session_archived');
        return desktop.send(id, content);
      } };
    }
    const key = JSON.stringify(connection);
    if (this.codex?.key !== key) { this.codex?.rpc.close(); this.codex = { key, rpc: new CodexRpc(connection) }; }
    const rpc = this.codex.rpc;
    await rpc.open();
    const { thread } = await rpc.call<{ thread: { id: string; name?: string; status: { type: string }; path?: string } }>('thread/read', { threadId: id });
    if (thread.id !== id) throw new Error('Codex returned a different thread');
    if (thread.path?.split(/[\\/]/).includes('archived_sessions')) return blocked('session_archived');
    if (!['idle', 'active'].includes(thread.status?.type)) { info.availability = 'offline'; return blocked('session_offline'); }
    info.session_name = thread.name ?? row.title; info.availability = 'active';
    return { info, send: async content => {
      // Recheck the one thread immediately before adding input; never resume or unarchive it.
      const latest = await findCodexThread(id, this.options.codexHome);
      if (!latest) throw new SessionUnavailable('session_not_local');
      if (latest.archived) throw new SessionUnavailable('session_archived');
      const input = [{ type: 'text', text: content }];
      if (thread.status.type === 'active') {
        const turns = await rpc.call<{ data: { id: string; status: string }[] }>('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        const active = turns.data.find(turn => turn.status === 'inProgress');
        if (!active) throw new SessionUnavailable('session_busy');
        await rpc.call('turn/steer', { threadId: id, expectedTurnId: active.id, input });
      } else await rpc.call('turn/start', { threadId: id, input });
      return { status: 'input_accepted' };
    } };
  }
  private async resolveOpenCode(id: string): Promise<SessionTarget | undefined> {
    const connection = this.connection('opencode')!;
    const url = localEndpoint(connection, ['http:', 'https:']);
    const headers: Record<string, string> = {};
    if (connection.password) headers.Authorization = `Basic ${Buffer.from(`${connection.username ?? 'opencode'}:${connection.password}`).toString('base64')}`;
    const client = createOpencodeClient({ baseUrl: url.href, headers,
      fetch: async (request, init) => {
        const original = request instanceof Request ? request : undefined;
        const method = (init?.method ?? original?.method ?? 'GET').toUpperCase();
        const upstream = init?.signal ?? original?.signal;
        const deadline = AbortSignal.timeout(8000);
        const signal = upstream ? AbortSignal.any([upstream, deadline]) : deadline;
        try { return await fetch(request, { ...init, signal, redirect: 'error' }); }
        catch {
          if (['GET', 'HEAD'].includes(method)) throw new RetryableDeliveryError('OpenCode backend is unavailable');
          throw new UnconfirmedDeliveryError('OpenCode input response was not received; delivery is unconfirmed');
        }
      },
    });
    const result = await client.session.get({ sessionID: id, directory: connection.directory });
    if (result.response.status === 404) return;
    if (result.error || !result.data) throw new Error(`OpenCode lookup failed (HTTP ${result.response.status})`);
    const session: OpenCodeSession = result.data;
    if (session.id !== id || !session.time || typeof session.time.created !== 'number' || typeof session.time.updated !== 'number') throw new SessionUnavailable('archive_unknown');
    const info: PublicSession = { adapter: 'opencode', session_id: id, host_id: hostname(), session_name: session.title, availability: session.time.archived !== undefined ? 'archived' : 'active' };
    return { info, send: async content => {
      if (session.time.archived !== undefined) throw new SessionUnavailable('session_archived');
      const sent = await client.session.promptAsync({ sessionID: id, directory: connection.directory ?? session.directory, parts: [{ type: 'text', text: content }] });
      if (sent.error || sent.response.status !== 204) {
        const status = sent.response.status;
        const message = `OpenCode input failed (HTTP ${status})`;
        if ([400, 404, 405, 413, 415, 422].includes(status)) throw new HttpError(status, message);
        if (status >= 400 && status < 500) throw new RetryableDeliveryError(message);
        throw new UnconfirmedDeliveryError(`${message}; delivery is unconfirmed`);
      }
      return { status: 'input_accepted' };
    } };
  }
  close(): void { this.codex?.rpc.close(); this.codex = undefined; this.desktop?.close(); this.desktop = undefined; }
}
