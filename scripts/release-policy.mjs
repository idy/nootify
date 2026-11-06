// Stable release publication is serialized by the workflow; read latest immediately
// before editing the release, so out-of-order tag builds cannot move latest backwards.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function stableVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) throw new Error(`Cannot determine stable release precedence for ${value}`);
  return match.slice(1, 4).map(BigInt);
}

export function shouldPromoteRelease(version, latestTag) {
  const candidate = stableVersion(version);
  if (latestTag === undefined) return true;
  const current = stableVersion(latestTag);
  for (let index = 0; index < 3; index++) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  // Rebuilding the current latest must retain its designation. Equal-precedence
  // build metadata on a different tag must not replace the explicitly selected tag.
  return latestTag === `v${version}`;
}

export async function latestReleaseFlag({ version, repository, token, request = fetch }) {
  stableVersion(version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  if (!token) throw new Error('GH_TOKEN is required to read the current latest release');
  const response = await request(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return shouldPromoteRelease(version);
  if (!response.ok) throw new Error(`Cannot read latest release: HTTP ${response.status}`);
  const latest = await response.json();
  if (typeof latest?.tag_name !== 'string' || latest.draft || latest.prerelease) throw new Error('Invalid latest stable release response');
  return shouldPromoteRelease(version, latest.tag_name);
}

async function main() {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(await latestReleaseFlag({ version, repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`release-policy: ${error.message}`); process.exitCode = 1; });
}
