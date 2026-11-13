// Compile the pinned MyGo module directly. All version metadata comes from the
// root package.json; --package-version exists only for upgrade test fixtures.
import { execFile, spawn } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { buildTarget } from './build-targets.mjs';
import { runNpm, verifyExecutable, verifyWindowsX64 } from './bundle-utils.mjs';
import { stageServiceBundle } from './stage-service.mjs';
import { stageMacLegacyUpgrade } from './macos-legacy-upgrade.mjs';
import { withNsisCompiler } from './nsis.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
export const APP_ID = 'dev.idy.nootify';
export const DEV_APP_ID = `${APP_ID}.dev`;
export const MYGO_VERSION = 'v0.8.3';

export function packageVersion(value) {
  if (typeof value !== 'string' || value.trim() !== value || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) || value.split('.').some(part => Number(part) > 65535)) {
    throw new Error(`Invalid package version: ${value}`);
  }
  return value;
}

export function desktopLinkerFlags(target, version, appID = APP_ID) {
  packageVersion(version);
  if (![APP_ID, DEV_APP_ID].includes(appID)) throw new Error(`Unsupported app identity: ${appID}`);
  // Direct Go builds must supply the same package metadata as MyGo's bundler.
  // MyGo uses these values when no native bundle metadata is available.
  return ['-s', '-w', `-X main.version=${version}`, `-X main.appID=${appID}`,
    `-X github.com/egoist/mygo.packageIdentifier=${appID}`,
    '-X github.com/egoist/mygo.packageName=Nootify',
    `-X github.com/egoist/mygo.packageVersion=${version}`,
    ...(target.platform === 'win32' ? ['-H=windowsgui'] : [])].join(' ');
}

export function desktopPaths(target, base = root, development = false) {
  const output = join(base, 'build', development ? 'dev' : 'desktop', target.triple);
  const app = join(output, 'macos', 'Nootify.app');
  return {
    output, app, resources: join(base, 'build', 'resources', 'licenses'),
    executable: target.platform === 'darwin' ? join(app, 'Contents', 'MacOS', 'Nootify') : join(output, 'payload', 'Nootify.exe'),
    payload: join(output, 'payload'), macos: join(output, 'macos'), dmg: join(output, 'dmg'), nsis: join(output, 'nsis'),
  };
}

export function parseDesktopArgs(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    target: { type: 'string' }, bundles: { type: 'string' }, 'package-version': { type: 'string' },
    'no-sign': { type: 'boolean', default: false }, ci: { type: 'boolean', default: false },
  } });
  const [command] = positionals;
  if (!['build', 'dev'].includes(command) || positionals.length !== 1) throw new Error('Use desktop.mjs build|dev [--target <triple>] [--bundles app,dmg|nsis] [--no-sign] [--package-version <version>]');
  const target = buildTarget(values.target);
  const bundles = values.bundles?.split(',') ?? target.bundles;
  if (!bundles.length || bundles.some(bundle => !target.bundles.includes(bundle))) throw new Error(`Unsupported bundles for ${target.triple}: ${bundles}`);
  const noSign = values['no-sign'] || command === 'dev';
  if (values['package-version'] && !noSign) throw new Error('Package version overrides are unsigned test fixtures; use --no-sign');
  return { command, target, bundles, version: values['package-version'] && packageVersion(values['package-version']), noSign };
}

