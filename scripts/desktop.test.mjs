import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildTarget, sidecarName } from './build-targets.mjs';
import { APP_ID, DEV_APP_ID, copyPayload, desktopLinkerFlags, desktopPaths, macInfoPlist, packageVersion, parseDesktopArgs } from './desktop.mjs';
import { NSIS_SHA256, NSIS_URL, verifyNsisArchive } from './nsis.mjs';
import { verifyWindowsX64 } from './bundle-utils.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const mac = buildTarget('aarch64-apple-darwin');
const windows = buildTarget('x86_64-pc-windows-msvc');
async function temporary(t) {
  const work = await mkdtemp(join(tmpdir(), 'nootify desktop packaging '));
  t.after(() => rm(work, { recursive: true, force: true }));
  return work;
}
async function put(path, text) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }

test('bundle paths retain published artifact locations and separate development identity', () => {
  const base = join(tmpdir(), 'nootify layout');
  const paths = desktopPaths(mac, base);
  assert.equal(paths.executable, join(base, 'build/desktop/aarch64-apple-darwin/macos/Nootify.app/Contents/MacOS/Nootify'));
  assert.equal(paths.dmg, join(base, 'build/desktop/aarch64-apple-darwin/dmg'));
  assert.equal(desktopPaths(windows, base).nsis, join(base, 'build/desktop/x86_64-pc-windows-msvc/nsis'));
  assert.equal(paths.binaries, join(base, 'build/binaries'));
  assert.equal(paths.service, join(base, 'build/resources/service'));
  assert.notEqual(desktopPaths(mac, base, true).output, paths.output);
  assert.equal(APP_ID, 'dev.idy.nootify');
  assert.equal(DEV_APP_ID, 'dev.idy.nootify.dev');
});

test('direct builds pass package identity/version to MyGo and the desktop host together', () => {
  for (const identity of [APP_ID, DEV_APP_ID]) {
    const flags = desktopLinkerFlags(windows, '1.2.3', identity);
    assert.ok(flags.includes(`-X main.appID=${identity}`));
    assert.ok(flags.includes(`-X github.com/egoist/mygo.packageIdentifier=${identity}`));
    assert.ok(flags.includes('-X github.com/egoist/mygo.packageName=Nootify'));
    assert.ok(flags.includes('-X github.com/egoist/mygo.packageVersion=1.2.3'));
    assert.ok(flags.includes('-X main.version=1.2.3'));
    assert.ok(flags.includes('-H=windowsgui'));
  }
  assert.ok(!desktopLinkerFlags(mac, '1.2.3').includes('-H=windowsgui'));
  assert.throws(() => desktopLinkerFlags(mac, '1.2.3', 'other identity'), /Unsupported app identity/);
});

test('package version overrides build native metadata without a second version authority', () => {
  const args = parseDesktopArgs(['build', '--target', windows.triple, '--package-version', '0.0.0', '--no-sign', '--ci']);
  assert.equal(args.version, '0.0.0');
  assert.equal(args.noSign, true);
  assert.throws(() => parseDesktopArgs(['build', '--target', windows.triple, '--package-version', '0.0.0']), /unsigned test fixtures/);
  assert.deepEqual(args.bundles, ['nsis']);
  assert.equal(parseDesktopArgs(['dev', '--target', mac.triple]).noSign, true);
  assert.throws(() => parseDesktopArgs(['build', '--target', windows.triple, '--bundles', 'dmg']), /Unsupported bundles/);
  assert.throws(() => parseDesktopArgs(['build', '--config', 'obsolete-config.json']), /Unknown option/);
  for (const value of ['1.2', '1.02.3', '1.2.3\n', '65536.0.0', '1.2.3-beta', '1.2.3 -X main.appID=other']) assert.throws(() => packageVersion(value));
  const plist = macInfoPlist('1.2.3');
  assert.match(plist, /CFBundleIdentifier<\/key><string>dev\.idy\.nootify<\/string>/);
  assert.match(plist, /CFBundleExecutable<\/key><string>Nootify<\/string>/);
  assert.match(plist, /CFBundleShortVersionString<\/key><string>1\.2\.3<\/string>/);
  assert.match(plist, /LSMinimumSystemVersion<\/key><string>13\.5<\/string>/);
  assert.match(plist, /NSAllowsLocalNetworking/);
});

