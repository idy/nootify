// Node/npm are build tools only. This directory is the complete browser module
// allowlist; backend imports must never leak into the embedded asset tree.
import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
export const BROWSER_MODULES = Object.freeze(['ui-app.js', 'ui-i18n.js', 'ui-types.js', 'ui-transport.js', 'lark-profile.js', 'recipient-list.js', 'dropdown.js']);
export async function buildUI() {
  const work = await mkdtemp(join(tmpdir(), 'nootify-ui-'));
  try {
    await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', work], { cwd: root, maxBuffer: 16 << 20 });
    const files = await readdir(work);
    for (const file of files) if (!BROWSER_MODULES.includes(file)) throw new Error(`Browser build emitted unexpected module ${file}`);
    for (const file of BROWSER_MODULES) if (!files.includes(file)) throw new Error(`Browser build is missing ${file}`);
    await rename(join(work, 'ui-app.js'), join(work, 'app.js'));
    await copyFile(join(root, 'desktop/fonts.css'), join(work, 'fonts.css'));
    await cp(join(root, 'desktop/fonts'), join(work, 'fonts'), { recursive: true });
    const output = join(root, 'public/ui');
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    await cp(work, output, { recursive: true });
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildUI().catch(error => { console.error(`build-ui: ${error.message}`); process.exitCode = 1; });
}
