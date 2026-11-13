import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildTarget } from './build-targets.mjs';
import { APP_ID, DEV_APP_ID, copyPayload, desktopLinkerFlags, desktopPaths, macInfoPlist, packageVersion, parseDesktopArgs, windowsPayloadManifest } from './desktop.mjs';
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
  assert.equal(paths.resources, join(base, 'build/resources/licenses'));
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

test('staged payload contains the Go executable, licenses and macOS upgrade bridge', async t => {
  const base = await temporary(t);
  await put(join(base, 'desktop/icons/icon.icns'), 'icon');
  for (const target of [mac, windows]) {
    const paths = desktopPaths(target, base);
    await put(join(paths.resources, 'third-party-notices.txt'), 'notices');
    await put(paths.executable, 'desktop');
    await copyPayload(target, paths, base);
    const binaries = target === mac ? join(paths.app, 'Contents/MacOS') : paths.payload;
    const resources = target === mac ? join(paths.app, 'Contents/Resources') : paths.payload;
    const expected = target === mac ? ['Nootify', 'node', 'nootify-core', 'nootify-tsnet'] : ['Nootify.exe'];
    assert.deepEqual((await readdir(binaries)).filter(file => file !== 'licenses').sort(), expected);
    assert.equal(await readFile(join(resources, 'licenses/third-party-notices.txt'), 'utf8'), 'notices');
    if (target !== mac) continue;
    // Frozen v0.2.1 archive.go / service.Current contract: symlinks and empty
    // placeholders fail before the old updater can exchange the app bundle.
    for (const name of ['MacOS/node', 'MacOS/nootify-core', 'MacOS/nootify-tsnet', 'Resources/service/dist/src/cli.js', 'Resources/service/dist/src/server.js']) {
      const info = await lstat(join(paths.app, 'Contents', name));
      assert.ok(info.isFile() && info.size > 0, `legacy updater requires regular file ${name}`);
      if (name.startsWith('MacOS/') && process.platform !== 'win32') assert.ok(info.mode & 0o111);
    }
  }
});

