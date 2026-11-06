import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defaultStateDir } from './state.js';

const exec = promisify(execFile);
export const launchdLabel = 'dev.idy.nootify.service';
const xml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
export function launchdPlist(options: { node: string; server: string; stateDir: string; port: number; mcpConfig?: string }): string {
  const args = [options.node, options.server, '--state-dir', options.stateDir, '--port', String(options.port)];
  if (options.mcpConfig) args.push('--mcp-config', options.mcpConfig);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${launchdLabel}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(options.stateDir)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(options.stateDir, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(options.stateDir, 'stderr.log'))}</string>
</dict></plist>\n`;
}
/** Refuse an occupied port before changing launchd, including a manually started Nootify outside this job. */
export async function assertInstallPort(port: number, replacingLoadedJob: boolean): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error', headers: { connection: 'close' } });
    if (response.ok && replacingLoadedJob && (await response.json() as { service?: string }).service === 'nootify') return;
    await response.body?.cancel();
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') return;
  }
  throw new Error(`Port ${port} is already occupied or did not answer a Nootify health check; stop the existing service before installing Nootify`);
}
export async function installLaunchd(options: { stateDir?: string; port: number; mcpConfig?: string },
  runtime: { home?: string; execute?: (file: string, args: string[]) => Promise<unknown> } = {}): Promise<string> {
  if (process.platform !== 'darwin' || !process.getuid) throw new Error('launchd installation requires macOS');
  // Installer preparation must not migrate while a legacy JSON writer is still alive.
  const directory = resolve(options.stateDir ?? defaultStateDir());
  const execute = runtime.execute ?? exec;
  const server = fileURLToPath(new URL('./server.js', import.meta.url));
  await stat(server);
  const plistDir = join(runtime.home ?? homedir(), 'Library/LaunchAgents');
  const path = join(plistDir, `${launchdLabel}.plist`);
  let exists = false;
  let legacyPid: number | undefined;
  try {
    const old = await readFile(path, 'utf8');
    if (!old.includes(`<string>${launchdLabel}</string>`) || !old.includes('nootify')) throw new Error('Refusing to replace an unrelated LaunchAgent');
    exists = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists) {
    try {
      const job = await execute('launchctl', ['print', `gui/${process.getuid()}/${launchdLabel}`]) as { stdout?: string };
      const pid = /\bpid\s*=\s*(\d+)\b/.exec(job?.stdout ?? '');
      if (pid && Number.isSafeInteger(Number(pid[1])) && Number(pid[1]) > 0) legacyPid = Number(pid[1]);
    } catch { exists = false; }
  }
  await assertInstallPort(options.port, exists);
  // A loaded idle job may have no PID; never assume an occupied listener belongs to it.
  if (exists && legacyPid === undefined) await assertInstallPort(options.port, false);
  if (exists) {
    await execute('launchctl', ['bootout', `gui/${process.getuid()}`, path]);
    // bootout can return while a graceful shutdown is still draining its final JSON writes.
    const deadline = Date.now() + 30_000;
    for (;;) {
      let alive = false;
      if (legacyPid !== undefined) {
        try { process.kill(legacyPid, 0); alive = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') alive = true; }
      }
      try { await assertInstallPort(options.port, false); if (!alive) break; }
      catch (error) { if (Date.now() >= deadline) throw error; }
      if (Date.now() >= deadline) throw new Error('The previous Nootify process has not finished shutting down; state was not migrated');
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await mkdir(plistDir, { recursive: true });
  await writeFile(path, launchdPlist({ node: process.execPath, server, stateDir: directory, port: options.port,
    ...(options.mcpConfig ? { mcpConfig: resolve(options.mcpConfig) } : {}) }), { mode: 0o644 });
  await execute('plutil', ['-lint', path]);
  await execute('launchctl', ['bootstrap', `gui/${process.getuid()}`, path]);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${options.port}/health`, { signal: AbortSignal.timeout(500) });
      const body = await response.json() as { service?: string };
      if (response.ok && body.service === 'nootify') return path;
    } catch { /* launchd is still starting the process */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error(`LaunchAgent loaded but health is not ready; inspect ${join(directory, 'stderr.log')}`);
}
