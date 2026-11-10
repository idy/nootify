// NSIS is the only downloaded build tool. Verify the pinned archive on every
// use and extract into a fresh directory before executing any compiler/plugin.
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { sha256 } from './bundle-utils.mjs';

const run = promisify(execFile);
export const NSIS_VERSION = '3.13';
export const NSIS_SHA256 = 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8';
// This mirror redistributes the exact NSIS archive: its published asset digest
// matches the pin above. It adds no Tauri application or build dependency.
export const NSIS_URL = `https://github.com/tauri-apps/binary-releases/releases/download/nsis-${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip`;
export const NSIS_URLS = Object.freeze([NSIS_URL,
  `https://downloads.sourceforge.net/project/nsis/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip`]);

export async function verifyNsisArchive(archive, checksum = NSIS_SHA256) {
  if (await sha256(archive) !== checksum) throw new Error('NSIS archive SHA-256 mismatch; refusing extraction or execution');
}

/** Both the real packager and installer smoke use this pinned downloader. */
export async function downloadNsisArchive(archive, { urls = NSIS_URLS, fetchArchive = globalThis.fetch, checksum = NSIS_SHA256 } = {}) {
  await mkdir(dirname(archive), { recursive: true });
  try { await verifyNsisArchive(archive, checksum); return archive; }
  catch (error) {
    if (error.code !== 'ENOENT' && !error.message.includes('SHA-256 mismatch')) throw error;
    await rm(archive, { force: true });
  }
  const failures = [];
  for (const url of urls) {
    const partial = `${archive}.partial`;
    try {
      const response = await fetchArchive(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      await verifyNsisArchive(partial, checksum);
      await rename(partial, archive);
      return archive;
    } catch (error) { failures.push(error.message); }
    finally { await rm(partial, { force: true }); }
  }
  throw new Error(`NSIS download failed from all pinned sources: ${failures.join('; ')}`);
}

export async function withNsisCompiler(root, callback) {
  if (process.platform !== 'win32') throw new Error('NSIS packaging requires Windows');
  const cache = join(root, '.cache', 'nsis', NSIS_VERSION);
  const archive = join(cache, `nsis-${NSIS_VERSION}.zip`);
  await downloadNsisArchive(archive);
  await verifyNsisArchive(archive);
  const work = await mkdtemp(join(tmpdir(), 'nootify-nsis-'));
  try {
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    await run(tar, ['-xf', archive, '-C', work], { cwd: root });
    const compilers = [];
    async function find(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await find(path);
        else if (entry.name === 'makensis.exe') {
          const required = ['Include/LogicLib.nsh', 'Plugins/x86-unicode/System.dll', 'Plugins/x86-unicode/nsExec.dll'];
          if ((await Promise.all(required.map(file => stat(join(directory, file)).then(info => info.isFile()).catch(() => false)))).every(Boolean)) compilers.push(path);
        }
      }
    }
    await find(work);
    if (compilers.length !== 1) throw new Error(`Expected one pinned NSIS root compiler, found ${compilers.length}`);
    return await callback(compilers[0]);
  } finally { await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, archive, ...extra] = process.argv.slice(2);
  if (command !== '--download' || !archive || extra.length) {
    console.error('Use nsis.mjs --download <archive>'); process.exitCode = 1;
  } else {
    try { await downloadNsisArchive(resolve(archive)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
