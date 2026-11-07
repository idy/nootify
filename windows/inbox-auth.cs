using System;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Nootify {
    public static class InboxWriter {
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, uint length, out uint needed);

        // Also tested without opening a foreign account's process. A reused PID alone is never identity.
        public static void AssertPeer(uint expectedPid, uint serverPid, string currentSid, string serverSid) {
            if (expectedPid == 0 || serverPid == 0 || expectedPid != serverPid || String.IsNullOrEmpty(currentSid) ||
                String.IsNullOrEmpty(serverSid) || !String.Equals(currentSid, serverSid, StringComparison.Ordinal)) {
                throw new UnauthorizedAccessException("Inbox peer identity could not be verified");
            }
        }
        static uint ServerPid(NamedPipeClientStream pipe) {
            uint pid;
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid) || pid == 0) throw new UnauthorizedAccessException();
            return pid;
        }
        static string ProcessSid(IntPtr process) {
            IntPtr token;
            if (!OpenProcessToken(process, 0x0008, out token)) throw new UnauthorizedAccessException(); // TOKEN_QUERY
            try {
                uint size;
                GetTokenInformation(token, 1, IntPtr.Zero, 0, out size); // TokenUser
                if (Marshal.GetLastWin32Error() != 122 || size < IntPtr.Size || size > 65536) throw new UnauthorizedAccessException();
                IntPtr info = Marshal.AllocHGlobal((int)size);
                try {
                    if (!GetTokenInformation(token, 1, info, size, out size)) throw new UnauthorizedAccessException();
                    return new SecurityIdentifier(Marshal.ReadIntPtr(info)).Value;
                } finally { Marshal.FreeHGlobal(info); }
            } finally { CloseHandle(token); }
        }
        static int Remaining(Stopwatch clock, int timeout) {
            long remaining = timeout - clock.ElapsedMilliseconds;
            if (remaining <= 0) throw new TimeoutException();
            return (int)remaining;
        }
        public static void Write(string path, uint expectedPid, string frames, int timeout) {
            if (path == null || !Regex.IsMatch(path, @"\A\\\\[.?]\\pipe\\[^\\/\x00-\x1f]+\z", RegexOptions.IgnoreCase) ||
                expectedPid == 0 || frames == null || timeout < 1 || timeout > 60000) throw new ArgumentException();
            var clock = Stopwatch.StartNew();
            // Explicit Identification maps to SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION at CreateFile.
            // Even a hostile server cannot impersonate this client to access the client's resources.
            using (var pipe = new NamedPipeClientStream(".", path.Substring(9), PipeDirection.InOut,
                PipeOptions.Asynchronous, TokenImpersonationLevel.Identification)) {
                pipe.Connect(Remaining(clock, timeout));
                uint pid = ServerPid(pipe);
                // Check the PID before opening any process. Pin the process object through the complete write,
                // so process exit/PID reuse cannot replace the token-bearing object we just authenticated.
                if (pid != expectedPid) throw new UnauthorizedAccessException();
                IntPtr process = OpenProcess(0x00101000, false, pid); // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
                if (process == IntPtr.Zero) throw new UnauthorizedAccessException();
                try {
                    if (WaitForSingleObject(process, 0) != 258) throw new UnauthorizedAccessException(); // WAIT_TIMEOUT: still live
                    using (var current = WindowsIdentity.GetCurrent()) {
                        AssertPeer(expectedPid, pid, current.User == null ? null : current.User.Value, ProcessSid(process));
                    }
                    if (WaitForSingleObject(process, 0) != 258 || ServerPid(pipe) != pid) throw new UnauthorizedAccessException();
                    // No auth or message bytes precede ALL checks. Never close/reconnect between query and write.
                    byte[] bytes = new UTF8Encoding(false, true).GetBytes(frames);
                    if (!pipe.WriteAsync(bytes, 0, bytes.Length).Wait(Remaining(clock, timeout))) throw new TimeoutException();
                    if (!pipe.FlushAsync().Wait(Remaining(clock, timeout))) throw new TimeoutException();
                } finally { CloseHandle(process); }
            }
            // A completed local write is best effort, not a client/model receipt or a policy override.
        }
    }
}
