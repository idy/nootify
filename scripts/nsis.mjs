// NSIS is the only downloaded build tool. Verify the pinned archive on every
// use and extract into a fresh directory before executing any compiler/plugin.
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { sha256 } from './bundle-utils.mjs';

const run = promisify(execFile);
export const NSIS_VERSION = '3.13';
export const NSIS_SHA256 = 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8';
export const NSIS_URL = `https://downloads.sourceforge.net/project/nsis/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip`;

export async function verifyNsisArchive(archive) {
  if (await sha256(archive) !== NSIS_SHA256) throw new Error('NSIS archive SHA-256 mismatch; refusing extraction or execution');
}

export async function withNsisCompiler(root, callback) {
  if (process.platform !== 'win32') throw new Error('NSIS packaging requires Windows');
  const cache = join(root, '.cache', 'nsis', NSIS_VERSION);
  const archive = join(cache, `nsis-${NSIS_VERSION}.zip`);
  await mkdir(cache, { recursive: true });
  try { await stat(archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(NSIS_URL, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`NSIS download failed: HTTP ${response.status}`);
    const partial = `${archive}.partial`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      await verifyNsisArchive(partial);
      await rename(partial, archive);
    } finally { await rm(partial, { force: true }); }
  }
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
