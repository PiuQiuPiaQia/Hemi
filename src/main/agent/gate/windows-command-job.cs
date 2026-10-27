// Copyright (c) Hemi contributors. MIT License.
// A command owns a non-breakaway Windows Job, not a recyclable parent PID.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class HemiCommandJob {
    const uint KILL_ON_CLOSE = 0x2000, WAIT_TIMEOUT = 258;
    static volatile bool cancelled;
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public Limits Basic;
        public Counters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, Total, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Basic; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx start, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security security, uint creation, uint flags, IntPtr template);

    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Drain(IntPtr job) {
        var until = Stopwatch.StartNew();
        while (true) {
            Accounting info;
            Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
            if (info.Active == 0) return;
            if (until.ElapsedMilliseconds > 5000) throw new TimeoutException("Job cleanup unconfirmed");
            Thread.Sleep(20);
        }
    }
    static int Reap(string name) {
        IntPtr job = OpenJobObject(0xC, false, name); // QUERY | TERMINATE
        if (job == IntPtr.Zero) {
            if (Marshal.GetLastWin32Error() == 2) return 0; // Object gone only after all members exit.
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try { Check(TerminateJobObject(job, 125)); Drain(job); return 0; }
        finally { CloseHandle(job); }
    }
    static int Run(string name, string command) {
        // Nothing can execute before the host durably registers this supervisor.
        if (Console.ReadLine() != "start") return 125;
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        int error = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero) throw new Win32Exception(error);
        if (error == 183) { CloseHandle(job); throw new Exception("Job identity already exists"); }
        var process = new ProcessInfo();
        IntPtr input = IntPtr.Zero, attributes = IntPtr.Zero, jobs = IntPtr.Zero;
        bool initialized = false;
        try {
            var limits = new ExtendedLimits(); limits.Basic.Flags = KILL_ON_CLOSE;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            var security = new Security { Size=Marshal.SizeOf(typeof(Security)), Inherit=true };
            input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            Check(input != new IntPtr(-1));
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); initialized = true;
            jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
            // JOB_LIST binds ownership as part of creation (Windows 10 / Server 2016+).
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var start = new StartupEx { Attributes=attributes, Basic=new Startup {
                Size=(uint)Marshal.SizeOf(typeof(StartupEx)), Flags=0x100,
                Input=input, Output=GetStdHandle(-11), Error=GetStdHandle(-12) } };
            string shell = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            // Suspended until our cancellation monitor is active; already owned by the Job.
            Check(CreateProcess(shell, new StringBuilder("\""+shell+"\" /d /s /c \""+command+"\""), IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, null, ref start, out process));
            var monitor = new Thread(() => { try { while (Console.ReadLine() != null) { cancelled=true; break; } } catch {} cancelled=true; });
            monitor.IsBackground=true; monitor.Start();
            if (!cancelled) Check(ResumeThread(process.Thread) != 0xFFFFFFFF);
            while (!cancelled && WaitForSingleObject(process.Process, 20) == WAIT_TIMEOUT) {}
            uint code=125;
            if (!cancelled) Check(GetExitCodeProcess(process.Process, out code));
            Check(TerminateJobObject(job, 125));
            Drain(job);
            return unchecked((int)code);
        } finally {
            // The handle is non-inheritable. Host/supervisor death kills the same Job.
            if (process.Process != IntPtr.Zero) { TerminateProcess(process.Process, 125); CloseHandle(process.Process); }
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            CloseHandle(job);
        }
    }
    static int Main(string[] args) {
        try {
            if (args.Length == 2 && args[0] == "birth") {
                using (var process = Process.GetProcessById(Int32.Parse(args[1]))) Console.WriteLine(process.StartTime.ToUniversalTime().Ticks);
                return 0;
            }
            Guid token;
            if (args.Length < 2 || !Guid.TryParse(args[1], out token)) return 126;
            // Recovery can run in a different Windows logon session.
            string name="Global\\HemiCommand-"+token.ToString("D");
            if (args[0] == "reap") return Reap(name);
            if (args[0] != "run" || args.Length != 3) return 126;
            return Run(name, Encoding.UTF8.GetString(Convert.FromBase64String(args[2])));
        } catch (Exception error) {
            Console.Error.WriteLine("Hemi command supervisor: "+error.GetType().Name);
            return 125;
        }
    }
}
