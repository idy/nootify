using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Nootify {
    // A nested job makes every node/helper descendant die if Task Scheduler ends PowerShell.
    // Create the process suspended so it cannot spawn a child before joining the job.
    public sealed class ServiceRunner : IDisposable {
        [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
            public int size; public string reserved, desktop, title;
            public int x, y, width, height, charsX, charsY, fill, flags;
            public short show, reservedSize; public IntPtr reservedData, input, output, error;
        }
        [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
        [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
            public long processTime, jobTime; public uint flags; public UIntPtr minimum, maximum;
            public uint active; public UIntPtr affinity; public uint priority, scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS { public BASIC_LIMITS basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
        [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
            public long user, kernel, periodUser, periodKernel; public uint faults, total, active, terminated;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref EXTENDED_LIMITS data, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int info, ref ACCOUNTING data, uint length, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
        IntPtr job, process, thread;
        public uint ProcessId { get; private set; }
        static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        static IntPtr LogFile(string path, bool input) {
            var attributes = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), inherit = 1 };
            IntPtr file = CreateFile(path, input ? 0x80000000u : 4u, 7, ref attributes, input ? 3u : 4u, 0x80, IntPtr.Zero);
            if (file == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return file;
        }
        // CommandLineToArgvW/CRT quoting; paths may contain whitespace, apostrophes and trailing slashes.
        public static string Quote(string value) {
            var result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1).Append(c); slashes = 0; continue; }
                result.Append('\\', slashes).Append(c); slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
        public ServiceRunner(string node, string[] args, string directory) {
            IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
            try {
                job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
                var limits = new EXTENDED_LIMITS(); limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMITS))));
                input = LogFile("NUL", true); output = LogFile(Path.Combine(directory, "stdout.log"), false); error = LogFile(Path.Combine(directory, "stderr.log"), false);
                var startup = new STARTUPINFO { size = Marshal.SizeOf(typeof(STARTUPINFO)), flags = 0x101, show = 0, input = input, output = output, error = error };
                var command = new StringBuilder(Quote(node)); foreach (string arg in args) command.Append(' ').Append(Quote(arg));
                PROCESS_INFORMATION child;
                Check(CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, directory, ref startup, out child)); // NO_WINDOW | SUSPENDED
                process = child.process; thread = child.thread; ProcessId = child.pid;
                Check(AssignProcessToJobObject(job, process));
            } catch {
                if (process != IntPtr.Zero) { TerminateProcess(process, 1); WaitForSingleObject(process, 10000); }
                Dispose(); throw;
            } finally {
                if (input != IntPtr.Zero) CloseHandle(input);
                if (output != IntPtr.Zero) CloseHandle(output);
                if (error != IntPtr.Zero) CloseHandle(error);
            }
        }
        public void Resume() {
            if (ResumeThread(thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(thread); thread = IntPtr.Zero;
        }
        public int Wait() {
            if (WaitForSingleObject(process, UInt32.MaxValue) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint code; Check(GetExitCodeProcess(process, out code)); return unchecked((int)code);
        }
        public void Dispose() {
            if (job != IntPtr.Zero) {
                // Node may exit before its helper; drain the whole owned job before releasing it.
                TerminateJobObject(job, 1);
                var until = DateTime.UtcNow.AddSeconds(20);
                var count = new ACCOUNTING();
                while (QueryInformationJobObject(job, 1, ref count, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero) && count.active != 0 && DateTime.UtcNow < until) System.Threading.Thread.Sleep(25);
                CloseHandle(job); job = IntPtr.Zero;
            }
            if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
            if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        }
    }
}
