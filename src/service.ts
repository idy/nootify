import { execFile, type ExecFileOptions } from 'node:child_process';
import { stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertInstallPort, installLaunchd, launchdLabel } from './launchd.js';
import { defaultStateDir } from './state.js';

const exec = promisify(execFile);
export const SERVICE_ACTIONS = ['install', 'start', 'restart', 'stop', 'uninstall', 'status'] as const;
export type ServiceAction = typeof SERVICE_ACTIONS[number];
export interface ServiceOptions { stateDir?: string; port: number; mcpConfig?: string; drain?: LaunchdProcess }
export interface ServiceResult { installed: boolean; running?: boolean; enabled?: boolean; was_running?: boolean; status?: string; task?: string; plist?: string }
export type ServiceExecutor = (file: string, args: string[], options?: ExecFileOptions) => Promise<{ stdout: string }>;
interface ServiceRuntime { execute?: ServiceExecutor; home?: string; platform?: NodeJS.Platform; uid?: number; shutdownTimeout?: number }
const executeService: ServiceExecutor = (file, args, options) => exec(file, args, { ...options, encoding: 'utf8' });

export interface LaunchdProcess { pid: number; started: string }

export function parseServiceDrain(value: unknown): LaunchdProcess {
  const identity = value as Partial<LaunchdProcess> | null;
  if (!identity || typeof identity !== 'object' || !Number.isSafeInteger(identity.pid) || identity.pid! <= 0
    || typeof identity.started !== 'string' || !identity.started.trim() || identity.started.length > 128 || /[\r\n]/.test(identity.started)) {
    throw new Error('Invalid service drain identity');
  }
  return { pid: identity.pid!, started: identity.started };
}

class ServiceUnloadedError extends Error {
  readonly service_unloaded = true;
  constructor(error: unknown, readonly service_process: LaunchdProcess) {
    super((error as Error).message, { cause: error });
  }
}

// Only this typed failure proves that ownership checks and bootout succeeded.
export function serviceFailure(error: unknown): { error: string; service_unloaded?: true; service_process?: LaunchdProcess } {
  return { error: (error as Error).message, ...(error instanceof ServiceUnloadedError
    ? { service_unloaded: true as const, service_process: error.service_process } : {}) };
}

async function launchdProcess(pid: number, run: ServiceExecutor): Promise<LaunchdProcess | undefined> {
  try {
    const { stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: 1000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C' },
    });
    const started = stdout.trim();
    if (!started || started.includes('\n')) throw new Error('Missing process start time');
    return { pid, started };
  } catch {
    // A failed/empty ps query is not exit evidence. Only ESRCH proves absence.
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    }
    throw new Error('Cannot verify the Nootify process identity; the LaunchAgent plist was retained');
  }
}

async function waitForLaunchdExit(identity: LaunchdProcess, run: ServiceExecutor, timeout: number): Promise<void> {
  const deadline = performance.now() + timeout;
  while ((await launchdProcess(identity.pid, run))?.started === identity.started) {
    if (performance.now() >= deadline) throw new Error('The Nootify process has not finished shutting down; the LaunchAgent plist was retained');
    // A reused PID with a different start time belongs to another process; never signal it.
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(100, Math.max(1, deadline - performance.now()))));
  }
}

/** Legacy launchd-install is unchanged; the new management commands only control this exact install. */
export function assertLaunchdOwnership(value: unknown, options: ServiceOptions): void {
  const plist = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const args: unknown[] = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
  const directory = resolve(options.stateDir ?? defaultStateDir());
  const expected = [process.execPath, fileURLToPath(new URL('./server.js', import.meta.url)), '--state-dir', directory, '--port', String(options.port)];
  if (plist.Label !== launchdLabel || ![6, 8].includes(args.length) || expected.some((arg, index) => args[index] !== arg)
    || args.length === 8 && (args[6] !== '--mcp-config' || typeof args[7] !== 'string' || !isAbsolute(args[7]))
    || plist.WorkingDirectory !== directory || plist.StandardOutPath !== join(directory, 'stdout.log') || plist.StandardErrorPath !== join(directory, 'stderr.log')) {
    throw new Error('Refusing to control a LaunchAgent owned by another installation or with modified arguments');
  }
}

/** Use the bundled resource beside dist/, both in a checkout and a staged service. */
export const windowsServiceScript = () => fileURLToPath(new URL('../../windows/service.ps1', import.meta.url));
export const windowsPowerShell = (env: NodeJS.ProcessEnv = process.env): string => win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Task launches must not inherit shell-injected Node code or ambient provider accounts. */
export function serviceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:NODE_.*|LARK_.*|SLACK_.*|TELEGRAM_.*|GITHUB_.*|GH_.*|CODEX_APP_SERVER_.*|OPENCODE_SERVER_.*|TS_.*|TSNET_.*|TAILSCALE_.*|NOOTIFY_TSNET_BIN|NOOTIFY_CORE_BIN|NOOTIFY_GITHUB_CLIENT_ID)$/i.test(key)));
}

