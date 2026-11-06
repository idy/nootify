import { stat } from 'node:fs/promises';

/** Local named pipes only: a remote UNC pipe would send session contents to another machine. */
export const isNamedPipe = (path: string): boolean => /^\\\\[.?]\\pipe\\[^\\/\x00-\x1f]+$/i.test(path);
export async function checkSocket(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') {
    if (!isNamedPipe(path)) throw new Error('The configured inbox path must be a local Windows named pipe');
    // Named pipes have no filesystem stat/uid. The kernel enforces their ACL at connect time;
    // discovery also requires the matching live process record in this user's session registry.
    return;
  }
  const info = await stat(path);
  if (!info.isSocket()) throw new Error('The configured inbox path is not a socket');
  if (process.getuid && info.uid !== process.getuid()) throw new Error('The inbox belongs to another OS user');
}
