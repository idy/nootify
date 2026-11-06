// Expand test filenames in Node: npm uses cmd.exe on Windows, which does not expand globs.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [];
for (const [directory, suffix] of [['dist/test', '.test.js'], ['test', '.test.cjs'], ['scripts', '.test.mjs']]) {
  for (const name of (await readdir(join(root, directory))).sort()) {
    if (name.endsWith(suffix)) tests.push(join(root, directory, name));
  }
}
if (!tests.length) throw new Error('No tests found');
const child = spawn(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
