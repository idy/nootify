import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { State } from './state.js';

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
export async function installLaunchd(options: { stateDir?: string; port: number; mcpConfig?: string }): Promise<string> {
  if (process.platform !== 'darwin' || !process.getuid) throw new Error('launchd installation requires macOS');
  const state = await State.open(options.stateDir);
  const directory = resolve(state.directory);
  const server = fileURLToPath(new URL('./server.js', import.meta.url));
  await stat(server);
  const plistDir = join(homedir(), 'Library/LaunchAgents');
  const path = join(plistDir, `${launchdLabel}.plist`);
  let exists = false;
  try {
    const old = await readFile(path, 'utf8');
    if (!old.includes(`<string>${launchdLabel}</string>`) || !old.includes('nootify')) throw new Error('Refusing to replace an unrelated LaunchAgent');
    exists = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists) {
    try { await exec('launchctl', ['print', `gui/${process.getuid()}/${launchdLabel}`]); }
    catch { exists = false; }
  }
  if (exists) await exec('launchctl', ['bootout', `gui/${process.getuid()}`, path]);
  await mkdir(plistDir, { recursive: true });
  await writeFile(path, launchdPlist({ node: process.execPath, server, stateDir: directory, port: options.port,
    ...(options.mcpConfig ? { mcpConfig: resolve(options.mcpConfig) } : {}) }), { mode: 0o644 });
  await exec('plutil', ['-lint', path]);
  await exec('launchctl', ['bootstrap', `gui/${process.getuid()}`, path]);
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
