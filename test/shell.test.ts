import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { shellCommand, shellQuote } from '../src/shell.js';
import { windowsPowerShell } from '../src/service.js';

const paths = ["C:\\Users\\O'Brien\\Nootify\\node.exe", ...Array.from({ length: 4 }, (_, index) =>
  `C:\\Users\\O${String.fromCodePoint(0x2018 + index)}Brien\\Nootify\\node.exe`),
  "C:\\O‘’‚‛'Brien\\with spaces\\$literal; (value)\\node.exe"];

test('Windows argument quoting doubles every PowerShell single-quote delimiter', () => {
  for (const value of paths) {
    const quoted = shellQuote(value, 'win32');
    assert.equal(quoted, `'${value.replace(/['\u2018-\u201b]/g, character => character + character)}'`);
    assert.ok(shellCommand([value, 'argument'], 'win32').startsWith(`& ${quoted} `));
    assert.equal(shellQuote(value, 'linux'), `'${value.replace(/'/g, `'"'"'`)}'`, 'POSIX shells keep typographic quotes literal');
  }
});

test('Windows PowerShell preserves apostrophes and literal shell syntax in native argument round trips', { skip: process.platform !== 'win32' }, async () => {
  const command = shellCommand([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...paths], 'win32');
  const program = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ' + command;
  const { stdout } = await promisify(execFile)(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(program, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30_000 });
  assert.deepEqual(JSON.parse(stdout), paths);
});