test('macOS legacy launcher forwards old CLI and daemon argv without a Node runtime', { skip: process.platform !== 'darwin' }, async t => {
  const base = await temporary(t);
  const paths = desktopPaths(mac, base);
  await put(join(base, 'desktop/icons/icon.icns'), 'icon');
  await put(join(paths.resources, 'third-party-notices.txt'), 'notices');
  await put(paths.executable, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n');
  await chmod(paths.executable, 0o755);
  await copyPayload(mac, paths, base);
  const contents = join(paths.app, 'Contents');
  const launcher = join(contents, 'MacOS/node');
  const cli = join(contents, 'Resources/service/dist/src/cli.js');
  const server = join(contents, 'Resources/service/dist/src/server.js');
  const options = { env: { ...process.env, NODE_OPTIONS: '--require=/missing/injected.js', NODE_PATH: '/missing/modules' } };
  for (const action of ['service-start', 'service-restart', 'service-stop', 'service-status', 'thread-open']) {
    const args = [action, '--state-dir', join(base, 'private state'), '--port', '19417'];
    const { stdout } = await run(launcher, [cli, ...args], options);
    const expected = action.startsWith('service-') ? [action, '--preserve-legacy-launchd', ...args.slice(1)] : args;
    assert.equal(stdout, expected.map(value => `<${value}>\n`).join(''));
  }
  const { stdout } = await run(launcher, [server, '--state-dir', join(base, 'private state')], options);
  assert.equal(stdout, `<serve>\n<--state-dir>\n<${join(base, 'private state')}>\n`);
  for (const args of [[], [cli], [join(base, 'foreign.js'), 'service-start']]) {
    await assert.rejects(run(launcher, args, options), error => error.code === 64);
  }
  for (const name of ['nootify-core', 'nootify-tsnet']) {
    await assert.rejects(run(join(contents, 'MacOS', name), [], options), error => error.code === 64);
  }
});

test('production NSIS stages before transactional replacement and guards uninstall ownership', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const install = installer.slice(installer.indexOf('Section "Nootify"'), installer.indexOf('Function .onInstSuccess'));
  const uninstall = installer.slice(installer.indexOf('Section "Uninstall"'));
  assert.ok(install.indexOf('Call NootifyCheckRegisteredDestination') >= 0);
  assert.ok(install.indexOf('Call NootifyPreflightPayload') < install.indexOf('NootifyTransaction prepare'));
  assert.ok(install.indexOf('Call NootifyPreflightDesktop') < install.indexOf('NootifyTransaction prepare'));
  assert.ok(install.indexOf('NootifyTransaction prepare') < install.indexOf('  File '));
  const staging = install.indexOf(String.raw`SetOutPath "$INSTDIR\.nootify-installer\new"`);
  assert.ok(staging >= 0 && staging < install.indexOf('  File '));
  assert.ok(install.indexOf('  File /r') < install.indexOf('NootifyTransaction apply'));
  assert.ok(install.indexOf('NootifyTransaction apply') < install.indexOf('WriteRegStr HKCU'));
  assert.ok(install.indexOf('WriteRegStr HKCU') < install.indexOf('NootifyTransaction finish'));
  assert.doesNotMatch(install, /RMDir \/r|NSIS_HOOK_PREINSTALL/);
  assert.match(installer, /Function \.onInstFailed[\s\S]*--action recover/);
  assert.ok(uninstall.indexOf('Call un.NootifyPreflightDesktop') >= 0);
  assert.ok(uninstall.indexOf('Call un.NootifyPreflightDesktop') < uninstall.indexOf('!insertmacro NSIS_HOOK_PREUNINSTALL'));
  assert.ok(uninstall.indexOf('!insertmacro NSIS_HOOK_PREUNINSTALL') < uninstall.indexOf('NootifyTransaction remove'));
  assert.ok(uninstall.indexOf('NootifyTransaction remove') < uninstall.indexOf('  Delete '));
  assert.ok(uninstall.indexOf('  Delete ') < uninstall.indexOf('DeleteRegKey HKCU'));
  assert.match(uninstall, /Delete "\$INSTDIR\\uninstall\.exe"\s+\$\{If\} \$\{Errors\}[\s\S]*Abort/);
  assert.doesNotMatch(uninstall, /RMDir \/r|Delete "\$INSTDIR\\node\.exe"/);
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
  assert.match(hooks, /nootify-installer-stage\.exe.*--action \$\{COMMAND\}/);
  assert.doesNotMatch(hooks, /node\.exe|cli\.js/);
});

test('install and uninstall share a nondestructive desktop preflight with bounded updater handoff', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const start = installer.indexOf('!macro NootifyPreflightDesktop OPERATION');
  assert.ok(start >= 0);
  const guard = installer.slice(start, installer.indexOf('!macroend', start));
  assert.match(installer, /Function NootifyPreflightDesktop\s+!insertmacro NootifyPreflightDesktop "installation"\s+FunctionEnd/);
  assert.match(installer, /Function un\.NootifyPreflightDesktop\s+!insertmacro NootifyPreflightDesktop "uninstallation"\s+FunctionEnd/);
  assert.match(guard, /\$UpdateMode = 1[\s\S]*StrCpy \$1 "--wait-desktop"/);
  assert.match(guard, /nootify-installer-stage\.exe.*--action preflight --target.*\$1/);
  assert.equal(guard.match(/nsExec::ExecToLog/g)?.length, 1);
  assert.doesNotMatch(guard, /\$\{Do\}|\$\{Loop\}|Sleep|IntOp/);
  assert.match(guard, /SetErrorLevel 1[\s\S]*Close Nootify and retry[\s\S]*\/SD IDOK[\s\S]*Abort/);
  assert.doesNotMatch(guard, /service-stop|RMDir|Delete|taskkill|TerminateProcess|FileOpen/i);
});

