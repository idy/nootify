// v0.2.1 validates these exact regular files before exchanging the bundle, then
// invokes node + cli.js to restore its service. Native exec launchers retain that
// contract without Node/npm or retired notification/VPN runtimes. Mach-O code
// signatures survive the updater tar, unlike signatures on shell scripts.
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const marker = '// Compatibility entry for the v0.2.1 updater; the node launcher delegates to the Go executable.\n';

export async function stageMacLegacyUpgrade(app, arch = 'arm64') {
  const binaries = join(app, 'Contents', 'MacOS');
  const service = join(app, 'Contents', 'Resources', 'service', 'dist', 'src');
  await mkdir(binaries, { recursive: true });
  await mkdir(service, { recursive: true });
  const launcher = join(binaries, 'node');
  await run('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', launcher, './desktop/cmd/legacy-macos'], {
    cwd: root, env: { ...process.env, GOOS: 'darwin', GOARCH: arch, CGO_ENABLED: '0' }, maxBuffer: 4 << 20,
  });
  for (const name of ['node', 'nootify-core', 'nootify-tsnet']) {
    const file = join(binaries, name);
    if (name !== 'node') await copyFile(launcher, file);
    await chmod(file, 0o755);
  }
  for (const name of ['cli.js', 'server.js']) await writeFile(join(service, name), marker);
}
