import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildTarget } from './build-targets.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Check PE machine type without executing a cross-compiled Windows binary. */
export async function verifyWindowsX64(binary) {
  const file = await open(binary, 'r');
  try {
    const dos = Buffer.alloc(64);
    const { bytesRead } = await file.read(dos, 0, dos.length, 0);
    if (bytesRead !== 64 || dos.toString('ascii', 0, 2) !== 'MZ') throw new Error(`${binary} is not a PE executable`);
    const header = Buffer.alloc(6);
    const offset = dos.readUInt32LE(60);
    const result = await file.read(header, 0, header.length, offset);
    if (offset < 64 || result.bytesRead !== 6 || header.readUInt32LE(0) !== 0x00004550 || header.readUInt16LE(4) !== 0x8664) {
      throw new Error(`${binary} is not a Windows x64 PE executable`);
    }
  } finally { await file.close(); }
}

/** Bundled executables must match the target and run independently of local package-manager libraries. */
export async function verifyExecutable(binary, expectedVersion, target = buildTarget()) {
  if (target.platform === 'win32') {
    await verifyWindowsX64(binary);
  } else if (process.platform === 'darwin') {
    const { stdout: archs } = await run('/usr/bin/lipo', ['-archs', binary], { cwd: root });
    if (archs.trim() !== 'arm64') throw new Error(`${binary} architectures are "${archs.trim()}", expected arm64`);
    const { stdout: linked } = await run('/usr/bin/otool', ['-L', binary], { cwd: root });
    const foreign = linked.split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean)
      .filter(lib => !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/Library/'));
    if (foreign.length) throw new Error(`${binary} links non-system libraries: ${foreign.join(', ')}`);
  }
  if (target.platform !== process.platform || target.arch !== process.arch) return;
  // Windows needs its system directory to resolve system DLLs. Do not inherit NODE_OPTIONS,
  // package-manager library paths, or the extraction directory as the working directory.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => /^(SystemRoot|WINDIR|SystemDrive|TEMP|TMP)$/i.test(name)));
  const { stdout } = await run(binary, ['--version'], { cwd: root, env, timeout: 10000 });
  if (stdout.trim() !== expectedVersion) throw new Error(`${binary} reports ${stdout.trim()}, expected ${expectedVersion}`);
}

/** execFile cannot launch npm.cmd on Windows; use the installed npm JavaScript entry point. */
export async function runNpm(args, options) {
  if (process.platform !== 'win32') return run('npm', args, options);
  const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return run(process.execPath, [npm, ...args], options);
}