test('staged payload preserves the paths pinned by existing LaunchAgents and tasks', async t => {
  const base = await temporary(t);
  await put(join(base, 'desktop/icons/icon.icns'), 'icon');
  for (const target of [mac, windows]) {
    const paths = desktopPaths(target, base);
    for (const name of ['node', 'nootify-core', 'nootify-tsnet']) await put(join(paths.binaries, sidecarName(name, target)), `${name} ${target.triple}`);
    await put(join(paths.service, 'dist/src/cli.js'), 'cli');
    await put(join(paths.service, 'dist/src/server.js'), 'server');
    await put(paths.executable, 'desktop');
    await copyPayload(target, paths, base);
    const binaries = target === mac ? join(paths.app, 'Contents/MacOS') : paths.payload;
    const resources = target === mac ? join(paths.app, 'Contents/Resources') : paths.payload;
    assert.deepEqual((await readdir(binaries)).filter(file => !['service', 'uninstall.exe'].includes(file)).sort(),
      [`Nootify${target.extension}`, `node${target.extension}`, `nootify-core${target.extension}`, `nootify-tsnet${target.extension}`].sort());
    assert.equal(await readFile(join(resources, 'service/dist/src/cli.js'), 'utf8'), 'cli');
    assert.equal(await readFile(join(resources, 'service/dist/src/server.js'), 'utf8'), 'server');
  }
});

test('production NSIS runs ownership hooks before all replacement/removal and preserves update identity', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const install = installer.slice(installer.indexOf('Section "Nootify"'), installer.indexOf('Function .onInstSuccess'));
  const uninstall = installer.slice(installer.indexOf('Section "Uninstall"'));
  assert.ok(install.indexOf('Call NootifyPreflightDesktop') >= 0);
  assert.ok(install.indexOf('Call NootifyPreflightDesktop') < install.indexOf('!insertmacro NSIS_HOOK_PREINSTALL'));
  assert.ok(install.indexOf('!insertmacro NSIS_HOOK_PREINSTALL') < install.indexOf('RMDir /r'));
  assert.ok(install.indexOf('!insertmacro NSIS_HOOK_PREINSTALL') < install.indexOf('  File '));
  assert.ok(uninstall.indexOf('!insertmacro NSIS_HOOK_PREUNINSTALL') < uninstall.indexOf('  Delete '));
  assert.match(installer, /RequestExecutionLevel user/);
  assert.match(installer, /Uninstall\\Nootify/);
  assert.match(installer, /GetOptions.*"\/UPDATE"/);
  assert.match(installer, /GetOptions.*"\/R"/);
  assert.match(installer, /AppUserModelId" "dev\.idy\.nootify"/);
  assert.match(installer, /\$\{If\} \$0 == \$INSTDIR/);
  assert.doesNotMatch(installer, /taskkill|RMDir \/r "\$INSTDIR"|LOCALAPPDATA.*state|ExecWait.*uninstall/i);
  const hooks = await readFile(join(root, 'scripts/windows-installer-hooks.nsh'), 'utf8');
  assert.match(hooks, /NSIS_HOOK_PREINSTALL\s+!insertmacro NootifyManageInstalledService service-stop/);
  assert.match(hooks, /\$UpdateMode = 1\s+!insertmacro NootifyManageInstalledService service-stop\s+\$\{Else\}\s+!insertmacro NootifyManageInstalledService service-uninstall/);
  for (const variable of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_ICU_DATA']) assert.match(hooks, new RegExp(`NootifyClearNodeVariable ${variable}`));
});

test('desktop preflight probes write access without truncation and bounds updater handoff', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const guard = installer.slice(installer.indexOf('Function NootifyPreflightDesktop'), installer.indexOf('Section "Nootify"'));
  assert.match(guard, /\$UpdateMode = 1[\s\S]*StrCpy \$1 80/);
  assert.match(guard, /CreateFileW\(w "\$INSTDIR\\Nootify\.exe", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0\)/);
  assert.match(guard, /CloseHandle\(p r0\)/);
  assert.match(guard, /Sleep 250\s+IntOp \$1 \$1 - 1/);
  assert.match(guard, /SetErrorLevel 1[\s\S]*Close Nootify and retry[\s\S]*\/SD IDOK[\s\S]*Abort/);
  assert.doesNotMatch(guard, /service-stop|RMDir|Delete|taskkill|TerminateProcess|FileOpen/i);
});

