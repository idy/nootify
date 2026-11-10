// Builds the independent user-space Tailscale node shipped beside the bundled Node.js runtime.
import { execFile } from 'node:child_process';
import { sha256, verifyExecutable } from './bundle-utils.mjs';
import { buildTarget, sidecarName } from './build-targets.mjs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'native', 'tailscale');
export async function buildTsnet(target = buildTarget()) {
  const binary = join(root, 'build', 'binaries', sidecarName('nootify-tsnet', target));
  const env = { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' };
  await mkdir(dirname(binary), { recursive: true });
  const temporary = `${binary}.partial`;
  try {
    const { stdout: resolvedVersion } = await run('go', ['list', '-m', '-mod=readonly', '-f', '{{.Version}}', 'tailscale.com'], { cwd: source, env });
    const version = resolvedVersion.trim();
    await run('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', `-ldflags=-s -w -X=main.tailscaleVersion=${version}`, '-o', temporary, '.'], { cwd: source, env, maxBuffer: 16 << 20 });
    const same = await sha256(binary).then(async current => current === await sha256(temporary)).catch(() => false);
    if (!same) { await chmod(temporary, 0o755); await rename(temporary, binary); }
    await verifyExecutable(binary, `nootify-tsnet ${version.replace(/^v/, '')}`, target);
    // Ship dependency attribution together with the helper. No credentials or Go cache paths are included.
    const { stdout } = await run('go', ['list', '-deps', '-mod=readonly', '-f', '{{with .Module}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}', '.'], { cwd: source, env, maxBuffer: 4 << 20 });
    const licenses = [];
    const modules = [];
    for (const line of new Set(stdout.trim().split('\n'))) {
      const [name, version, directory] = line.split('\t');
      if (!version || !directory) continue;
      modules.push(`${name} ${version}`);
      for (const file of await readdir(directory)) {
        if (!/^(LICENSE|LICENCE|COPYING|NOTICE|PATENTS)(?:[.-].*)?$/i.test(file) || !(await stat(join(directory, file))).isFile()) continue;
        licenses.push({ path: join(name.replace(/[^a-zA-Z0-9._-]/g, '_'), file), content: await readFile(join(directory, file)) });
      }
    }
    return { binary, modules: modules.join('\n') + '\n', licenses };
  } finally { await rm(temporary, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildTsnet().then(() => console.log('Embedded Tailscale client built')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