test('fresh Windows targets refuse unowned payload before stopping or recursively removing service files', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const install = installer.slice(installer.indexOf('Section "Nootify"'), installer.indexOf('Function .onInstSuccess'));
  assert.ok(install.indexOf('Call NootifyPreflightPayload') < install.indexOf('NootifyTransaction prepare'));
  assert.ok(install.indexOf('Call NootifyPreflightInstalledFiles') < install.indexOf('NootifyTransaction apply'));
  const guard = installer.slice(installer.indexOf('Function NootifyPreflightPayload'), installer.indexOf('!macro NootifyPreflightDesktop'));
  // GetFileAttributes also detects an empty service directory, unlike a glob.
  assert.match(guard, /GetFileAttributesW\(w "\$INSTDIR\\service"\)/);
  assert.match(guard, /IntOp \$1 \$0 & 0x400[\s\S]*reparse point/);
  assert.match(guard, /ReadRegStr \$0 HKCU "\$\{UNINSTALL_KEY\}" "InstallLocation"[\s\S]*\$0 != \$INSTDIR[\s\S]*Abort/);
  assert.match(guard, /IfNot.*FileExists.*Nootify\.exe[\s\S]*Abort/);
  assert.doesNotMatch(guard.slice(guard.indexOf('Function NootifyPreflightInstalledFiles')), /node\.exe|cli\.js/);
  const destinationStart = installer.indexOf('Function NootifyCheckRegisteredDestination');
  const destination = installer.slice(destinationStart, installer.indexOf('FunctionEnd', destinationStart));
  assert.match(destination, /ReadRegStr \$RegisteredLocation[\s\S]*\$RegisteredLocation != ""[\s\S]*\$RegisteredLocation != \$INSTDIR[\s\S]*Abort/);
  assert.doesNotMatch(guard, /RMDir|Delete|service-stop|service-uninstall/);
});

test('fresh transaction recovery requires a pending receipt before any prepare or registration', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const start = installer.indexOf('Function NootifyPrepareFreshReceipt');
  const receipt = installer.slice(start, installer.indexOf('FunctionEnd', start));
  const install = installer.slice(installer.indexOf('Section "Nootify"'), installer.indexOf('Function .onInstFailed'));
  assert.match(receipt, /GetFileAttributesW[\s\S]*unowned installer transaction[\s\S]*CoCreateGuid[\s\S]*WriteRegStr HKCU "\$\{PENDING_KEY\}" "Target"[\s\S]*"Token"/);
  assert.ok(install.indexOf('Call NootifyPreflightPayload') < install.indexOf('Call NootifyPrepareFreshReceipt'));
  assert.ok(install.indexOf('Call NootifyPrepareFreshReceipt') < install.indexOf('NootifyTransaction prepare'));
  assert.ok(install.indexOf('NootifyTransaction finish') < install.indexOf('DeleteRegKey HKCU "${PENDING_KEY}"'));
  assert.match(installer, /--fresh-token "\$FreshToken"/);
});

