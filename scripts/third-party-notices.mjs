// Builds service/third-party-notices.txt: the license texts of the Rust crates Cargo builds for the
// desktop app and of the production npm packages in service/node_modules. A crate or package that
// includes no license file gets the SPDX License List text of its declared license from
// scripts/spdx-licenses/. The Node.js runtime and Tailscale sidecar licenses are staged separately.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const spdxDir = join(root, 'scripts', 'spdx-licenses');
// scripts/spdx-licenses/<id>.txt are copies of text/<id>.txt in this release of
// https://github.com/spdx/license-list-data.
export const SPDX_LICENSE_LIST = '3.29.0';
const LICENSE_FILE = /^(?:LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|PATENTS|UNLICENSE)(?:[._-].*)?$/i;
const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
const collator = new Intl.Collator('en', { numeric: true });

export async function thirdPartyNotices(target, modules) {
  return renderNotices(target, cratesFromMetadata(await cargoMetadata(target)), await npmPackages(modules));
}

async function cargoMetadata(target) {
  // Like scripts/desktop.mjs, also find a rustup install whose bin directory is not on PATH.
  const cargoBin = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin');
  const args = ['metadata', '--format-version=1', '--locked', '--all-features', `--filter-platform=${target}`];
  try {
    const { stdout } = await run('cargo', args, {
      cwd: join(root, 'src-tauri'), maxBuffer: 64 << 20, env: { ...process.env, PATH: `${cargoBin}${delimiter}${process.env.PATH ?? ''}` },
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`cargo metadata failed while listing the app's Rust crates for third-party-notices.txt: ${error.stderr?.trim() || error.message}`);
  }
}

/** Registry and git crates reachable from the app crate through normal and build dependencies;
 * dev-dependencies are never built for the app. */
export function cratesFromMetadata({ packages, resolve }) {
  if (!resolve?.root) throw new Error('cargo metadata reported no root package for src-tauri/Cargo.toml');
  const byId = new Map(packages.map(pkg => [pkg.id, pkg]));
  const deps = new Map(resolve.nodes.map(node => [node.id, node.deps]));
  const seen = new Set([resolve.root]);
  for (const queue = [resolve.root]; queue.length;) {
    for (const dep of deps.get(queue.pop())) {
      if (seen.has(dep.pkg) || dep.dep_kinds.every(({ kind }) => kind === 'dev')) continue;
      seen.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  return [...seen].map(id => byId.get(id)).filter(pkg => pkg.source).map(pkg => ({
    kind: 'Rust crate', name: pkg.name, version: pkg.version, license: pkg.license ?? undefined,
    licenseFile: pkg.license_file ?? undefined, authors: pkg.authors ?? [], dir: dirname(pkg.manifest_path),
    source: pkg.source === CRATES_IO ? `https://crates.io/crates/${pkg.name}/${pkg.version}` : pkg.source,
  }));
}

/** Every package in a node_modules tree, including scoped and nested ones. */
export async function npmPackages(modules) {
  const found = new Map();
  const visit = async dir => {
    for (const entry of await directories(dir)) {
      if (entry.startsWith('.')) continue;
      const names = entry.startsWith('@') ? (await directories(join(dir, entry))).map(name => `${entry}/${name}`) : [entry];
      for (const name of names) {
        const packageDir = join(dir, ...name.split('/'));
        const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
        const license = npmLicense(pkg);
        found.set(`${pkg.name}@${pkg.version}`, {
          kind: 'npm package', name: pkg.name, version: pkg.version, license,
          licenseFile: /^SEE LICEN[CS]E IN (.+)$/i.exec(license ?? '')?.[1], authors: pkg.author ? [person(pkg.author)] : [], dir: packageDir,
          source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
        });
        await visit(join(packageDir, 'node_modules'));
      }
    }
  };
  await visit(modules);
  return [...found.values()];
}

export async function renderNotices(target, crates, packages) {
  const sections = [];
  for (const component of [...sorted(crates), ...sorted(packages)]) {
    const { included, texts } = await licenseTexts(component);
    const lines = [
      '='.repeat(80),
      `${component.kind}: ${component.name} ${component.version}`,
      `License: ${component.license ?? 'not declared'}`,
      `Source: ${component.source}`,
    ];
    if (!included) {
      if (component.authors.length) lines.push(`${component.authors.length === 1 ? 'Author' : 'Authors'}: ${component.authors.join(', ')}`);
      lines.push(`No license file comes with this ${component.kind === 'Rust crate' ? 'crate' : 'package'}; its declared license follows, from the SPDX License List ${SPDX_LICENSE_LIST}.`);
    }
    for (const { title, text } of texts) lines.push('', `--- ${title} ---`, '', clean(text));
    sections.push(`${lines.join('\n')}\n`);
  }
  return [header(target, crates.length, packages.length), ...sections].join('\n');
}

function header(target, crates, packages) {
  return `Nootify third-party notices

Nootify is available under the MIT License. The desktop app includes the
third-party software listed below, each under its own license:

- ${crates} Rust crates that Cargo builds for the desktop app (${target}),
  including build-time dependencies
- ${packages} npm packages in service/node_modules

Each entry reproduces the license files that come with the crate or package.
For one that comes without any, the entry reproduces its declared license
from the SPDX License List ${SPDX_LICENSE_LIST}.

The Node.js runtime's license is in node-LICENSE, and the licenses of the Go
modules in the embedded Tailscale client are in tailscale-licenses/, both next
to this file.
`;
}

/** The license files that come with a crate or package, else the SPDX texts of its declared license. */
async function licenseTexts(component) {
  const label = `${component.kind} ${component.name} ${component.version}`;
  const names = new Set((await readdir(component.dir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && LICENSE_FILE.test(entry.name)).map(entry => entry.name));
  // Cargo's license-file and npm's "SEE LICENSE IN <file>" can name any file in the crate or package.
  if (component.licenseFile) {
    const name = normalize(component.licenseFile);
    if (isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`)) throw new Error(`${label} names the license file ${component.licenseFile} outside its directory`);
    names.add(name);
  }
  if (names.size) {
    const texts = [];
    for (const name of [...names].sort()) texts.push({ title: name.split(sep).join('/'), text: await readFile(join(component.dir, name), 'utf8') });
    return { included: true, texts };
  }
  if (!component.license) throw new Error(`${label} includes no license file and declares no license`);
  const texts = [];
  for (const id of spdxIds(component.license)) {
    if (!/^[A-Za-z0-9.+-]+$/.test(id)) throw new Error(`${label} declares the license "${component.license}", which is not an SPDX expression`);
    try {
      texts.push({ title: `${id} (SPDX License List ${SPDX_LICENSE_LIST})`, text: await readFile(join(spdxDir, `${id}.txt`), 'utf8') });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`${label} includes no license file: add text/${id}.txt of SPDX License List ${SPDX_LICENSE_LIST} as scripts/spdx-licenses/${id}.txt`);
    }
  }
  return { included: false, texts };
}

/** License and exception identifiers in an SPDX expression or a legacy "MIT/Apache-2.0" list. */
export function spdxIds(expression) {
  return [...new Set(expression.split(/[\s()/]+/).filter(token => token && !/^(?:AND|OR|WITH)$/i.test(token)))];
}

function npmLicense(pkg) {
  // Old packages use a { type } object or a licenses array instead of an SPDX expression.
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(license => license.type ?? license).join(' OR ');
  return undefined;
}

function person(author) {
  if (typeof author === 'string') return author;
  return [author.name, author.email && `<${author.email}>`, author.url && `(${author.url})`].filter(Boolean).join(' ');
}

function sorted(components) {
  return [...components].sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.version, b.version));
}

function clean(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

async function directories(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
