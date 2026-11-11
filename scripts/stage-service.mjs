// Stage notices only. The browser UI, notification core and LAN service
// are linked into the single Nootify executable.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildTarget } from './build-targets.mjs';
import { thirdPartyNotices } from './third-party-notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function stageServiceBundle({ target = buildTarget() } = {}) {
  const resources = join(root, 'build/resources');
  // Clear old staging roots so a prior Node bundle can never contaminate a build.
  await rm(join(resources, 'service'), { recursive: true, force: true });
  await rm(join(root, 'build/binaries'), { recursive: true, force: true });
  const licenses = join(resources, 'licenses');
  await rm(licenses, { recursive: true, force: true });
  await mkdir(licenses, { recursive: true });
  await writeFile(join(licenses, 'third-party-notices.txt'), await thirdPartyNotices(target.triple));
  for (const name of ['Montserrat-OFL.txt', 'Monda-OFL.txt', 'Lato-OFL.txt']) {
    await writeFile(join(licenses, name), await readFile(join(root, 'desktop/fonts', name)));
  }
  console.log(`stage-service: single executable notices staged in ${licenses}`);
  return licenses;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  stageServiceBundle().catch(error => { console.error(`stage-service: ${error.message}`); process.exitCode = 1; });
}