export function windowsServiceArgs(action: ServiceAction, options: ServiceOptions): string[] {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsServiceScript(),
    '-Action', action[0].toUpperCase() + action.slice(1), '-NodePath', process.execPath,
    '-ServerPath', fileURLToPath(new URL('./server.js', import.meta.url)), '-StateDir', resolve(options.stateDir ?? defaultStateDir()), '-Port', String(options.port)];
  if (options.mcpConfig) args.push('-McpConfig', resolve(options.mcpConfig));
  return args;
}

/** Deliberately independent of the HTTP auth token: first install and stopped-service recovery need this. */
export async function manageService(action: ServiceAction, options: ServiceOptions, runtime: ServiceRuntime = {}): Promise<ServiceResult> {
  const run = runtime.execute ?? executeService;
  const platform = runtime.platform ?? process.platform;
  const uid = runtime.uid ?? process.getuid?.();
  if (options.drain && (platform !== 'darwin' || action !== 'start' && action !== 'restart' && action !== 'stop')) throw new Error('Service drain recovery requires macOS service-start, service-restart or service-stop');
  if (platform === 'win32') {
    const { stdout } = await run(windowsPowerShell(), windowsServiceArgs(action, options), {
      windowsHide: true, timeout: action === 'status' ? 5000 : 150_000, maxBuffer: 1024 * 1024, env: serviceEnvironment(process.env),
    }).catch(error => {
      // execFile's default error includes the entire command; keep management errors concise.
      const message = (error as { stderr?: string }).stderr?.trim();
      throw new Error(message || 'Windows service management failed');
    });
    const result: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!result || typeof result !== 'object' || typeof (result as ServiceResult).installed !== 'boolean'
      || ['running', 'enabled', 'was_running'].some(key => Object.hasOwn(result, key) && typeof (result as Record<string, unknown>)[key] !== 'boolean')) throw new Error('Invalid Windows service management response');
    return result as ServiceResult;
  }
  if (platform !== 'darwin' || uid === undefined) throw new Error('Background service management requires macOS or Windows');
  if (action === 'install') return { installed: true, status: 'installed', plist: await installLaunchd(options) };
  const plist = join(runtime.home ?? homedir(), 'Library', 'LaunchAgents', `${launchdLabel}.plist`);
  let installed = true;
  try { await stat(plist); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; installed = false; }
  if (installed) {
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
    assertLaunchdOwnership(JSON.parse(stdout), options);
  }
  if (options.drain) {
    // The receipt still needs an exit check if another uninstall removed the plist.
    // An existing registration must prove ownership first; a missing one grants no start authority.
    const identity = parseServiceDrain(options.drain);
    await waitForLaunchdExit(identity, run, runtime.shutdownTimeout ?? 30_000);
  }
  if (!installed) {
    if (action === 'status') return { installed: false, running: false };
    if (action === 'uninstall' || action === 'stop') return { installed: false, was_running: Boolean(options.drain), status: action === 'stop' ? 'stopped' : 'uninstalled' };
    throw new Error('Nootify is not installed; use service-install');
  }
  const target = `gui/${uid}/${launchdLabel}`;
  let loaded = true; let job = '';
  try {
    job = (await run('/bin/launchctl', ['print', target], {
      timeout: 5000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
    })).stdout;
  } catch (error) {
    const failure = error as { code?: number | string; killed?: boolean; signal?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
    const detail = typeof failure?.stderr === 'string' ? failure.stderr.trim() : '';
    const missing = `Could not find service "${launchdLabel}" in domain for user gui: ${uid}`;
    if (failure?.code !== 113 || failure.killed || failure.signal || failure.stdout
      || detail !== missing && detail !== `Bad request.\n${missing}`) {
      throw new Error('Cannot query the Nootify LaunchAgent; the plist was retained and no service action was performed');
    }
    loaded = false;
  }
  if (action === 'status') return { installed, running: loaded };
  if (action === 'start' || action === 'restart') {
    if (!loaded) {
      await assertInstallPort(options.port, false);
      await run('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist]);
    }
    await run('/bin/launchctl', ['kickstart', ...(action === 'restart' && loaded ? ['-k'] : []), target]);
  } else {
    if (loaded) {
      const match = /^\s*pid\s*=\s*(\S+)\s*$/m.exec(job);
      const pid = match ? Number(match[1]) : undefined;
      if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Cannot verify the Nootify launchd process ID');
      const identity = pid === undefined ? undefined : await launchdProcess(pid, run);
      await run('/bin/launchctl', ['bootout', target]);
      if (identity) {
        try { await waitForLaunchdExit(identity, run, runtime.shutdownTimeout ?? 30_000); }
        catch (error) { throw new ServiceUnloadedError(error, identity); }
      }
    }
    if (action === 'uninstall') await unlink(plist);
  }
  return { installed: action !== 'uninstall', status: action === 'start' ? 'started' : action === 'restart' ? 'restarted' : action === 'stop' ? 'stopped' : 'uninstalled', plist,
    ...(action === 'stop' || action === 'uninstall' ? { was_running: loaded || Boolean(options.drain) } : {}) };
}
