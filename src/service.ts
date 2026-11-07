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
export interface ServiceOptions { stateDir?: string; port: number; mcpConfig?: string }
export interface ServiceResult { installed: boolean; status?: string; task?: string; plist?: string }
export type ServiceExecutor = (file: string, args: string[], options?: ExecFileOptions) => Promise<{ stdout: string }>;
interface ServiceRuntime { execute?: ServiceExecutor; home?: string; platform?: NodeJS.Platform; uid?: number; shutdownTimeout?: number }
const executeService: ServiceExecutor = (file, args, options) => exec(file, args, { ...options, encoding: 'utf8' });

interface LaunchdProcess { pid: number; started: string }
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
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:NODE_.*|LARK_.*|SLACK_.*|TELEGRAM_.*|GITHUB_.*|GH_.*|CODEX_APP_SERVER_.*|OPENCODE_SERVER_.*|TS_.*|TSNET_.*|TAILSCALE_.*|NOOTIFY_TSNET_BIN|NOOTIFY_GITHUB_CLIENT_ID)$/i.test(key)));
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
  if (platform === 'win32') {
    const { stdout } = await run(windowsPowerShell(), windowsServiceArgs(action, options), {
      windowsHide: true, timeout: action === 'status' ? 5000 : 150_000, maxBuffer: 1024 * 1024, env: serviceEnvironment(process.env),
    }).catch(error => {
      // execFile's default error includes the entire command; keep management errors concise.
      const message = (error as { stderr?: string }).stderr?.trim();
      throw new Error(message || 'Windows service management failed');
    });
    const result: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!result || typeof result !== 'object' || typeof (result as ServiceResult).installed !== 'boolean') throw new Error('Invalid Windows service management response');
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
  if (action === 'status') return { installed };
  if (!installed) {
    if (action === 'uninstall' || action === 'stop') return { installed: false, status: action === 'stop' ? 'stopped' : 'uninstalled' };
    throw new Error('Nootify is not installed; use service-install');
  }
  const target = `gui/${uid}/${launchdLabel}`;
  let loaded = true; let job = '';
  try { job = (await run('launchctl', ['print', target])).stdout; } catch { loaded = false; }
  if (action === 'start' || action === 'restart') {
    if (!loaded) {
      await assertInstallPort(options.port, false);
      await run('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    }
    await run('launchctl', ['kickstart', ...(action === 'restart' && loaded ? ['-k'] : []), target]);
  } else {
    if (loaded) {
      const match = /^\s*pid\s*=\s*(\S+)\s*$/m.exec(job);
      const pid = match ? Number(match[1]) : undefined;
      if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Cannot verify the Nootify launchd process ID');
      const identity = pid === undefined ? undefined : await launchdProcess(pid, run);
      await run('launchctl', ['bootout', target]);
      if (identity) await waitForLaunchdExit(identity, run, runtime.shutdownTimeout ?? 30_000);
    }
    if (action === 'uninstall') await unlink(plist);
  }
  return { installed: action !== 'uninstall', status: action === 'start' ? 'started' : action === 'restart' ? 'restarted' : action === 'stop' ? 'stopped' : 'uninstalled', plist };
}
