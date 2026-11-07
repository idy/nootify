import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export const inboxPath = (directory: string, name = 'inbox'): string => process.platform === 'win32'
  ? `\\\\.\\pipe\\nootify-test-${name}-${randomUUID()}` : join(directory, `${name}.sock`);

/** POSIX mode bits do not express Windows ACLs; native service tests validate the Windows DACL. */
export async function assertMode(path: string, mode: number, message?: string): Promise<void> {
  const info = await stat(path);
  if (process.platform === 'win32') assert.equal(Boolean(info.mode & 0o200), Boolean(mode & 0o200), message ?? 'Expected the file write attribute');
  else assert.equal(info.mode & 0o777, mode, message);
}
