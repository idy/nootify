// License texts of the Go modules actually linked into the desktop/core/tsnet
// and the production npm packages in service/node_modules. License-less npm
// packages fall back to their declared SPDX license in scripts/spdx-licenses/.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { buildTarget } from './build-targets.mjs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const spdxDir = join(root, 'scripts', 'spdx-licenses');
// scripts/spdx-licenses/<id>.txt are copies of text/<id>.txt in this release of
// https://github.com/spdx/license-list-data.
export const SPDX_LICENSE_LIST = '3.29.0';
const LICENSE_FILE = /^(?:LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|PATENTS|UNLICENSE)(?:[._-].*)?$/i;
const collator = new Intl.Collator('en', { numeric: true });

export async function thirdPartyNotices(triple, modules) {
  return renderNotices(triple, await goModules(buildTarget(triple)), await npmPackages(modules));
}

/** go list -deps selects only linked packages for this platform, excluding tests
 * and unused requirements. Deduplicate shared modules and selected runtimes. */
export async function goModules(target, execute = run) {
  const env = { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' };
  const builds = await Promise.all([
    ['desktop', 'Nootify'], ['native/core', 'nootify-core'], ['native/tailscale', 'nootify-tsnet'],
    ...(target.goos === 'windows' ? [['desktop/cmd/installer-stage', 'nootify-installer-stage']] : []),
  ].map(async ([directory, executable]) => {
    const options = { cwd: join(root, directory), env, maxBuffer: 16 << 20 };
    // GOTOOLCHAIN=auto consults this module's go.mod, so a root-level go env
    // can describe a different runtime from the one linked into this binary.
    const [listed, toolchain] = await Promise.all([
      execute('go', ['list', '-deps', '-mod=readonly', '-f', '{{with .Module}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}', '.'], options),
      execute('go', ['env', '-json', 'GOROOT', 'GOVERSION'], options),
    ]);
    const { GOROOT, GOVERSION } = JSON.parse(toolchain.stdout);
    if (typeof GOROOT !== 'string' || !isAbsolute(GOROOT) || typeof GOVERSION !== 'string' || !GOVERSION) {
      throw new Error(`Could not identify the Go runtime used for ${executable}`);
    }
    return { list: listed.stdout, executable, runtime: { kind: 'Go runtime', name: 'Go standard library', version: GOVERSION, authors: [], dir: GOROOT, source: 'https://go.dev/' } };
  }));
  const runtimes = new Map();
  for (const { runtime, executable } of builds) {
    const key = `${runtime.version}\0${runtime.dir}`;
    if (!runtimes.has(key)) runtimes.set(key, { ...runtime, executables: [] });
    runtimes.get(key).executables.push(executable);
  }
  return [...runtimes.values(), ...modulesFromGoList(builds.map(build => build.list).join('\n'))];
}

export function modulesFromGoList(output) {
  const modules = new Map();
  for (const line of output.split(/\r?\n/)) {
    const [name, version, dir] = line.split('\t');
    if (!version || !dir) continue; // The local main modules are Nootify's own source.
    modules.set(`${name}@${version}`, { kind: 'Go module', name, version, dir, authors: [], source: `https://${name}` });
  }
  return [...modules.values()];
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

export async function renderNotices(target, modules, packages) {
  const sections = [];
  for (const component of [...sorted(modules), ...sorted(packages)]) {
    const { included, texts } = await licenseTexts(component);
    const lines = [
      '='.repeat(80),
      `${component.kind}: ${component.name} ${component.version}`,
      `License: ${component.license ?? 'not declared'}`,
      `Source: ${component.source}`,
      ...(component.executables ? [`Built into: ${component.executables.join(', ')}`] : []),
    ];
    if (!included) {
      if (component.authors.length) lines.push(`${component.authors.length === 1 ? 'Author' : 'Authors'}: ${component.authors.join(', ')}`);
      lines.push(`No license file comes with this ${component.kind === 'npm package' ? 'package' : 'module'}; its declared license follows, from the SPDX License List ${SPDX_LICENSE_LIST}.`);
    }
    for (const { title, text } of texts) lines.push('', `--- ${title} ---`, '', clean(text));
    sections.push(`${lines.join('\n')}\n`);
  }
  return [header(target, modules.length, packages.length), ...sections].join('\n');
}

function header(target, modules, packages) {
  return `Nootify third-party notices

Nootify is available under the MIT License. The desktop app includes the
third-party software listed below, each under its own license:

- ${modules} Go runtime/modules linked into the desktop app, notification core
  and embedded Tailscale client (${target})
- ${packages} npm packages in service/node_modules

Each entry reproduces the license files that come with the module or package.
For one that comes without any, the entry reproduces its declared license
from the SPDX License List ${SPDX_LICENSE_LIST}.

The Node.js runtime's license is in node-LICENSE. Additional attribution for
sidecars is in core-licenses/ and tailscale-licenses/, next to this file.
`;
}

/** Included module/package licenses, else SPDX texts of the declared license. */
async function licenseTexts(component) {
  const label = `${component.kind} ${component.name} ${component.version}`;
  const names = new Set((await readdir(component.dir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && LICENSE_FILE.test(entry.name)).map(entry => entry.name));
  // npm's "SEE LICENSE IN <file>" can name a nested file in the package.
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
