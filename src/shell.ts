/** Generated commands use PowerShell on Windows and a POSIX shell elsewhere. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform, compact = false): string {
  if (compact && platform !== 'win32' && /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${platform === 'win32' ? value.replace(/['‘-‛]/g, '$&$&') : value.replace(/'/g, `'"'"'`)}'`;
}
export function shellCommand(args: string[], platform: NodeJS.Platform = process.platform, compact = false): string {
  return (platform === 'win32' ? '& ' : '') + args.map(value => shellQuote(value, platform, compact)).join(' ');
}
