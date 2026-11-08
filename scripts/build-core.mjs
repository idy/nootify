// Build and attribute the Go notification core shipped beside Node.js and tsnet.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildTarget, sidecarName } from './build-targets.mjs';
import { sha256, verifyExecutable } from './bundle-utils.mjs';
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildCore(target = buildTarget()) {
  const source = join(root, 'native', 'core');
  const binary = join(root, 'src-tauri', 'binaries', sidecarName('nootify-core', target));
  const env = { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' };
  await mkdir(dirname(binary), { recursive: true });
  const temporary = `${binary}.partial`;
  try {
    await run('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', temporary, '.'], { cwd: source, env, maxBuffer: 16 << 20 });
    const same = await sha256(binary).then(async current => current === await sha256(temporary)).catch(() => false);
    if (!same) { await chmod(temporary, 0o755); await rename(temporary, binary); }
    await verifyExecutable(binary, 'nootify-core 1', target);
    const { stdout } = await run('go', ['list', '-deps', '-mod=readonly', '-f', '{{with .Module}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}', '.'], { cwd: source, env, maxBuffer: 4 << 20 });
    const licenses = []; const modules = [];
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
  buildCore().then(() => console.log('Notification core built')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
