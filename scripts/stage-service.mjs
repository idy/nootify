// Stage service resources and target-suffixed Node.js/tsnet sidecars for Tauri.
// macOS: Contents/Resources/service/ and Contents/MacOS/{node,nootify-tsnet}.
// Windows: service/ and {node.exe,nootify-tsnet.exe} beside installed Nootify.exe.
// Service resources include production modules, Node/Tailscale licenses, and
// third-party-notices.txt for the target's Rust crates and npm packages.
// Official Node archives are checked against both the pinned SHA-256 and SHASUMS256.txt.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildTsnet } from './build-tsnet.mjs';
import { sha256, verifyExecutable, runNpm } from './bundle-utils.mjs';
import { buildTarget, NODE_VERSION, nodeArchive, sidecarName, verifyNodeShasums } from './build-targets.mjs';
import { thirdPartyNotices } from './third-party-notices.mjs';

const run = promisify(execFile);

const target = buildTarget();
const root = fileURLToPath(new URL('../', import.meta.url));
const resourcesDir = join(root, 'src-tauri', 'resources');
const serviceDir = join(resourcesDir, 'service');
const nodeBinary = join(root, 'src-tauri', 'binaries', sidecarName('node', target));
const cacheDir = join(root, '.cache', 'node', NODE_VERSION);
const release = target.nodeRelease;
const archive = nodeArchive(target);
const distUrl = `https://nodejs.org/dist/${NODE_VERSION}/`;

async function main() {
  const [license, tailscale] = await Promise.all([stageNode(), buildTsnet(target)]);
  const changed = await stageService(license, tailscale);
  console.log(`stage-service: Node.js ${NODE_VERSION} sidecar ready; service ${changed ? 'staged' : 'unchanged'} in ${serviceDir}`);
}

