using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Nootify {
    // A named, private job lets management retain authoritative membership across Scheduler.Stop.
    // Its random name is published in private state before any process is created in it.
    public sealed class ServiceJob : IDisposable {
        [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
        [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
            public long processTime, jobTime; public uint flags; public UIntPtr minimum, maximum;
            public uint active; public UIntPtr affinity; public uint priority, scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS { public BASIC_LIMITS basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
        [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
            public long user, kernel, periodUser, periodKernel; public uint faults, total, active, terminated;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(ref SECURITY_ATTRIBUTES attributes, string name);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref EXTENDED_LIMITS data, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int info, ref ACCOUNTING data, uint length, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr value);
        [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle, int kind, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, [Out] byte[] data, UIntPtr size, out UIntPtr read);
        // MSRC documents the fixed, read-only user mapping and stable field offsets:
        // https://www.microsoft.com/en-us/msrc/blog/2022/04/randomizing-the-kuser_shared_data-structure-on-windows
        // The WDK KUSER_SHARED_DATA layout places BootId at 0x2C4 and documents it as
        // the boot sequence incremented by the loader, not a wall-clock boot estimate.
        // https://learn.microsoft.com/windows-hardware/drivers/ddi/ntddk/ns-ntddk-kuser_shared_data
        static uint? BootSequenceFromData(byte[] data) {
            if (data == null || data.Length != 0x2C8) return null;
            ushort architecture = BitConverter.ToUInt16(data, 0x26A);
            if ((architecture != 0 && architecture != 9 && architecture != 12) ||
                BitConverter.ToUInt32(data, 0x26C) != 10 || BitConverter.ToUInt32(data, 0x270) != 0 ||
                BitConverter.ToUInt32(data, 0x260) < 10240) return null;
            return BitConverter.ToUInt32(data, 0x2C4);
        }
        public static uint? ReadBootSequence() {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) return null;
            var data = new byte[0x2C8]; UIntPtr read;
            // Reading our own documented shared mapping needs no process discovery or privilege.
            if (!ReadProcessMemory(new IntPtr(-1), new IntPtr(0x7FFE0000), data, new UIntPtr((uint)data.Length), out read) ||
                read.ToUInt64() != (ulong)data.Length) return null;
            return BootSequenceFromData(data);
        }
        IntPtr handle;
        readonly string name, completionPath;
        ServiceJob(IntPtr value, string jobName, string receiptPath) { handle = value; name = jobName; completionPath = receiptPath; }
        internal IntPtr Handle { get { if (handle == IntPtr.Zero) throw new ObjectDisposedException("ServiceJob"); return handle; } }
        static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        public static ServiceJob Create(string name, string sid) { return Create(name, sid, null); }
        public static ServiceJob Create(string name, string sid, string completionPath) {
            IntPtr descriptor = IntPtr.Zero;
            try {
                Check(ConvertStringSecurityDescriptorToSecurityDescriptor("O:" + sid + "D:P(A;;GA;;;" + sid + ")(A;;GA;;;SY)", 1, out descriptor, IntPtr.Zero));
                var attributes = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), descriptor = descriptor };
                IntPtr value = CreateJobObject(ref attributes, name);
                int error = Marshal.GetLastWin32Error();
                if (value == IntPtr.Zero) throw new Win32Exception(error);
                var job = new ServiceJob(value, name, completionPath);
                try {
                    // Never reconnect to, change limits on, or terminate a pre-existing job.
                    if (error == 183) throw new InvalidOperationException("Refusing an existing service job name");
                    var limits = new EXTENDED_LIMITS(); limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
                    Check(SetInformationJobObject(value, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMITS))));
                    return job;
                } catch { job.Dispose(); throw; }
            } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
        }
        public static ServiceJob Open(string name, string sid) { return Open(name, sid, null); }
        public static ServiceJob Open(string name, string sid, string completionPath) {
            IntPtr value = OpenJobObject(0x2000C, false, name); // READ_CONTROL | JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE; no assignment rights.
            if (value == IntPtr.Zero) {
                int error = Marshal.GetLastWin32Error();
                // A temporary object's name disappears at handle count zero, before its
                // final kernel references necessarily disappear. Absence is NOT a drain.
                // https://learn.microsoft.com/windows-hardware/drivers/kernel/life-cycle-of-an-object
                if (error == 2) return null;
                throw new Win32Exception(error);
            }
            var job = new ServiceJob(value, name, completionPath);
            IntPtr descriptor = IntPtr.Zero, text = IntPtr.Zero;
            try {
                IntPtr owner, group, dacl, sacl;
                uint error = GetSecurityInfo(value, 6, 1, out owner, out group, out dacl, out sacl, out descriptor); // SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION
                if (error != 0) throw new Win32Exception((int)error);
                Check(ConvertSidToStringSid(owner, out text));
                if (!String.Equals(Marshal.PtrToStringUni(text), sid, StringComparison.Ordinal)) throw new InvalidOperationException("Refusing a service job owned by another user");
                return job;
            } catch { job.Dispose(); throw; }
            finally { if (text != IntPtr.Zero) LocalFree(text); if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
        }
        public uint ActiveProcesses {
            get {
                var count = new ACCOUNTING();
                Check(QueryInformationJobObject(Handle, 1, ref count, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero));
                return count.active; // Includes descendants and nested jobs; a PID snapshot cannot prove completion.
            }
        }
        public void TerminateAndWait(int milliseconds) {
            if (milliseconds < 0) throw new ArgumentOutOfRangeException("milliseconds");
            var watch = Stopwatch.StartNew();
            // An extra management handle prevents KILL_ON_JOB_CLOSE. Always terminate explicitly.
            Check(TerminateJobObject(Handle, 1));
            while (ActiveProcesses != 0) {
                if (watch.ElapsedMilliseconds >= milliseconds) throw new TimeoutException("Timed out waiting for the Nootify job to release its files");
                System.Threading.Thread.Sleep((int)Math.Max(1, Math.Min(25, milliseconds - watch.ElapsedMilliseconds)));
            }
            // Only an authoritative empty job may publish a receipt. Its unpredictable
            // per-run identity cannot certify another run, even if the host finishes late.
            // Keep this handle open until publication completes; closing it alone proves nothing.
            if (completionPath != null) {
                string temporary = completionPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try {
                    File.WriteAllText(temporary, name);
                    try { File.Move(temporary, completionPath); }
                    catch (IOException) {
                        // Management and a normally exiting host may both finish this run.
                        if (!String.Equals(File.ReadAllText(completionPath), name, StringComparison.Ordinal)) throw;
                    }
                } finally { File.Delete(temporary); }
            }
        }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    }

    public sealed class ServiceRunner : IDisposable {
        [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
            public int size; public string reserved, desktop, title;
            public int x, y, width, height, charsX, charsY, fill, flags;
            public short show, reservedSize; public IntPtr reservedData, input, output, error;
        }
        [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
        [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
        ServiceJob job;
        IntPtr process, thread;
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
        public ServiceRunner(ServiceJob ownedJob, string node, string[] args, string directory) {
            if (ownedJob == null) throw new ArgumentNullException("ownedJob");
            job = ownedJob;
            IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero, attributes = IntPtr.Zero, jobList = IntPtr.Zero;
            bool initialized = false;
            try {
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); initialized = true;
                jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job.Handle);
                // Windows 10+: assign atomically at creation, including if the host dies before CreateProcess returns.
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)); // PROC_THREAD_ATTRIBUTE_JOB_LIST
                input = LogFile("NUL", true); output = LogFile(Path.Combine(directory, "stdout.log"), false); error = LogFile(Path.Combine(directory, "stderr.log"), false);
                var startup = new STARTUPINFOEX { startup = new STARTUPINFO { size = Marshal.SizeOf(typeof(STARTUPINFOEX)), flags = 0x101, show = 0, input = input, output = output, error = error }, attributes = attributes };
                var command = new StringBuilder(Quote(node)); foreach (string arg in args) command.Append(' ').Append(Quote(arg));
                PROCESS_INFORMATION child;
                Check(CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, directory, ref startup, out child)); // NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | SUSPENDED
                process = child.process; thread = child.thread; ProcessId = child.pid;
            } finally {
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
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
            try { if (job != null) job.TerminateAndWait(20000); }
            finally {
                if (job != null) { job.Dispose(); job = null; }
                if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
                if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
            }
        }
    }
}
