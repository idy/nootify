import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { cratesFromMetadata, npmPackages, renderNotices, SPDX_LICENSE_LIST, spdxIds } from './third-party-notices.mjs';

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'nootify-notices-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

function crate(dir, name, fields = {}) {
  return { kind: 'Rust crate', name, version: '1.0.0', license: 'MIT', authors: [], dir: join(dir, name), source: `https://crates.io/crates/${name}/1.0.0`, ...fields };
}

test('SPDX expressions and legacy slash lists name each license and exception once', () => {
  assert.deepEqual(spdxIds('MIT'), ['MIT']);
  assert.deepEqual(spdxIds('(MIT OR Apache-2.0) AND Unicode-3.0'), ['MIT', 'Apache-2.0', 'Unicode-3.0']);
  assert.deepEqual(spdxIds('MIT/Apache-2.0'), ['MIT', 'Apache-2.0']);
  assert.deepEqual(spdxIds('Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT'), ['Apache-2.0', 'LLVM-exception', 'MIT']);
});

test('crates come from normal and build dependencies of the app, not dev-dependencies or local paths', () => {
  const pkg = (id, source = CRATES_IO) => ({ id, name: id, version: '1.0.0', license: 'MIT', license_file: null, authors: [], source, manifest_path: `/registry/${id}/Cargo.toml` });
  const dep = (id, ...kinds) => ({ pkg: id, dep_kinds: kinds.map(kind => ({ kind, target: null })) });
  const metadata = {
    packages: [pkg('app', null), pkg('normal'), pkg('build'), pkg('dev'), pkg('dev-only-child'), pkg('local', null), pkg('git', 'git+https://example.com/git?rev=1#abc'), pkg('both')],
    resolve: {
      root: 'app',
      nodes: [
        { id: 'app', deps: [dep('normal', null), dep('build', 'build'), dep('dev', 'dev'), dep('local', null), dep('both', 'dev', 'build')] },
        { id: 'normal', deps: [dep('git', null)] },
        { id: 'build', deps: [] }, { id: 'dev', deps: [dep('dev-only-child', null)] }, { id: 'dev-only-child', deps: [] },
        { id: 'local', deps: [] }, { id: 'git', deps: [] }, { id: 'both', deps: [] },
      ],
    },
  };
  const crates = cratesFromMetadata(metadata);
  assert.deepEqual(crates.map(({ name }) => name).sort(), ['both', 'build', 'git', 'normal']);
  assert.equal(crates.find(({ name }) => name === 'normal').source, 'https://crates.io/crates/normal/1.0.0');
  assert.equal(crates.find(({ name }) => name === 'git').source, 'git+https://example.com/git?rev=1#abc');
  assert.equal(crates.find(({ name }) => name === 'normal').dir, '/registry/normal');
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
    'crates/dual/LICENSE-APACHE': 'Apache text of dual',
    'crates/dual/LICENSE-MIT': 'MIT text of dual',
    'crates/dual/README.md': 'not a license',
    'crates/declared/licenses/LICENSE.txt': 'license-file text',
  });
  try {
    const crates = [crate(join(dir, 'crates'), 'dual', { license: 'MIT OR Apache-2.0' }), crate(join(dir, 'crates'), 'declared', { license: undefined, licenseFile: 'licenses/LICENSE.txt' })];
    const packages = await npmPackages(join(dir, 'node_modules'));
    assert.deepEqual(packages.map(({ name }) => name).sort(), ['@scope/no-file', 'nested', 'see-file', 'with-file']);
    const notices = await renderNotices('aarch64-apple-darwin', crates, packages);
    assert.match(notices, /- 2 Rust crates that Cargo builds for the desktop app \(aarch64-apple-darwin\)/);
    assert.match(notices, /- 4 npm packages in service\/node_modules/);
    assert.match(notices, /npm package: see-file 1\.0\.0\nLicense: SEE LICENSE IN terms\/EULA\.txt\n.*\n\n--- terms\/EULA\.txt ---\n\nEULA text of see-file\n/);
    assert.ok(notices.indexOf('Rust crate: declared 1.0.0') < notices.indexOf('Rust crate: dual 1.0.0'));
    assert.ok(notices.indexOf('Rust crate: dual 1.0.0') < notices.indexOf('npm package: @scope/no-file 3.0.0'));
    assert.match(notices, /Rust crate: dual 1\.0\.0\nLicense: MIT OR Apache-2\.0\nSource: https:\/\/crates\.io\/crates\/dual\/1\.0\.0\n\n--- LICENSE-APACHE ---\n\nApache text of dual\n\n--- LICENSE-MIT ---\n\nMIT text of dual\n/);
    assert.match(notices, /License: not declared\n.*\n\n--- licenses\/LICENSE\.txt ---\n\nlicense-file text\n/);
    assert.match(notices, /npm package: with-file 2\.0\.0\nLicense: MIT\nSource: https:\/\/www\.npmjs\.com\/package\/with-file\/v\/2\.0\.0\n\n--- LICENSE ---\n\nCopyright \(c\) 2026 With File\n/);
    assert.match(notices, /npm package: nested 0\.1\.0\nLicense: ISC\n[^=]*ISC text of nested/);
    const spdxMit = await readFile(new URL('./spdx-licenses/MIT.txt', import.meta.url), 'utf8');
    assert.ok(notices.includes([
      'npm package: @scope/no-file 3.0.0', 'License: MIT', 'Source: https://www.npmjs.com/package/@scope/no-file/v/3.0.0', 'Author: Jane <jane@example.com>',
      `No license file comes with this package; its declared license follows, from the SPDX License List ${SPDX_LICENSE_LIST}.`,
      '', `--- MIT (SPDX License List ${SPDX_LICENSE_LIST}) ---`, '', spdxMit.trimEnd(),
    ].join('\n')));
    assert.ok(!notices.includes('\r') && !notices.includes(dir) && !notices.includes('not a license') && notices.endsWith('\n'));
    assert.equal(await renderNotices('aarch64-apple-darwin', [...crates].reverse(), [...packages].reverse()), notices);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('components without a license file or a known declared license fail staging', async () => {
  const dir = await fixture({ 'crates/a/Cargo.toml': '', 'crates/b/Cargo.toml': '', 'crates/c/Cargo.toml': '', 'crates/d/Cargo.toml': '' });
  try {
    const only = component => renderNotices('aarch64-apple-darwin', [component], []);
    await assert.rejects(only(crate(join(dir, 'crates'), 'a', { license: 'MIT OR Unlisted-1.0' })), /add text\/Unlisted-1\.0\.txt of SPDX License List .* as scripts\/spdx-licenses\/Unlisted-1\.0\.txt/);
    await assert.rejects(only(crate(join(dir, 'crates'), 'b', { license: undefined })), /Rust crate b 1\.0\.0 includes no license file and declares no license/);
    await assert.rejects(only(crate(join(dir, 'crates'), 'c', { license: 'Custom: see https://example.com' })), /not an SPDX expression/);
    await assert.rejects(only(crate(join(dir, 'crates'), 'd', { licenseFile: '../a/Cargo.toml' })), /license file \.\.\/a\/Cargo\.toml outside its directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