const xml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
export function macInfoPlist(version, appID = APP_ID) {
  packageVersion(version);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Nootify</string>
<key>CFBundleDisplayName</key><string>Nootify</string>
<key>CFBundleIdentifier</key><string>${xml(appID)}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>Nootify</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleLocalizations</key><array><string>en</string><string>zh-Hans</string></array>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`;
}

export async function copyPayload(target, paths, base = root) {
  const binDir = target.platform === 'darwin' ? join(paths.app, 'Contents', 'MacOS') : paths.payload;
  const resourceDir = target.platform === 'darwin' ? join(paths.app, 'Contents', 'Resources') : paths.payload;
  await mkdir(binDir, { recursive: true });
  await mkdir(resourceDir, { recursive: true });
  await cp(paths.resources, join(resourceDir, 'licenses'), { recursive: true, dereference: false });
  if (target.platform === 'darwin') {
    await copyFile(join(base, 'desktop', 'icons', 'icon.icns'), join(resourceDir, 'icon.icns'));
    await stageMacLegacyUpgrade(paths.app, target.goarch);
  }
}

export async function compileDesktop(target, paths, version, appID) {
  const env = { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' };
  const { stdout } = await run('go', ['list', '-m', '-mod=readonly', '-f', '{{.Version}}', 'github.com/egoist/mygo'], { cwd: root, env });
  if (stdout.trim() !== MYGO_VERSION) throw new Error(`desktop must pin MyGo ${MYGO_VERSION}, found ${stdout.trim()}`);
  const args = ['build', '-mod=readonly', '-trimpath', '-buildvcs=false'];
  let source = join(root, 'desktop');
  let temporarySource;
  try {
    if (target.platform === 'win32') {
      // Go does not discover newly added .syso files through -overlay. Compile
      // an exact temporary package copy below desktop/ so internal imports remain valid.
      temporarySource = await mkdtemp(join(root, 'desktop', '.build-source-'));
      for (const entry of await readdir(source)) {
        if (!entry.startsWith('.build-source-')) await cp(join(source, entry), join(temporarySource, entry), { recursive: true });
      }
      source = temporarySource;
      const syso = join(source, 'nootify_windows_amd64.syso');
      const hostEnv = { ...process.env, CGO_ENABLED: '0' }; delete hostEnv.GOOS; delete hostEnv.GOARCH;
      await run('go', ['run', join(root, 'scripts', 'windows-resources.go'), '--icon', join(root, 'desktop', 'icons', 'icon.ico'), '--version', version, '--identifier', appID, '--output', syso], { cwd: root, env: hostEnv });
    }
    const flags = desktopLinkerFlags(target, version, appID);
    await run('go', [...args, `-ldflags=${flags}`, '-o', paths.executable, '.'], { cwd: source, env, maxBuffer: 16 << 20 });
  } finally {
    if (temporarySource) await rm(temporarySource, { recursive: true, force: true });
  }
  await chmod(paths.executable, 0o755);
  if (target.platform === 'win32') await verifyWindowsX64(paths.executable);
  else await verifyExecutable(paths.executable, `nootify ${version}`, target);
}

export async function createMacDmg(source, output, { execute = run, wait = delay } = {}) {
  // Build beside the destination so publication is one same-volume rename.
  // A failed attempt must never replace an existing, complete installer.
  const temporary = await mkdtemp(join(dirname(output), '.dmg-image-'));
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const image = join(temporary, `attempt-${attempt}.dmg`);
      try {
        await execute('/usr/bin/hdiutil', ['create', '-volname', 'Nootify', '-srcfolder', source, '-nospotlight', '-format', 'UDZO', image],
          { cwd: root, timeout: 120_000, maxBuffer: 16 << 20 });
      } catch (error) {
        // hdiutil can return EBUSY (16), or a generic exit with the native
        // diagnostic. Do not retry timeouts, signals, spawn or other failures.
        const busy = Number.isInteger(error?.code) && error.code > 0 && !error.signal && !error.killed
          && (error.code === 16 || /(?:^|\r?\n)hdiutil: create failed - Resource busy(?:\r?\n|$)/.test(String(error.stderr)));
        if (!busy || attempt === 3) throw error;
        console.warn(`desktop: hdiutil create is busy; retrying (${attempt + 1}/3)`);
        await wait(attempt * 1000);
        continue;
      }
      await execute('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', image], { cwd: root, timeout: 30_000 });
      await rename(image, output);
      return;
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function packageMac(paths, version, appID, bundles) {
  await writeFile(join(paths.app, 'Contents', 'Info.plist'), macInfoPlist(version, appID));
  await writeFile(join(paths.app, 'Contents', 'PkgInfo'), 'APPL????');
  for (const name of ['node', 'nootify-core', 'nootify-tsnet', 'Nootify']) {
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', join(paths.app, 'Contents', 'MacOS', name)], { cwd: root });
  }
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', paths.app], { cwd: root });
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', paths.app], { cwd: root });
  // The updater archive keeps the existing Nootify.app top-level member.
  const archive = join(paths.macos, 'Nootify.app.tar.gz');
  await run('/usr/bin/tar', ['-czf', archive, '-C', paths.macos, 'Nootify.app'], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (bundles.includes('dmg')) {
    await mkdir(paths.dmg, { recursive: true });
    const staging = await mkdtemp(join(paths.output, '.dmg-'));
    try {
      await cp(paths.app, join(staging, 'Nootify.app'), { recursive: true });
      await symlink('/Applications', join(staging, 'Applications'));
      const dmg = join(paths.dmg, `Nootify_${version}_aarch64.dmg`);
      await createMacDmg(staging, dmg);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  return archive;
}

export async function windowsPayloadManifest(payload) {
  const manifest = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) manifest[relative(payload, path).split(sep).join('/')] = createHash('sha256').update(await readFile(path)).digest('hex');
      else throw new Error('Windows installer payload contains a redirected or special entry');
    }
  }
  await visit(payload);
  return manifest;
}

async function packageWindows(paths, version) {
  await mkdir(paths.nsis, { recursive: true });
  const installer = join(paths.nsis, `Nootify_${version}_x64-setup.exe`);
  const helper = join(paths.output, 'nootify-installer-stage.exe');
  await run('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -H=windowsgui', '-o', helper, './cmd/installer-stage'], {
    cwd: join(root, 'desktop'), env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' }, maxBuffer: 16 << 20,
  });
  await verifyWindowsX64(helper);
  const manifest = join(paths.output, 'installer-payload.json');
  await writeFile(manifest, JSON.stringify(await windowsPayloadManifest(paths.payload)));
  await withNsisCompiler(root, compiler => run(compiler, ['/V3', `/DVERSION=${version}`, `/DPAYLOAD=${paths.payload}`, `/DOUTPUT=${installer}`,
    `/DSTAGER=${helper}`, `/DMANIFEST=${manifest}`, `/DICON=${join(root, 'desktop', 'icons', 'icon.ico')}`, `/DHOOKS=${join(root, 'scripts', 'windows-installer-hooks.nsh')}`, join(root, 'windows', 'installer.nsi')], { cwd: root, maxBuffer: 16 << 20 }));
  return installer;
}

export async function signUpdate(file) {
  // Do not include keys in arguments or child error output. The Go CLI reads
  // NOOTIFY_SIGNING_* and the legacy TAURI_SIGNING_* compatibility variables.
  try {
    await run('go', ['-C', 'desktop', 'run', '-mod=readonly', './cmd/sign-update', '--file', file], { cwd: root, maxBuffer: 4 << 20 });
  } catch {
    throw new Error('Go updater signing failed; check the configured signing key and password');
  }
}

export async function buildDesktop(options) {
  const { target, command, bundles, noSign } = options;
  if (target.platform !== process.platform || target.arch !== process.arch) throw new Error('Desktop packaging must run on its target platform and architecture');
  const development = command === 'dev';
  const { version: currentVersion } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = packageVersion(options.version ?? currentVersion);
  const appID = development ? DEV_APP_ID : APP_ID;
  const paths = desktopPaths(target, root, development);
  await runNpm(['run', 'build'], { cwd: root, maxBuffer: 16 << 20 });
  await stageServiceBundle({ target, version });
  await rm(paths.output, { recursive: true, force: true });
  await mkdir(target.platform === 'darwin' ? join(paths.app, 'Contents', 'MacOS') : paths.payload, { recursive: true });
  await compileDesktop(target, paths, version, appID);
  await copyPayload(target, paths);
  const updater = target.platform === 'darwin'
    ? await packageMac(paths, version, appID, development ? ['app'] : bundles)
    : development ? undefined : await packageWindows(paths, version);
  if (!noSign && updater) await signUpdate(updater);
  console.log(`desktop: ${development ? 'development app' : 'bundle'} built in ${paths.output}`);
  return paths;
}

async function main() {
  const options = parseDesktopArgs(process.argv.slice(2));
  const paths = await buildDesktop(options);
  if (options.command === 'dev') {
    // This command is explicitly invoked to launch development; packaging and
    // CI never start a desktop window implicitly.
    const child = spawn(paths.executable, [], { cwd: root, stdio: 'inherit', env: process.env });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`desktop: ${error.message}`); process.exitCode = 1; });
}
