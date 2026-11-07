import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** Metadata can retain paths from another OS; drive-relative Windows paths are never repository roots. */
export const isAbsolutePath = (value: string): boolean => posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);

/** Electron stores Claude Desktop's per-user sessions in Roaming AppData on Windows. */
export function desktopSessionRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  const path = platform === 'win32' ? win32 : posix;
  const base = platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['Claude-3p', 'Claude'].map(app => path.join(base, app, 'claude-code-sessions'));
}

export function serviceStateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  return platform === 'win32' ? win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'Nootify', 'state') : posix.join(home, '.local/state/nootify');
}
