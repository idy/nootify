// Build jobs only collect signed files. One finalization job combines both
// platforms and publishes latest.json after every installer is available.
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { TARGETS, buildTarget } from './build-targets.mjs';
import { sha256 } from './bundle-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function validateTag(version, type, name) {
  if (type !== 'tag' || name !== `v${version}`) throw new Error(`Release from the tag v${version}, not ${type} ${name}`);
}

async function emptyOutput(output) {
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error(`Release output must be empty: ${output}`);
}

async function oneFile(directory, suffix) {
  const found = (await readdir(directory)).filter(name => name.endsWith(suffix));
  if (found.length !== 1) throw new Error(`Expected one ${suffix} in ${directory}, found ${found.length}`);
  return join(directory, found[0]);
}

export async function collectReleaseAssets({ triple, bundles, output, version }) {
  const target = buildTarget(triple);
  const updater = target.platform === 'win32'
    ? await oneFile(join(bundles, 'nsis'), '.exe')
    : await oneFile(join(bundles, 'macos'), '.app.tar.gz');
  const paths = [updater, `${updater}.sig`];
  if (target.platform === 'darwin') paths.push(await oneFile(join(bundles, 'dmg'), '.dmg'));
  const signature = (await readFile(`${updater}.sig`, 'utf8')).trim();
  if (!signature) throw new Error(`Missing updater signature: ${updater}`);
  const files = [];
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error(`Empty or invalid release asset: ${path}`);
    files.push({ name: basename(path), sha256: await sha256(path) });
  }
  await emptyOutput(output);
  for (const path of paths) await copyFile(path, join(output, basename(path)));
  await writeFile(join(output, 'release.json'), `${JSON.stringify({ triple, version, updater: basename(updater), files }, null, 2)}\n`);
}

export async function mergeReleaseAssets({ input, output, version, repository, notes = '', pubDate = new Date().toISOString() }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const expected = new Set(Object.keys(TARGETS));
  const platforms = {};
  const assets = new Map();
  for (const directory of (await readdir(input, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!directory.isDirectory()) continue;
    const source = join(input, directory.name);
    const metadata = JSON.parse(await readFile(join(source, 'release.json'), 'utf8'));
    if (!expected.delete(metadata.triple)) throw new Error(`Unexpected or duplicate release target: ${metadata.triple}`);
    if (metadata.version !== version) throw new Error(`Release version mismatch for ${metadata.triple}`);
    const target = buildTarget(metadata.triple);
    const names = new Set();
    for (const file of metadata.files) {
      if (file.name !== basename(file.name) || file.name.includes('\\') || assets.has(file.name)) {
        throw new Error(`Invalid or duplicate release asset: ${file.name}`);
      }
      const path = join(source, file.name);
      if ((await stat(path)).size === 0 || await sha256(path) !== file.sha256) throw new Error(`Release asset checksum mismatch: ${file.name}`);
      assets.set(file.name, path);
      names.add(file.name);
    }
    if (!names.has(metadata.updater) || !names.has(`${metadata.updater}.sig`)) throw new Error(`Missing updater assets for ${metadata.triple}`);
    const signature = (await readFile(join(source, `${metadata.updater}.sig`), 'utf8')).trim();
    if (!signature) throw new Error(`Missing updater signature for ${metadata.triple}`);
    const entry = { signature, url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(metadata.updater)}` };
    platforms[target.updaterPlatform] = entry;
    // Keep the architecture-only key for older Tauri updater clients too.
    if (target.platform === 'win32') platforms['windows-x86_64'] = entry;
  }
  if (expected.size) throw new Error(`Missing release targets: ${[...expected].join(', ')}`);
  await emptyOutput(output);
  for (const [name, path] of assets) await copyFile(path, join(output, name));
  const manifest = { version, notes, pub_date: pubDate, platforms };
  await writeFile(join(output, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  const { values, positionals: [command] } = parseArgs({ allowPositionals: true, options: {
    target: { type: 'string' }, bundles: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' },
  } });
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (command === 'check-tag') validateTag(version, process.env.GITHUB_REF_TYPE, process.env.GITHUB_REF_NAME);
  else if (command === 'collect' && values.target && values.bundles && values.output) {
    await collectReleaseAssets({ triple: values.target, bundles: resolve(values.bundles), output: resolve(values.output), version });
  } else if (command === 'merge' && values.input && values.output) {
    await mergeReleaseAssets({ input: resolve(values.input), output: resolve(values.output), version,
      repository: process.env.GITHUB_REPOSITORY, notes: process.env.RELEASE_NOTES });
  } else throw new Error('Use check-tag, collect --target --bundles --output, or merge --input --output');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`release-assets: ${error.message}`); process.exitCode = 1; });
}
