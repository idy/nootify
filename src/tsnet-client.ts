import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, chmod, constants, lstat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EmbeddedTailscaleTunnel { id: string; network: 'unix' | 'npipe'; address: string; token: string }
export interface EmbeddedTailscalePublication { port: number }

export interface EmbeddedTailscaleClient {
  start(target: string, exited: (error?: string) => void): Promise<void>;
  status(): Promise<unknown>;
  whois(ip: string): Promise<unknown>;
  login(): Promise<void>;
  logout(): Promise<void>;
  tunnel?(address: string): Promise<EmbeddedTailscaleTunnel>;
  closeTunnel?(tunnelId: string): Promise<void>;
  publish?(port: number, target: string): Promise<EmbeddedTailscalePublication>;
  unpublish?(port: number): Promise<void>;
  stop(): Promise<void>;
}
/** Ambient credentials, control servers and system-daemon configuration must never enroll this node. */
export function embeddedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['HOME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key.toUpperCase()) && value));
}
export function embeddedBinaryCandidates(platform: NodeJS.Platform = process.platform, arch = process.arch): string[] {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  const target = platform === 'win32' ? `${cpu}-pc-windows-msvc` : platform === 'darwin' ? `${cpu}-apple-darwin` : `${cpu}-unknown-linux-gnu`;
  const extension = platform === 'win32' ? '.exe' : '';
  return [join(dirname(process.execPath), `nootify-tsnet${extension}`),
    fileURLToPath(new URL(`../../build/binaries/nootify-tsnet-${target}${extension}`, import.meta.url))];
}
async function helperBinary(): Promise<string> {
  const candidates = process.env.NOOTIFY_TSNET_BIN ? [resolve(process.env.NOOTIFY_TSNET_BIN)] : embeddedBinaryCandidates();
  for (const binary of candidates) {
    try { await access(binary, constants.X_OK); return binary; } catch { /* Never fall back to the system Tailscale executable. */ }
  }
  throw new Error('embedded_client_missing');
}
const lifecycleErrors = new Set(['state_locked', 'state_unavailable', 'startup_failed', 'client_unavailable', 'listener_failed']);
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface ProcessState {
  child: ChildProcessWithoutNullStreams; closed: Promise<void>; pending: Map<number, Pending>; stopped: boolean; failure?: string;
}
function rejectPending(run: ProcessState, code: string): void {
  for (const pending of run.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(code)); }
  run.pending.clear();
}
/** Private stdio RPC to the bundled tsnet node. EOF also shuts the child down if its parent dies. */
export class TsnetClient implements EmbeddedTailscaleClient {
  private current?: ProcessState;
  private startup?: Promise<void>;
  private sequence = 0;
  constructor(private readonly directory: string, private readonly binary?: string | { file: string; args: string[] }) { this.directory = resolve(directory); }
  async start(target: string, exited: (error?: string) => void): Promise<void> {
    if (this.current) { await this.startup; return; }
    const command = typeof this.binary === 'object' ? this.binary : { file: this.binary ?? await helperBinary(), args: [] };
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe directory');
      await chmod(this.directory, 0o700);
    } catch { throw new Error('state_unavailable'); }
    const child = spawn(command.file, [...command.args, '--state-dir', this.directory, '--target', target, '--hostname', 'nootify'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: embeddedEnvironment(process.env), windowsHide: true,
    });
    let closed!: () => void;
    const run: ProcessState = { child, pending: new Map(), stopped: false, closed: new Promise(resolve => { closed = resolve; }) };
    this.current = run;
    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => {
        run.failure = 'embedded_request_timeout'; run.pending.delete(0); reject(new Error(run.failure));
      }, 15000).unref();
      run.pending.set(0, { resolve: () => resolveReady(), reject, timer });
    });
    this.startup = ready;
    let buffer = '';
    const fail = (code: string) => rejectPending(run, code);
    const invalid = () => { run.failure = 'embedded_protocol_error'; fail(run.failure); child.kill('SIGTERM'); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) { if (Buffer.byteLength(buffer) > 1024 * 1024) invalid(); return; }
        if (Buffer.byteLength(buffer.slice(0, end)) > 1024 * 1024) { invalid(); return; }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const reply = JSON.parse(line) as { id?: number; result?: unknown; error?: string };
          if (!Number.isSafeInteger(reply?.id)) { invalid(); return; }
          if (reply.id === 0) {
            if (reply.error && lifecycleErrors.has(reply.error)) {
              run.failure = reply.error; fail(reply.error);
            } else if (!reply.error && (reply.result as { ready?: unknown } | undefined)?.ready === true) {
              const startup = run.pending.get(0);
              if (!startup) { invalid(); return; }
              run.pending.delete(0); clearTimeout(startup.timer); startup.resolve(undefined);
            } else { invalid(); return; }
            continue;
          }
          const pending = run.pending.get(reply.id!); if (!pending) continue;
          run.pending.delete(reply.id!); clearTimeout(pending.timer);
          if (reply.error) pending.reject(new Error(/^[a-z_]{1,64}$/.test(reply.error) ? reply.error : 'embedded_request_failed'));
          else pending.resolve(reply.result);
        } catch { invalid(); return; }
      }
    });
    child.stderr.resume(); // Only allowlisted lifecycle frames reach settings; raw backend output stays private.
    child.stdin.on('error', () => fail(run.failure ?? 'embedded_client_stopped'));
    child.on('error', () => { run.failure = 'embedded_client_missing'; fail(run.failure); });
    child.once('close', () => {
      fail(run.failure ?? 'embedded_client_stopped');
      if (this.current === run) this.current = undefined;
      closed(); if (!run.stopped) exited(run.failure);
    });
    try { await ready; }
    catch (error) { await this.stop(); throw error; }
    finally { if (this.startup === ready) this.startup = undefined; }
  }
  private request(method: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const run = this.current;
    if (!run || run.stopped || run.failure) return Promise.reject(new Error(run?.failure ?? 'embedded_client_stopped'));
    if (run.pending.size >= 64) return Promise.reject(new Error('embedded_client_busy'));
    const id = ++this.sequence;
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => { run.pending.delete(id); reject(new Error('embedded_request_timeout')); }, 10000).unref();
      run.pending.set(id, { resolve: resolveReply, reject, timer });
      run.child.stdin.write(JSON.stringify({ id, method, ...fields }) + '\n', error => {
        if (error) { clearTimeout(timer); run.pending.delete(id); reject(new Error('embedded_client_stopped')); }
      });
    });
  }
  status(): Promise<unknown> { return this.request('status'); }
  whois(ip: string): Promise<unknown> { return this.request('whois', { ip }); }
  async login(): Promise<void> { await this.request('login'); }
  async logout(): Promise<void> { await this.request('logout'); }
  async tunnel(address: string): Promise<EmbeddedTailscaleTunnel> {
    const result = await this.request('tunnel', { address }) as Partial<EmbeddedTailscaleTunnel> | null;
    if (!result || typeof result.id !== 'string' || !result.id || typeof result.address !== 'string' || !result.address
      || typeof result.token !== 'string' || !/^[0-9a-f]{64}$/.test(result.token)) throw new Error('embedded_protocol_error');
    const pipePrefix = String.raw`\\.\pipe\nootify-tunnel-`;
    const validEndpoint = process.platform === 'win32'
      ? result.network === 'npipe' && result.address.startsWith(pipePrefix) && /^[0-9a-f]{32}$/.test(result.address.slice(pipePrefix.length))
      : result.network === 'unix' && result.address.startsWith('/') && !result.address.includes('\0');
    if (!validEndpoint) throw new Error('embedded_protocol_error');
    return { id: result.id, network: result.network!, address: result.address, token: result.token };
  }
  async closeTunnel(tunnelId: string): Promise<void> { await this.request('close_tunnel', { tunnel_id: tunnelId }); }
  publish(port: number, target: string): Promise<EmbeddedTailscalePublication> {
    return this.request('publish', { port, target }) as Promise<EmbeddedTailscalePublication>;
  }
  async unpublish(port: number): Promise<void> { await this.request('unpublish', { port }); }
  async stop(): Promise<void> {
    const run = this.current; if (!run) return;
    run.stopped = true;
    rejectPending(run, run.failure ?? 'embedded_client_stopped');
    run.child.stdin.end();
    const terminate = setTimeout(() => run.child.kill('SIGTERM'), 2000).unref();
    const kill = setTimeout(() => run.child.kill('SIGKILL'), 4000).unref();
    await run.closed; clearTimeout(terminate); clearTimeout(kill);
  }
}
