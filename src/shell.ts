export type CommandShell = 'posix' | 'powershell';

/** Select Git Bash for native Windows Claude, preserving other clients' PowerShell default. */
export function shellForClient(client: string, platform: NodeJS.Platform = process.platform): CommandShell {
  return platform === 'win32' && !['claude', 'claude-code', 'claude-desktop'].includes(client) ? 'powershell' : 'posix';
}

/** Quote for the receiving shell, which may differ from the service host's platform. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform, compact = false,
  shell: CommandShell = platform === 'win32' ? 'powershell' : 'posix'): string {
  if (compact && shell === 'posix' && /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${shell === 'powershell' ? value.replace(/['‘-‛]/g, '$&$&') : value.replace(/'/g, `'"'"'`)}'`;
}

export function shellCommand(args: string[], platform: NodeJS.Platform = process.platform, compact = false,
  shell: CommandShell = platform === 'win32' ? 'powershell' : 'posix'): string {
  const windowsBash = platform === 'win32' && shell === 'posix';
  const values = args.map((value, index) => {
    // Git Bash accepts drive/UNC paths with forward slashes for its executable lookup.
    const executable = windowsBash && index === 0
      ? value.replace(/^\\\\\?\\UNC\\/i, '//').replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '').replace(/\\/g, '/') : value;
    return shellQuote(executable, platform, compact, shell);
  });
  // All generated file arguments already use native Windows paths. Preserve message text
  // beginning with '/' too, instead of letting MSYS rewrite it as a filesystem path.
  const prefix = shell === 'powershell' ? '& ' : windowsBash ? "MSYS2_ARG_CONV_EXCL='*' " : '';
  return prefix + values.join(' ');
}
