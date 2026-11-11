import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { goModules, modulesFromGoList, npmPackages, renderNotices, SPDX_LICENSE_LIST, spdxIds } from './third-party-notices.mjs';

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'nootify-notices-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

function module(dir, name, fields = {}) {
  return { kind: 'Go module', name, version: '1.0.0', license: 'MIT', authors: [], dir: join(dir, name), source: `https://example.com/${name}/1.0.0`, ...fields };
}

test('SPDX expressions and legacy slash lists name each license and exception once', () => {
  assert.deepEqual(spdxIds('MIT'), ['MIT']);
  assert.deepEqual(spdxIds('(MIT OR Apache-2.0) AND Unicode-3.0'), ['MIT', 'Apache-2.0', 'Unicode-3.0']);
  assert.deepEqual(spdxIds('MIT/Apache-2.0'), ['MIT', 'Apache-2.0']);
  assert.deepEqual(spdxIds('Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT'), ['Apache-2.0', 'LLVM-exception', 'MIT']);
});

test('Go module attribution uses linked dependencies, deduplicates and excludes local modules', () => {
  const modules = modulesFromGoList([
    'github.com/idy/nootify/desktop\t\t/work/desktop',
    'github.com/egoist/mygo\tv0.8.3\t/cache/mygo',
    'github.com/egoist/mygo\tv0.8.3\t/cache/mygo',
    'golang.org/x/sys\tv0.48.0\t/cache/sys', '',
  ].join('\n'));
  assert.deepEqual(modules.map(({ name }) => name), ['github.com/egoist/mygo', 'golang.org/x/sys']);
  assert.equal(modules[0].kind, 'Go module');
  assert.equal(modules[0].version, 'v0.8.3');
  assert.equal(modules[0].dir, '/cache/mygo');
  assert.equal(modules[0].source, 'https://github.com/egoist/mygo');
});

