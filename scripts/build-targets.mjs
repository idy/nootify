export const TARGETS = Object.freeze({
  'aarch64-apple-darwin': Object.freeze({
    triple: 'aarch64-apple-darwin', platform: 'darwin', arch: 'arm64',
    goos: 'darwin', goarch: 'arm64', extension: '', bundles: ['app', 'dmg'],
    updaterPlatform: 'darwin-aarch64',
  }),
  'x86_64-pc-windows-msvc': Object.freeze({
    triple: 'x86_64-pc-windows-msvc', platform: 'win32', arch: 'x64',
    goos: 'windows', goarch: 'amd64', extension: '.exe', bundles: ['nsis'],
    updaterPlatform: 'windows-x86_64-nsis',
  }),
});

export function buildTarget(triple = process.env.NOOTIFY_BUILD_TARGET, platform = process.platform, arch = process.arch) {
  const target = triple ? TARGETS[triple] : Object.values(TARGETS).find(value => value.platform === platform && value.arch === arch);
  if (!target) throw new Error(`Unsupported Nootify build target: ${triple || `${platform}-${arch}`}`);
  return target;
}
