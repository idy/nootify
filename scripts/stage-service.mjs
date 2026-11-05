// Stages what the Tauri bundle ships besides the desktop shell (run after `npm run build`):
//   src-tauri/resources/service/                 -> Nootify.app/Contents/Resources/service/
//     dist/src/*.js, public/, package.json, node_modules/ (production), node-LICENSE
//   src-tauri/binaries/node-aarch64-apple-darwin -> Nootify.app/Contents/MacOS/node
//   src-tauri/binaries/nootify-tsnet-aarch64-apple-darwin -> Contents/MacOS/nootify-tsnet
// The runtime is the official Node.js build, checked against its release's SHASUMS256.txt
// and a pinned hash. A local (e.g. Homebrew) node is never copied: it links foreign dylibs.
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
import { sha256, verifyExecutable } from './bundle-utils.mjs';

const run = promisify(execFile);

// Update both together, from the darwin-arm64 line of https://nodejs.org/dist/<version>/SHASUMS256.txt.
const NODE_VERSION = 'v24.22.2';
const NODE_TARBALL_SHA256 = 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a';
const TARGET = 'aarch64-apple-darwin';

const root = fileURLToPath(new URL('../', import.meta.url));
const resourcesDir = join(root, 'src-tauri', 'resources');
const serviceDir = join(resourcesDir, 'service');
const nodeBinary = join(root, 'src-tauri', 'binaries', `node-${TARGET}`);
const cacheDir = join(root, '.cache', 'node', NODE_VERSION);
const release = `node-${NODE_VERSION}-darwin-arm64`;
const tarball = `${release}.tar.gz`;
const distUrl = `https://nodejs.org/dist/${NODE_VERSION}/`;

async function main() {
  if (process.platform !== 'darwin') throw new Error('Staging needs macOS (otool, lipo) for the darwin-arm64 runtime');
  const target = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (target && target !== TARGET) throw new Error(`Nootify bundles Node.js for ${TARGET} only, not ${target}`);
  const [license, tailscale] = await Promise.all([stageNode(), buildTsnet()]);
  const changed = await stageService(license, tailscale);
  console.log(`stage-service: Node.js ${NODE_VERSION} sidecar ready; service ${changed ? 'staged' : 'unchanged'} in ${serviceDir}`);
}

async function stageNode() {
  await mkdir(cacheDir, { recursive: true });
  const sumsPath = join(cacheDir, 'SHASUMS256.txt');
  if (!await exists(sumsPath)) await download(`${distUrl}SHASUMS256.txt`, sumsPath);
  const listed = (await readFile(sumsPath, 'utf8')).split('\n')
    .map(line => line.trim().split(/\s+/)).find(([, name]) => name === tarball)?.[0];
  if (listed !== NODE_TARBALL_SHA256) {
    await rm(sumsPath, { force: true });
    throw new Error(`${NODE_VERSION} SHASUMS256.txt lists ${listed ?? 'no entry'} for ${tarball}, but this script pins ${NODE_TARBALL_SHA256}`);
  }
  const tarPath = join(cacheDir, tarball);
  if (!await exists(tarPath) || await sha256(tarPath) !== NODE_TARBALL_SHA256) {
    const partial = `${tarPath}.partial`;
    await download(`${distUrl}${tarball}`, partial);
    const actual = await sha256(partial);
    if (actual !== NODE_TARBALL_SHA256) {
      await rm(partial, { force: true });
      throw new Error(`${tarball} has SHA-256 ${actual}, expected ${NODE_TARBALL_SHA256}`);
    }
    await rename(partial, tarPath);
  }

  // Extract only the two members we need, into a fresh directory.
  const work = await mkdtemp(join(tmpdir(), 'nootify-node-'));
  try {
    await run('/usr/bin/tar', ['-xzf', tarPath, '-C', work, `${release}/bin/node`, `${release}/LICENSE`]);
    const binary = join(work, release, 'bin', 'node');
    const { stdout: archs } = await run('/usr/bin/lipo', ['-archs', binary]);
    if (archs.trim() !== 'arm64') throw new Error(`Node.js binary architectures are "${archs.trim()}", expected arm64`);
    await verifyExecutable(binary, NODE_VERSION);
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
    // dist/src/ui.js serves ../../public/.
    for (const file of await files(join(root, 'public'))) await copyInto(join(root, 'public', file), join(staging, 'public', file));
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
    await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
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