test('incomplete receipt cleanup precedes destination lock and shares headless native probe logic', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const receipt = await readFile(join(root, 'windows/pending-receipt.nsh'), 'utf8');
  const probe = await readFile(join(root, 'scripts/windows-installer-hook-smoke.nsi'), 'utf8');
  const smoke = await readFile(join(root, 'scripts/windows-installer-hook-smoke.ps1'), 'utf8');
  const start = installer.indexOf('Function NootifyCheckRegisteredDestination');
  const check = installer.slice(start, installer.indexOf('FunctionEnd', start));
  assert.ok(check.indexOf('NootifyReadPendingReceipt') < check.indexOf('NootifyCheckPendingDestination'));
  assert.ok(check.indexOf('NootifyCheckPendingDestination') < check.indexOf('$RegisteredLocation != ""'));
  assert.match(receipt, /\$PendingLocation == ""\s+\$\{OrIf\} \$FreshToken == ""[\s\S]*RegGetValueW[\s\S]*\$0 != 2[\s\S]*\$1 != 2[\s\S]*DeleteRegKey/);
  assert.doesNotMatch(receipt, /GetFileAttributes|FileExists|RMDir|FileOpen|service-/);
  for (const macro of ['NootifyReadPendingReceipt', 'NootifyCheckPendingDestination']) assert.ok(probe.includes(`!insertmacro ${macro}`));
  for (const name of ['target-only', 'token-only', 'empty-token', 'invalid-type', 'invalid-pair', 'valid-other-unavailable', 'valid-matching-unavailable']) assert.ok(smoke.includes(`name = '${name}'`));
  assert.match(probe, /GetOptions.*\/RECEIPT=/);
  assert.match(smoke, /Complete or unreadable pending authority was changed/);
});

test('native hook probe follows Go helper diagnostics and retains poisoned-environment coverage', async () => {
  const hooks = await readFile(join(root, 'scripts/windows-installer-hooks.nsh'), 'utf8');
  const smoke = await readFile(join(root, 'scripts/windows-installer-hook-smoke.ps1'), 'utf8');
  const invoke = hooks.indexOf('NootifyInstallerTrace "manage ${COMMAND}: invoking helper"');
  const execute = hooks.indexOf('nsExec::ExecToLog');
  const result = hooks.indexOf('NootifyInstallerTrace "manage ${COMMAND}: result=$0"');
  assert.ok(invoke >= 0 && invoke < execute && execute < result);
  assert.ok(smoke.includes('$trace.Contains("manage ${command}: invoking helper")'));
  assert.ok(smoke.includes('$trace.Contains("manage ${command}: result=0")'));
  assert.doesNotMatch(smoke, /lost an environment API diagnostic|invoking CLI/);
  for (const variable of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_ICU_DATA']) {
    assert.ok(smoke.includes(variable));
  }
  assert.match(smoke, /foreach \(\$poisoned in @\(\$false, \$true\)\)/);
  assert.match(smoke, /go build -o \$helper \$helperSource/);
  assert.match(smoke, /safe_working_directory -ne \$true/);
  assert.match(smoke, /did not preserve registers\/stack/);
});

test('Windows payload manifest verifies exact extracted bytes and excludes generated uninstaller', async t => {
  const work = await temporary(t);
  await put(join(work, 'Nootify.exe'), 'desktop');
  await put(join(work, 'licenses/third-party-notices.txt'), 'notices');
  assert.deepEqual(await windowsPayloadManifest(work), {
    'Nootify.exe': createHash('sha256').update('desktop').digest('hex'),
    'licenses/third-party-notices.txt': createHash('sha256').update('notices').digest('hex'),
  });
});

test('portable installer transaction regressions pass and helper cross-compiles without execution', { timeout: 180_000 }, async t => {
  const work = await temporary(t);
  const env = { ...process.env, CGO_ENABLED: '0' }; delete env.GOOS; delete env.GOARCH;
  await run('go', ['test', './cmd/installer-stage'], { cwd: join(root, 'desktop'), env });
  const helper = join(work, 'nootify-installer-stage.exe');
  await run('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -H=windowsgui', '-o', helper, './cmd/installer-stage'], {
    cwd: join(root, 'desktop'), env: { ...env, GOOS: 'windows', GOARCH: 'amd64' },
  });
  await verifyWindowsX64(helper);
});

test('Windows installer acknowledges its opened private-cache image without deleting live files', async () => {
  const installer = await readFile(join(root, 'windows/installer.nsi'), 'utf8');
  const cleanup = await readFile(join(root, 'desktop/internal/updater/cleanup.go'), 'utf8');
  const ackStart = installer.indexOf('Function NootifyAcknowledgeUpdater');
  const ack = installer.slice(ackStart, installer.indexOf('FunctionEnd', ackStart));
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