async function stageNode() {
  await mkdir(cacheDir, { recursive: true });
  const sumsPath = join(cacheDir, 'SHASUMS256.txt');
  if (!await exists(sumsPath)) await download(`${distUrl}SHASUMS256.txt`, sumsPath);
  try { verifyNodeShasums(await readFile(sumsPath, 'utf8'), target); }
  catch (error) { await rm(sumsPath, { force: true }); throw error; }
  const archivePath = join(cacheDir, archive);
  if (!await exists(archivePath) || await sha256(archivePath) !== target.nodeSha256) {
    const partial = `${archivePath}.partial`;
    await download(`${distUrl}${archive}`, partial);
    const actual = await sha256(partial);
    if (actual !== target.nodeSha256) {
      await rm(partial, { force: true });
      throw new Error(`${archive} has SHA-256 ${actual}, expected ${target.nodeSha256}`);
    }
    await rename(partial, archivePath);
  }

  // Extract only the two members we need, into a fresh directory.
  const work = await mkdtemp(join(tmpdir(), 'nootify-node-'));
  try {
    // Windows ships bsdtar too; it reads ZIP and tar.gz without running archive contents.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
    const member = target.platform === 'win32' ? `${release}/node.exe` : `${release}/bin/node`;
    await run(tar, ['-xf', archivePath, '-C', work, member, `${release}/LICENSE`], { cwd: root });
    const binary = join(work, member);
    await verifyExecutable(binary, NODE_VERSION, target);
    // Rewriting an identical binary would only make cargo rerun the build script and relink.
    if (!await exists(nodeBinary) || await sha256(nodeBinary) !== await sha256(binary)) {
      await mkdir(dirname(nodeBinary), { recursive: true });
      await copyFile(binary, `${nodeBinary}.partial`);
      await chmod(`${nodeBinary}.partial`, 0o755);
      await rename(`${nodeBinary}.partial`, nodeBinary);
    }
    return await readFile(join(work, release, 'LICENSE'));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function stageService(nodeLicense, tailscale) {
  await mkdir(resourcesDir, { recursive: true });
  for (const entry of await readdir(resourcesDir)) {
    if (entry.startsWith('.service-')) await rm(join(resourcesDir, entry), { recursive: true, force: true });
  }
  const staging = await mkdtemp(join(resourcesDir, '.service-'));
  try {
    // The compiled module of every source file; tests and stale outputs of deleted sources stay out.
    for (const file of await files(join(root, 'src'))) {
      if (file.endsWith('.d.ts')) continue;
      if (!file.endsWith('.ts')) throw new Error(`No compiled output is known for src/${file}; extend stage-service.mjs`);
      const compiled = join('dist', 'src', `${file.slice(0, -3)}.js`);
      if (!await exists(join(root, compiled))) throw new Error(`Missing ${compiled}; run npm run build first`);
      await copyInto(join(root, compiled), join(staging, compiled));
    }
    // dist/src/ui.js serves ../../public/; the Windows CLI resolves ../../windows/.
    for (const file of await files(join(root, 'public'))) await copyInto(join(root, 'public', file), join(staging, 'public', file));
    // Shared with the embedded offline page; fonts and OFL notices must travel with the HTTP UI.
    await copyInto(join(root, 'desktop', 'fonts.css'), join(staging, 'desktop', 'fonts.css'));
    for (const file of await files(join(root, 'desktop', 'fonts'))) {
      await copyInto(join(root, 'desktop', 'fonts', file), join(staging, 'desktop', 'fonts', file));
    }
    const windows = join(root, 'windows');
    if (target.platform === 'win32' && !await exists(join(windows, 'service.ps1'))) {
      throw new Error('Missing committed windows/service.ps1');
    }
    if (await exists(windows)) {
      for (const file of await files(windows)) await copyInto(join(windows, file), join(staging, 'windows', file));
    }
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFile(join(staging, 'package.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module' }, null, 2)}\n`);
    await writeFile(join(staging, 'node-LICENSE'), nodeLicense);
    const licenses = join(staging, 'tailscale-licenses');
    await mkdir(licenses, { recursive: true });
    await writeFile(join(licenses, 'dependencies.txt'), tailscale.modules);
    for (const license of tailscale.licenses) {
      const path = join(licenses, license.path); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, license.content);
    }
    await installProductionModules(join(staging, 'node_modules'));
    await writeFile(join(staging, 'third-party-notices.txt'), await thirdPartyNotices(target.triple, join(staging, 'node_modules')));

    // mkdtemp creates the directory 0700. An identical tree stays untouched (chmod keeps mtimes)
    // so cargo does not rerun the build script and relink.
    await chmod(staging, 0o755);
    const current = await treeDigest(serviceDir).catch(() => undefined);
    if (current === await treeDigest(staging)) {
      await chmod(serviceDir, 0o755);
      return false;
    }
    await rm(serviceDir, { recursive: true, force: true });
    await rename(staging, serviceDir);
    return true;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function installProductionModules(destination) {
  const work = await mkdtemp(join(tmpdir(), 'nootify-modules-'));
  try {
    for (const name of ['package.json', 'package-lock.json']) await copyFile(join(root, name), join(work, name));
    await runNpm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: work, maxBuffer: 16 * 1024 * 1024 });
    const modules = join(work, 'node_modules');
    // .bin holds symlinks to package scripts; the service never runs them.
    for (const file of await files(modules, path => path.split(sep).includes('.bin'))) {
      await copyInto(join(modules, file), join(destination, file));
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Sorted relative paths of the regular files below `dir`. Symlinks and special files are refused:
 * tauri-build and the bundler would copy them inconsistently. */
async function files(dir, skip = () => false, prefix = '') {
  const found = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (skip(path)) continue;
    if (entry.isDirectory()) found.push(...await files(dir, skip, path));
    else if (entry.isFile()) found.push(path);
    else throw new Error(`${join(dir, path)} is not a regular file or directory`);
  }
  return found.sort();
}

async function copyInto(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function treeDigest(dir) {
  const hash = createHash('sha256');
  for (const file of await files(dir)) hash.update(`${file}\0${await sha256(join(dir, file))}\n`);
  return hash.digest('hex');
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`GET ${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

main().catch(error => {
  console.error(`stage-service: ${error.message}`);
  process.exitCode = 1;
});
