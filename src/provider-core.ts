import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, chmod, constants, lstat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddedEnvironment } from './tsnet-client.js';

export interface CoreEvent { event: string; data: Record<string, unknown> }
export interface CoreTransport {
  start(): Promise<void>;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  stop(): Promise<void>;
}
export class CoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function coreErrorCode(error: unknown): string | undefined {
  return error instanceof CoreError ? error.code.toLowerCase() : error instanceof Error && error.cause instanceof CoreError ? error.cause.code.toLowerCase() : undefined;
}
export function provenCoreRejection(error: unknown): boolean {
  return /^(?:conflict|invalid(?:_argument)?|not_found|unauthenticated|permission_denied|unsupported_operation|rejection_terminal|rejection_retryable|resource_exhausted|busy|unavailable)$/.test(coreErrorCode(error) ?? '');
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; submitted?: boolean }
interface Run { child: ChildProcessWithoutNullStreams; pending: Map<number, Pending>; closed: Promise<void>; stopping: boolean }
export function coreBinaryCandidates(platform = process.platform, arch = process.arch): string[] {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  const target = platform === 'win32' ? `${cpu}-pc-windows-msvc` : platform === 'darwin' ? `${cpu}-apple-darwin` : `${cpu}-unknown-linux-gnu`;
  const suffix = platform === 'win32' ? '.exe' : '';
  return [join(dirname(process.execPath), `nootify-core${suffix}`),
    fileURLToPath(new URL(`../../build/binaries/nootify-core-${target}${suffix}`, import.meta.url))];
}
async function binary(): Promise<string> {
  const candidates = process.env.NOOTIFY_CORE_BIN ? [resolve(process.env.NOOTIFY_CORE_BIN)] : coreBinaryCandidates();
  for (const path of candidates) { try { await access(path, constants.X_OK); return path; } catch { /* Try bundled development path. */ } }
  throw new CoreError('unavailable', 'Notification core is missing; run npm run core:build');
}
/** A private child-process bridge. It never transfers local agent socket credentials to peers. */
export class ProviderCore implements CoreTransport {
  private run?: Run;
  private starting?: Promise<void>;
  private sequence = 0;
  constructor(private readonly directory: string, private readonly onEvent: (event: CoreEvent) => void,
    // Core commands have a 60s deadline; allow the terminal response to arrive.
    private readonly command?: { file: string; args: string[] }, private readonly timeout = 65000,
    private readonly onExit: () => void = () => {}) {}
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.run) return Promise.resolve();
    const pending = this.launch(); this.starting = pending;
    return pending.finally(() => { if (this.starting === pending) this.starting = undefined; });
  }
  private async launch(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new CoreError('invalid', 'Unsafe notification core state directory');
    await chmod(this.directory, 0o700);
    const command = this.command ?? { file: await binary(), args: [] };
    const child = spawn(command.file, [...command.args, '--state-dir', this.directory], {
      stdio: ['pipe', 'pipe', 'pipe'], env: embeddedEnvironment(process.env), windowsHide: true,
    });
    let closed!: () => void;
    const run: Run = { child, pending: new Map(), stopping: false, closed: new Promise(resolveClosed => { closed = resolveClosed; }) };
    this.run = run;
    const fail = (error: Error) => {
      for (const pending of run.pending.values()) {
        clearTimeout(pending.timer); pending.reject(pending.submitted
          ? new CoreError('unconfirmed', 'Notification core disconnected after submission; the request outcome is unconfirmed') : error);
      }
      run.pending.clear();
    };
    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => { run.pending.delete(0); reject(new CoreError('timeout', 'Notification core startup timed out')); }, this.timeout).unref();
      run.pending.set(0, { resolve: () => resolveReady(), reject, timer });
    });
    let buffer = '';
    const invalid = () => { fail(new CoreError('protocol', 'Invalid notification core response')); child.kill('SIGTERM'); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) { if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) invalid(); return; }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) { invalid(); return; }
        if (!line.trim()) continue;
        try {
          const reply = JSON.parse(line) as { id?: number; event?: string; data?: Record<string, unknown>; result?: unknown; error?: { code?: string; message?: string } };
          if (reply.event && reply.data && typeof reply.data === 'object') {
            this.onEvent({ event: reply.event, data: reply.data }); continue;
          }
          if (!Number.isSafeInteger(reply.id)) { invalid(); return; }
          const pending = run.pending.get(reply.id!); if (!pending) continue;
          run.pending.delete(reply.id!); clearTimeout(pending.timer);
          if (reply.error) pending.reject(new CoreError(reply.error.code ?? 'failed', reply.error.message ?? 'Notification core request failed'));
          else if (reply.id === 0 && (reply.result as { ready?: boolean } | undefined)?.ready !== true) { pending.reject(new CoreError('protocol', 'Notification core did not become ready')); }
          else pending.resolve(reply.result);
        } catch { invalid(); return; }
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => fail(new CoreError('unavailable', 'Notification core connection closed')));
    child.once('error', () => fail(new CoreError('unavailable', 'Could not start notification core')));
    child.once('close', () => {
      fail(new CoreError('unavailable', 'Notification core stopped'));
      if (this.run === run) this.run = undefined;
      closed(); if (!run.stopping) this.onExit();
    });
    try { await ready; } catch (error) { await this.stop(); throw error; }
  }
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.starting) await this.starting;
    const run = this.run;
    if (!run || run.stopping || run.child.stdin.destroyed || run.child.stdin.writableEnded) throw new CoreError('unavailable', 'Notification core is not running');
    if (run.pending.size >= 256) throw new CoreError('busy', 'Notification core queue is full');
    const id = ++this.sequence;
    const line = JSON.stringify({ id, method, params }) + '\n';
    return new Promise<T>((resolveReply, reject) => {
      const timer = setTimeout(() => {
        run.pending.delete(id); reject(new CoreError('unconfirmed', 'Notification core request timed out; its outcome is unconfirmed'));
      }, this.timeout).unref();
      run.pending.set(id, { resolve: value => resolveReply(value as T), reject, timer, submitted: true });
      const disconnected = () => {
        clearTimeout(timer); run.pending.delete(id); reject(new CoreError('unconfirmed', 'Notification core connection closed after submission; the request outcome is unconfirmed'));
      };
      try { run.child.stdin.write(line, error => { if (error) disconnected(); }); }
      catch { disconnected(); }
    });
  }
  async stop(): Promise<void> {
    const run = this.run; if (!run) return;
    run.stopping = true;
    for (const pending of run.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new CoreError(pending.submitted ? 'unconfirmed' : 'unavailable',
        pending.submitted ? 'Notification core stopped after submission; the request outcome is unconfirmed' : 'Notification core is stopping'));
    }
    run.pending.clear(); run.child.stdin.end();
    const terminate = setTimeout(() => run.child.kill('SIGTERM'), 2000).unref();
    const kill = setTimeout(() => run.child.kill('SIGKILL'), 4000).unref();
    await run.closed; clearTimeout(terminate); clearTimeout(kill);
  }
}
