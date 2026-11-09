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
import { NSIS_SHA256, NSIS_URL, NSIS_URLS, downloadNsisArchive, verifyNsisArchive } from './nsis.mjs';
import { createHash } from 'node:crypto';
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
  assert.ok(uninstall.indexOf('Call un.NootifyPreflightDesktop') >= 0);
  assert.ok(uninstall.indexOf('Call un.NootifyPreflightDesktop') < uninstall.indexOf('!insertmacro NSIS_HOOK_PREUNINSTALL'));
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

test('install and uninstall share a nondestructive desktop preflight with bounded updater handoff', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const start = installer.indexOf('!macro NootifyPreflightDesktop OPERATION');
  assert.ok(start >= 0);
  const guard = installer.slice(start, installer.indexOf('!macroend', start));
  assert.match(installer, /Function NootifyPreflightDesktop\s+!insertmacro NootifyPreflightDesktop "installation"\s+FunctionEnd/);
  assert.match(installer, /Function un\.NootifyPreflightDesktop\s+!insertmacro NootifyPreflightDesktop "uninstallation"\s+FunctionEnd/);
  assert.match(guard, /\$UpdateMode = 1[\s\S]*StrCpy \$1 80/);
  assert.match(guard, /CreateFileW\(w "\$INSTDIR\\Nootify\.exe", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0\)/);
  assert.match(guard, /CloseHandle\(p r0\)/);
  assert.match(guard, /Sleep 250\s+IntOp \$1 \$1 - 1/);
  assert.match(guard, /SetErrorLevel 1[\s\S]*Close Nootify and retry[\s\S]*\/SD IDOK[\s\S]*Abort/);
  assert.doesNotMatch(guard, /service-stop|RMDir|Delete|taskkill|TerminateProcess|FileOpen/i);
});

test('fresh Windows targets refuse unowned payload before stopping or recursively removing service files', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const install = installer.slice(installer.indexOf('Section "Nootify"'), installer.indexOf('Function .onInstSuccess'));
  assert.ok(install.indexOf('Call NootifyPreflightPayload') < install.indexOf('!insertmacro NSIS_HOOK_PREINSTALL'));
  assert.ok(install.indexOf('Call NootifyPreflightPayload') < install.indexOf('RMDir /r'));
  const guard = installer.slice(installer.indexOf('Function NootifyPreflightPayload'), installer.indexOf('!macro NootifyPreflightDesktop'));
  // GetFileAttributes also detects an empty service directory, unlike a glob.
  assert.match(guard, /GetFileAttributesW\(w "\$INSTDIR\\service"\)/);
  assert.match(guard, /IntOp \$1 \$0 & 0x400[\s\S]*reparse point/);
  assert.match(guard, /ReadRegStr \$0 HKCU "\$\{UNINSTALL_KEY\}" "InstallLocation"[\s\S]*\$0 != \$INSTDIR[\s\S]*Abort/);
  assert.match(guard, /IfNot.*FileExists.*Nootify\.exe[\s\S]*OrIfNot.*node\.exe[\s\S]*OrIfNot.*cli\.js[\s\S]*Abort/);
  assert.doesNotMatch(guard, /RMDir|Delete|service-stop|service-uninstall/);
});

test('Windows installer acknowledges its opened private-cache image without deleting live files', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const cleanup = await readFile(join(root, 'desktop/internal/updater/cleanup.go'), 'utf8');
  const ack = installer.slice(installer.indexOf('Function NootifyAcknowledgeUpdater'), installer.indexOf('Function NootifyPreflightPayload'));
  assert.match(installer, /Function \.onInit[\s\S]*Call NootifyAcknowledgeUpdater[\s\S]*FunctionEnd/);
  assert.match(ack, /\$UpdateMode != 1/);
  assert.match(ack, /\$EXEFILE != "Nootify-setup\.exe"/);
  assert.match(ack, /\$LOCALAPPDATA\\dev\.idy\.nootify\\updates/);
  assert.match(ack, /GetParent.*\$EXEDIR[\s\S]*GetFileName.*\$EXEDIR[\s\S]*installer-/);
  for (const state of ['pending', 'opened']) {
    assert.ok(ack.includes(`nootify-installer-${state}-v1$\\n`));
    assert.ok(cleanup.includes(`nootify-installer-${state}-v1\\n`));
  }
  assert.doesNotMatch(ack, /RMDir|Delete|MoveFileEx|Exec/);
  assert.doesNotMatch(cleanup, /RemoveAll/);
});

