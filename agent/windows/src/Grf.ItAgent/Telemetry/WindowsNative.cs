using System.Runtime.InteropServices;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Utilities;

namespace Grf.ItAgent.Telemetry;

internal static class WindowsNative
{
    private static readonly IntPtr CurrentServer = IntPtr.Zero;

    public static CpuTimes? TryReadCpuTimes()
    {
        return GetSystemTimes(out var idle, out var kernel, out var user)
            ? new CpuTimes(idle.ToUInt64(), kernel.ToUInt64(), user.ToUInt64())
            : null;
    }

    public static RamSnapshot ReadMemory()
    {
        var status = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        if (!GlobalMemoryStatusEx(ref status))
        {
            return new RamSnapshot(0, 0);
        }

        var total = ToSafeInteger(status.TotalPhysical);
        var available = Math.Min(ToSafeInteger(status.AvailablePhysical), total);
        return new RamSnapshot(total, total - available);
    }

    public static BatterySnapshot? ReadBattery()
    {
        if (!GetSystemPowerStatus(out var status) || status.BatteryFlag == 128)
        {
            return null;
        }

        int? percent = status.BatteryLifePercent == byte.MaxValue
            ? null
            : Math.Clamp(status.BatteryLifePercent, (byte)0, (byte)100);
        bool? charging = status.BatteryFlag == byte.MaxValue
            ? null
            : (status.BatteryFlag & 8) != 0;
        return new BatterySnapshot(percent, charging);
    }

    public static string? GetInteractiveUsername()
    {
        var sessionIds = new List<int>();
        var consoleSession = WTSGetActiveConsoleSessionId();
        if (consoleSession != uint.MaxValue)
        {
            sessionIds.Add((int)consoleSession);
        }

        if (WTSEnumerateSessions(CurrentServer, 0, 1, out var sessionsPointer, out var count))
        {
            try
            {
                var size = Marshal.SizeOf<WtsSessionInfo>();
                for (var index = 0; index < count; index++)
                {
                    var item = Marshal.PtrToStructure<WtsSessionInfo>(sessionsPointer + (index * size));
                    if (item.State == WtsConnectState.Active && !sessionIds.Contains(item.SessionId))
                    {
                        sessionIds.Add(item.SessionId);
                    }
                }
            }
            finally
            {
                WTSFreeMemory(sessionsPointer);
            }
        }

        foreach (var sessionId in sessionIds)
        {
            var username = QuerySessionString(sessionId, WtsInfoClass.UserName);
            if (string.IsNullOrWhiteSpace(username))
            {
                continue;
            }

            var domain = QuerySessionString(sessionId, WtsInfoClass.DomainName);
            return string.IsNullOrWhiteSpace(domain) ? username : $"{domain}\\{username}";
        }

        var fallback = Environment.UserName;
        return fallback.Equals("SYSTEM", StringComparison.OrdinalIgnoreCase)
               || fallback.Equals("LOCAL SERVICE", StringComparison.OrdinalIgnoreCase)
               || fallback.Equals("NETWORK SERVICE", StringComparison.OrdinalIgnoreCase)
            ? null
            : fallback;
    }

    private static string? QuerySessionString(int sessionId, WtsInfoClass infoClass)
    {
        if (!WTSQuerySessionInformation(CurrentServer, sessionId, infoClass, out var buffer, out var bytes)
            || buffer == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            return bytes <= 2 ? null : Marshal.PtrToStringUni(buffer)?.TrimEnd('\0');
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    private static long ToSafeInteger(ulong value)
    {
        const ulong maximumSafeInteger = 9_007_199_254_740_991;
        return (long)Math.Min(value, maximumSafeInteger);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFileTime
    {
        public uint Low;
        public uint High;

        public readonly ulong ToUInt64() => ((ulong)High << 32) | Low;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhysical;
        public ulong AvailablePhysical;
        public ulong TotalPageFile;
        public ulong AvailablePageFile;
        public ulong TotalVirtual;
        public ulong AvailableVirtual;
        public ulong AvailableExtendedVirtual;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemPowerStatus
    {
        public byte AcLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte SystemStatusFlag;
        public uint BatteryLifeTime;
        public uint BatteryFullLifeTime;
    }

    private enum WtsConnectState
    {
        Active = 0,
    }

    private enum WtsInfoClass
    {
        UserName = 5,
        DomainName = 7,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WtsSessionInfo
    {
        public int SessionId;
        public IntPtr WinStationName;
        public WtsConnectState State;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemTimes(out NativeFileTime idle, out NativeFileTime kernel, out NativeFileTime user);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemPowerStatus(out SystemPowerStatus status);

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSEnumerateSessions(
        IntPtr server,
        int reserved,
        int version,
        out IntPtr sessionInfo,
        out int count);

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSQuerySessionInformation(
        IntPtr server,
        int sessionId,
        WtsInfoClass infoClass,
        out IntPtr buffer,
        out int bytesReturned);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr memory);
}