test('NSIS compiler pin rejects corrupt downloads before executable extraction', async t => {
  const work = await temporary(t);
  const path = join(work, 'compiler.zip');
  await writeFile(path, 'a downloaded executable must never be trusted implicitly');
  await assert.rejects(verifyNsisArchive(path), /refusing extraction or execution/);
  assert.equal(NSIS_SHA256, 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8');
  assert.match(NSIS_URL, /^https:\/\/downloads\.sourceforge\.net\//);
  const smoke = await readFile(join(root, 'scripts/windows-installer-hook-smoke.ps1'), 'utf8');
  assert.ok(smoke.includes(NSIS_SHA256.toUpperCase()));
  assert.ok(smoke.includes(NSIS_URL));
});

test('pure Go resources link from a disposable module copy with actual Windows icon/version/manifest', { timeout: 180_000 }, async t => {
  const work = await temporary(t);
  const syso = join(work, 'resources.syso');
  const env = { ...process.env, CGO_ENABLED: '0' }; delete env.GOOS; delete env.GOARCH;
  await run('go', ['run', join(root, 'scripts/windows-resources.go'), '--icon', join(root, 'desktop/icons/icon.ico'), '--version', '1.2.3', '--output', syso], { cwd: root, env });
  const source = join(work, 'module');
  await put(join(source, 'go.mod'), 'module packaging-fixture\n\ngo 1.27.3\n');
  await put(join(source, 'main.go'), 'package main\nfunc main() {}\n');
  const buildSource = join(work, 'build-module');
  await cp(source, buildSource, { recursive: true });
  await cp(syso, join(buildSource, 'nootify_windows_amd64.syso'));
  const executable = join(work, 'Nootify.exe');
  await run('go', ['build', '-mod=readonly', '-buildvcs=false', '-o', executable, '.'], { cwd: buildSource, env: { ...env, GOOS: 'windows', GOARCH: 'amd64' } });
  await verifyWindowsX64(executable);
  const pe = await readFile(executable);
  assert.ok(pe.includes(Buffer.from('.rsrc')));
  assert.ok(pe.includes(Buffer.from('ProductVersion\0', 'utf16le')));
  assert.ok(pe.includes(Buffer.from('1.2.3\0', 'utf16le')));
  assert.ok(pe.includes(Buffer.from('dev.idy.nootify\0', 'utf16le')));
  assert.ok(pe.includes(Buffer.from('PerMonitorV2')));
  assert.ok(pe.includes(Buffer.from('MyGoIdentifier\0', 'utf16le')));
  // Generated files never modify the original module source tree.
  assert.deepEqual((await readdir(source)).sort(), ['go.mod', 'main.go']);
  await writeFile(join(work, 'bad.ico'), 'broken');
  await assert.rejects(run('go', ['run', join(root, 'scripts/windows-resources.go'), '--icon', join(work, 'bad.ico'), '--version', '1.2.3', '--output', syso], { cwd: root, env }), /invalid ICO header/);
});