test('legacy /P updater installs skip directory input and close automatically on success', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const init = installer.slice(installer.indexOf('Function .onInit'), installer.indexOf('Function un.onInit'));
  const success = installer.slice(installer.indexOf('Function .onInstSuccess'), installer.indexOf('Section "Uninstall"'));
  assert.match(installer, /GetOptions.*"\/P"[\s\S]*StrCpy \$PassiveMode 1/);
  assert.match(installer, /Page directory NootifyDirectoryPre/);
  assert.match(installer, /Function NootifyDirectoryPre\s+\$\{If\} \$PassiveMode = 1\s+Abort\s+\$\{EndIf\}\s+FunctionEnd/);
  assert.match(init, /\$PassiveMode = 1\s+SetAutoClose true/);
  assert.match(success, /\$Relaunch = 1\s+Exec .*Nootify\.exe/);
  const smoke = await readFile(join(root, 'scripts/windows-install-smoke.ps1'), 'utf8');
  // Exercise Tauri's exact old argv: no /S or /D to conceal a page/registry bug.
  assert.match(smoke, /Run-Native \$Installer '\/P \/UPDATE \/R' 'upgrade-legacy-passive'/);
});

test('NSIS compiler pin rejects corrupt downloads before executable extraction', async t => {
  const work = await temporary(t);
  const path = join(work, 'compiler.zip');
  await writeFile(path, 'a downloaded executable must never be trusted implicitly');
  await assert.rejects(verifyNsisArchive(path), /refusing extraction or execution/);
  assert.equal(NSIS_SHA256, 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8');
  assert.match(NSIS_URL, /^https:\/\/github\.com\/tauri-apps\/binary-releases\/releases\/download\/nsis-3\.13\//);
  assert.equal(NSIS_URLS.length, 2);
  assert.ok(NSIS_URLS.every(url => url.startsWith('https://')));
  const smoke = await readFile(join(root, 'scripts/windows-installer-hook-smoke.ps1'), 'utf8');
  assert.ok(smoke.includes(NSIS_SHA256.toUpperCase()));
  assert.match(smoke, /\$node \(Join-Path \$PSScriptRoot 'nsis\.mjs'\) --download \$archive/);
  assert.doesNotMatch(smoke, /Invoke-WebRequest/);
});

test('NSIS mirror fallback rejects HTML and replaces a corrupt cached download only with verified bytes', async t => {
  const work = await temporary(t);
  const archive = join(work, 'compiler.zip');
  await writeFile(archive, 'a previous corrupt download');
  const fixture = Buffer.from('PK synthetic archive bytes');
  const checksum = createHash('sha256').update(fixture).digest('hex');
  const urls = ['https://first.invalid/nsis.zip', 'https://mirror.invalid/nsis.zip'];
  const calls = [];
  await downloadNsisArchive(archive, { urls, checksum, fetchArchive: async url => {
    calls.push(url);
    return new Response(calls.length === 1 ? '<html>download landing page</html>' : fixture);
  } });
  assert.deepEqual(calls, urls);
  assert.deepEqual(await readFile(archive), fixture);
  assert.deepEqual(await readdir(work), ['compiler.zip']);
});

test('NSIS downloader rechecks a valid cache without requesting a mirror', async t => {
  const work = await temporary(t);
  const archive = join(work, 'compiler.zip');
  const fixture = Buffer.from('PK verified cache fixture');
  await writeFile(archive, fixture);
  const checksum = createHash('sha256').update(fixture).digest('hex');
  await downloadNsisArchive(archive, { checksum, fetchArchive: async () => assert.fail('valid cache should not be downloaded again') });
  assert.deepEqual(await readFile(archive), fixture);
});

test('NSIS downloader never publishes corrupt mirror responses or changes the production pin', async t => {
  const work = await temporary(t);
  const archive = join(work, 'compiler.zip');
  let calls = 0;
  await assert.rejects(downloadNsisArchive(archive, { fetchArchive: async () => {
    calls++; return new Response('<html>not a pinned compiler archive</html>');
  } }), /all pinned sources:.*SHA-256 mismatch.*refusing extraction or execution/);
  assert.equal(calls, NSIS_URLS.length);
  assert.deepEqual(await readdir(work), []);
  assert.equal(NSIS_SHA256, 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8');
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