test('runtime attribution queries each build module and reproduces every selected toolchain license', async () => {
  const dir = await fixture({ 'go127/LICENSE': 'Go 1.27 runtime license', 'go128/LICENSE': 'Go 1.28 runtime license' });
  try {
    const calls = [];
    const components = await goModules({ goos: 'windows', goarch: 'amd64' }, async (command, args, options) => {
      assert.equal(command, 'go');
      const module = basename(options.cwd);
      assert.ok(['desktop', 'installer-stage'].includes(module), 'root-level toolchain selection must never be used');
      assert.equal(options.env.GOOS, 'windows'); assert.equal(options.env.GOARCH, 'amd64'); assert.equal(options.env.CGO_ENABLED, '0');
      calls.push([module, args[0]]);
      if (args[0] === 'list') return { stdout: 'example.com/shared\tv1.0.0\t/module-cache/shared\n' };
      assert.deepEqual(args, ['env', '-json', 'GOROOT', 'GOVERSION']);
      return { stdout: JSON.stringify(module === 'core'
        ? { GOROOT: join(dir, 'go128'), GOVERSION: 'go1.28.1' }
        : { GOROOT: join(dir, 'go127'), GOVERSION: 'go1.27.3' }) };
    });
    assert.equal(calls.length, 4);
    for (const module of ['desktop', 'installer-stage']) assert.deepEqual(calls.filter(([name]) => name === module).map(([, method]) => method).sort(), ['env', 'list']);
    const runtimes = components.filter(component => component.kind === 'Go runtime');
    assert.deepEqual(runtimes.map(component => component.version), ['go1.27.3']);
    assert.deepEqual(runtimes[0].executables, ['Nootify', 'nootify-installer-stage']);
    assert.equal(components.filter(component => component.kind === 'Go module').length, 1, 'shared dependencies remain deduplicated');
    const notices = await renderNotices('x86_64-pc-windows-msvc', runtimes, []);
    assert.match(notices, /Go standard library go1\.27\.3[\s\S]*Built into: Nootify, nootify-installer-stage[\s\S]*Go 1\.27 runtime license/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('notices reproduce shipped license files and fall back to SPDX texts of declared licenses', async () => {
  const dir = await fixture({
    'node_modules/with-file/package.json': { name: 'with-file', version: '2.0.0', license: 'MIT' },
    'node_modules/with-file/LICENSE': '\r\nCopyright (c) 2026 With File\r\n',
    'node_modules/with-file/node_modules/nested/package.json': { name: 'nested', version: '0.1.0', license: { type: 'ISC' } },
    'node_modules/with-file/node_modules/nested/LICENSE.md': 'ISC text of nested',
    'node_modules/@scope/no-file/package.json': { name: '@scope/no-file', version: '3.0.0', license: 'MIT', author: { name: 'Jane', email: 'jane@example.com' } },
    'node_modules/see-file/package.json': { name: 'see-file', version: '1.0.0', license: 'SEE LICENSE IN terms/EULA.txt' },
    'node_modules/see-file/terms/EULA.txt': 'EULA text of see-file',
    'node_modules/.bin/ignored': '',
    'modules/dual/LICENSE-APACHE': 'Apache text of dual',
    'modules/dual/LICENSE-MIT': 'MIT text of dual',
    'modules/dual/README.md': 'not a license',
    'modules/declared/licenses/LICENSE.txt': 'license-file text',
  });
  try {
    const modules = [module(join(dir, 'modules'), 'dual', { license: 'MIT OR Apache-2.0' }), module(join(dir, 'modules'), 'declared', { license: undefined, licenseFile: 'licenses/LICENSE.txt' })];
    const packages = await npmPackages(join(dir, 'node_modules'));
    assert.deepEqual(packages.map(({ name }) => name).sort(), ['@scope/no-file', 'nested', 'see-file', 'with-file']);
    const notices = await renderNotices('aarch64-apple-darwin', modules, packages);
    assert.match(notices, /- 2 Go runtime\/modules linked into Nootify/);
    assert.match(notices, /- 4 additional browser dependency packages/);
    assert.match(notices, /npm package: see-file 1\.0\.0\nLicense: SEE LICENSE IN terms\/EULA\.txt\n.*\n\n--- terms\/EULA\.txt ---\n\nEULA text of see-file\n/);
    assert.ok(notices.indexOf('Go module: declared 1.0.0') < notices.indexOf('Go module: dual 1.0.0'));
    assert.ok(notices.indexOf('Go module: dual 1.0.0') < notices.indexOf('npm package: @scope/no-file 3.0.0'));
    assert.match(notices, /Go module: dual 1\.0\.0\nLicense: MIT OR Apache-2\.0\nSource: https:\/\/example\.com\/dual\/1\.0\.0\n\n--- LICENSE-APACHE ---\n\nApache text of dual\n\n--- LICENSE-MIT ---\n\nMIT text of dual\n/);
    assert.match(notices, /License: not declared\n.*\n\n--- licenses\/LICENSE\.txt ---\n\nlicense-file text\n/);
    assert.match(notices, /npm package: with-file 2\.0\.0\nLicense: MIT\nSource: https:\/\/www\.npmjs\.com\/package\/with-file\/v\/2\.0\.0\n\n--- LICENSE ---\n\nCopyright \(c\) 2026 With File\n/);
    assert.match(notices, /npm package: nested 0\.1\.0\nLicense: ISC\n[^=]*ISC text of nested/);
    const spdxMit = await readFile(new URL('./spdx-licenses/MIT.txt', import.meta.url), 'utf8');
    assert.ok(notices.includes([
      'npm package: @scope/no-file 3.0.0', 'License: MIT', 'Source: https://www.npmjs.com/package/@scope/no-file/v/3.0.0', 'Author: Jane <jane@example.com>',
      `No license file comes with this package; its declared license follows, from the SPDX License List ${SPDX_LICENSE_LIST}.`,
      '', `--- MIT (SPDX License List ${SPDX_LICENSE_LIST}) ---`, '', spdxMit.replace(/\r\n?/g, '\n').trimEnd(),
    ].join('\n')));
    assert.ok(!notices.includes('\r') && !notices.includes(dir) && !notices.includes('not a license') && notices.endsWith('\n'));
    assert.equal(await renderNotices('aarch64-apple-darwin', [...modules].reverse(), [...packages].reverse()), notices);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('components without a license file or a known declared license fail staging', async () => {
  const dir = await fixture({ 'modules/a/go.mod': '', 'modules/b/go.mod': '', 'modules/c/go.mod': '', 'modules/d/go.mod': '' });
  try {
    const only = component => renderNotices('aarch64-apple-darwin', [component], []);
    await assert.rejects(only(module(join(dir, 'modules'), 'a', { license: 'MIT OR Unlisted-1.0' })), /add text\/Unlisted-1\.0\.txt of SPDX License List .* as scripts\/spdx-licenses\/Unlisted-1\.0\.txt/);
    await assert.rejects(only(module(join(dir, 'modules'), 'b', { license: undefined })), /Go module b 1\.0\.0 includes no license file and declares no license/);
    await assert.rejects(only(module(join(dir, 'modules'), 'c', { license: 'Custom: see https://example.com' })), /not an SPDX expression/);
    await assert.rejects(only(module(join(dir, 'modules'), 'd', { licenseFile: '../a/go.mod' })), /license file \.\.\/a\/go\.mod outside its directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
