export const NODE_VERSION = 'v24.22.2';

// Update the version and both hashes together from the official SHASUMS256.txt.
export const TARGETS = Object.freeze({
  'aarch64-apple-darwin': Object.freeze({
    triple: 'aarch64-apple-darwin', platform: 'darwin', arch: 'arm64',
    goos: 'darwin', goarch: 'arm64', extension: '', bundles: ['app', 'dmg'],
    nodeRelease: `node-${NODE_VERSION}-darwin-arm64`, archiveExtension: '.tar.gz',
    nodeSha256: 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
    updaterPlatform: 'darwin-aarch64',
  }),
  'x86_64-pc-windows-msvc': Object.freeze({
    triple: 'x86_64-pc-windows-msvc', platform: 'win32', arch: 'x64',
    goos: 'windows', goarch: 'amd64', extension: '.exe', bundles: ['nsis'],
    nodeRelease: `node-${NODE_VERSION}-win-x64`, archiveExtension: '.zip',
    nodeSha256: 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2',
    updaterPlatform: 'windows-x86_64-nsis',
  }),
});

export function buildTarget(triple = process.env.TAURI_ENV_TARGET_TRIPLE, platform = process.platform, arch = process.arch) {
  const target = triple ? TARGETS[triple] : Object.values(TARGETS).find(value => value.platform === platform && value.arch === arch);
  if (!target) throw new Error(`Unsupported Nootify build target: ${triple || `${platform}-${arch}`}`);
  return target;
}

export function sidecarName(name, target) {
  return `${name}-${target.triple}${target.extension}`;
}

export function nodeArchive(target) {
  return `${target.nodeRelease}${target.archiveExtension}`;
}

export function verifyNodeShasums(contents, target) {
  const archive = nodeArchive(target);
  const listed = contents.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .find(([, name]) => name === archive)?.[0];
  if (listed !== target.nodeSha256) {
    throw new Error(`${NODE_VERSION} SHASUMS256.txt lists ${listed ?? 'no entry'} for ${archive}, but this script pins ${target.nodeSha256}`);
  }
}
