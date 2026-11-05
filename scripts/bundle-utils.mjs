import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Bundled executables must run independently of local package-manager libraries. */
export async function verifyExecutable(binary, expectedVersion) {
  const { stdout: linked } = await run('/usr/bin/otool', ['-L', binary]);
  const foreign = linked.split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean)
    .filter(lib => !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/Library/'));
  if (foreign.length) throw new Error(`${binary} links non-system libraries: ${foreign.join(', ')}`);
  const { stdout } = await run(binary, ['--version'], { env: {}, timeout: 10000 });
  if (stdout.trim() !== expectedVersion) throw new Error(`${binary} reports ${stdout.trim()}, expected ${expectedVersion}`);
}
