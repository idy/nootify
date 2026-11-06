import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNamedPipe } from './inbox.js';
import { windowsPowerShell } from './service.js';
import { RetryableDeliveryError, UnconfirmedDeliveryError, type DeliveryResult } from './types.js';

interface InboxWrite { path: string; expectedPid?: number; frames: string; timeout: number }
interface NativeRuntime { command?: { file: string; args: string[] }; startupTimeout?: number }

/** Neither PowerShell profiles/modules nor ambient accounts may configure the private writer. */
export function inboxEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'TEMP', 'TMP']);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key.toUpperCase()) && value));
}
export const windowsInboxScript = () => fileURLToPath(new URL('../../windows/inbox-auth.ps1', import.meta.url));
export function windowsInboxCommand(): { file: string; args: string[] } {
  return { file: windowsPowerShell(), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsInboxScript()] };
}

/** The native child owns ONE connection through peer verification and write; Node must not reconnect. */
export async function writeWindowsInbox(request: InboxWrite, runtime: NativeRuntime = {}): Promise<DeliveryResult> {
  if (!isNamedPipe(request.path)) throw new RetryableDeliveryError('The configured inbox path must be a local Windows named pipe');
  if (!Number.isInteger(request.expectedPid) || request.expectedPid! <= 0 || request.expectedPid! > 0xffffffff) {
    throw new RetryableDeliveryError('Inbox peer authentication requires a live runtime PID');
  }
  if (!Number.isInteger(request.timeout) || request.timeout < 1 || request.timeout > 60_000) throw new RetryableDeliveryError('Invalid inbox write timeout');
  const command = runtime.command ?? windowsInboxCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: inboxEnvironment(process.env), cwd: dirname(windowsInboxScript()),
    });
    let ready = false; let dispatched = false; let written = false; let settled = false; let buffer = ''; let bytes = 0;
    const fail = (message = 'Windows inbox authentication or write failed') => {
      if (settled) return;
      // Startup failed before any request was sent: retry is safe. Once the native
      // writer has the request, its byte progress is unknown, so never resubmit blindly.
      const error = dispatched ? new UnconfirmedDeliveryError(message) : new RetryableDeliveryError(message);
      settled = true; clearTimeout(timer); child.stdin.destroy(); child.kill(); reject(error);
    };
    let timer = setTimeout(() => fail('Inbox helper startup timed out'), runtime.startupTimeout ?? 15_000).unref();
    child.stderr.resume(); // Raw native errors must never expose payloads, paths, PIDs or token details.
    child.stdin.on('error', () => fail());
    child.on('error', () => fail());
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk); if (bytes > 4096) { fail(); return; }
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line) as { ready?: unknown; status?: unknown };
          if (!ready && reply?.ready === true) {
            ready = true; clearTimeout(timer);
            // Startup/compilation and the whole connect/verify/write exchange each have a deadline.
            timer = setTimeout(() => fail('Inbox socket write timed out'), request.timeout + 1000).unref();
            dispatched = true;
            child.stdin.end(JSON.stringify(request) + '\n');
          } else if (ready && !written && reply?.status === 'socket_written') written = true;
          else { fail(); return; }
        } catch { fail(); return; }
      }
    });
    child.once('close', code => {
      if (settled) return;
      if (code !== 0 || !ready || !written || buffer.trim()) { fail(); return; }
      settled = true; clearTimeout(timer); resolve({ status: 'socket_written' });
    });
  });
}
