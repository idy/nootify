import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cargoBin = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin');
const child = spawn(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PATH: `${cargoBin}${delimiter}${process.env.PATH ?? ''}` },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
