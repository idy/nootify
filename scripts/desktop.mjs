import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from './build-targets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cargoBin = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin');
const args = process.argv.slice(2);
if (args[0] === 'build' || args[0] === 'dev') {
  const targetOption = args.findIndex(arg => arg === '--target');
  const triple = targetOption === -1 ? args.find(arg => arg.startsWith('--target='))?.slice(9) : args[targetOption + 1];
  const target = buildTarget(triple);
  if (args[0] === 'build' && !args.some(arg => arg === '--bundles' || arg.startsWith('--bundles='))) {
    args.push('--bundles', target.bundles.join(','));
  }
}
// Environment names are case-insensitive on Windows; avoid keeping both Path and PATH.
const env = { ...process.env };
const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
const searchPath = env[pathKey] ?? '';
for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
env.PATH = `${cargoBin}${delimiter}${searchPath}`;
const child = spawn(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...args], {
  cwd: root, stdio: 'inherit', env,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
