// Explicit maintenance only: builds package the checked-in bundle without networking.
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = 'gh/idy/magpie-design-system';
const metadata = 'https://data.jsdelivr.com/v1/package';
const bundledDirectory = fileURLToPath(new URL('../public/vendor/magpie/', import.meta.url));

function selectFiles(manifest) {
  if (!Array.isArray(manifest.files)) throw new Error('CDN manifest has no files');
  const names = new Set();
  const files = manifest.files
    .filter(file => file?.name === '/LICENSE' || /^\/(css|fonts|icons)\//.test(file?.name))
    .map(file => {
      const name = file.name.slice(1);
      const parts = name.split('/');
      if (parts.some(part => !/^[a-zA-Z0-9._-]+$/.test(part) || part === '.' || part === '..')) {
        throw new Error(`Unsafe CDN path: ${file.name}`);
      }
      if (names.has(name.toLowerCase())) throw new Error(`Duplicate CDN path: ${name}`);
      names.add(name.toLowerCase());
      if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[A-Za-z0-9+/]{43}=$/.test(file.hash)) {
        throw new Error(`Invalid size or SHA256 for ${name}`);
      }
      return { name, hash: file.hash, size: file.size };
    })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (!files.some(file => file.name === 'LICENSE') || !files.some(file => file.name === 'css/magpie.css') ||
      !['css/', 'fonts/', 'icons/'].every(prefix => files.some(file => file.name.startsWith(prefix)))) {
    throw new Error('CDN manifest is missing required Magpie resources');
  }
  return files;
}

async function installBundle(bundle, destination) {
  // Stage beside the destination so directory renames stay on one filesystem.
  const stage = await mkdtemp(join(dirname(destination), '.magpie-'));
  const previous = join(stage, 'previous');
  let previousMoved = false;
  try {
    await cp(bundle, join(stage, 'bundle'), { recursive: true });
    await rename(destination, previous);
    previousMoved = true;
    try {
      await rename(join(stage, 'bundle'), destination);
    } catch (error) {
      try {
        await rename(previous, destination);
        previousMoved = false;
      } catch (restoreError) {
        throw new Error(`Could not restore Magpie bundle; previous files remain at ${previous}`, { cause: restoreError });
      }
      throw error;
    }
    previousMoved = false;
  } finally {
    if (!previousMoved) await rm(stage, { recursive: true, force: true });
  }
}

export async function syncMagpie({ fetchImpl = fetch, destination = bundledDirectory } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'nootify-magpie-'));
  try {
    const request = async url => {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      return response;
    };
    const resolved = await (await request(`${metadata}/resolve/${repository}@latest`)).json();
    if (typeof resolved.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(resolved.version)) {
      throw new Error('CDN latest did not resolve to a stable release');
    }
    const version = `v${resolved.version}`;
    const upstream = await (await request(`${metadata}/${repository}@${version}/flat`)).json();
    const manifest = { version, files: selectFiles(upstream) };
    const bundle = join(work, 'bundle');
    await mkdir(bundle);
    // Finish every download before cleanup or installation, including on failure.
    const results = await Promise.allSettled(manifest.files.map(async file => {
      const path = file.name.split('/').map(encodeURIComponent).join('/');
      const response = await request(`https://cdn.jsdelivr.net/${repository}@${version}/${path}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== file.size) throw new Error(`Size mismatch for ${file.name}: expected ${file.size}, received ${bytes.length}`);
      const hash = createHash('sha256').update(bytes).digest('base64');
      if (hash !== file.hash) throw new Error(`SHA256 mismatch for ${file.name}`);
      const output = join(bundle, file.name);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes);
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    await writeFile(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // This README is Nootify provenance; upstream README files remain in their directories.
    await writeFile(join(bundle, 'README.md'), await readFile(join(destination, 'README.md')));
    await installBundle(bundle, destination);
    return manifest;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncMagpie().then(manifest => {
    const bytes = manifest.files.reduce((total, file) => total + file.size, 0);
    console.log(`Magpie ${manifest.version}: verified and bundled ${manifest.files.length} files (${bytes} bytes).`);
    console.log('Update public/vendor/magpie/README.md and design documentation with the release and commit.');
  }).catch(error => {
    console.error(`sync-magpie: ${error.message}`);
    process.exitCode = 1;
  });
}
