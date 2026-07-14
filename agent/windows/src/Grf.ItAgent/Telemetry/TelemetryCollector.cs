using System.Diagnostics;
using System.Reflection;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Updates;
using Grf.ItAgent.Utilities;

namespace Grf.ItAgent.Telemetry;

internal sealed class TelemetryCollector
{
    private const long MaximumSafeInteger = 9_007_199_254_740_991;
    private static readonly TimeSpan CpuSampleDuration = TimeSpan.FromMilliseconds(500);
    private readonly InventoryCollector _inventoryCollector = new();

    public async Task<HeartbeatRequest> CollectAsync(bool includeInventory, CancellationToken cancellationToken)
    {
        var sampleTimer = Stopwatch.StartNew();
        var initialCpu = WindowsNative.TryReadCpuTimes();
        var network = NetworkCollector.Collect();
        var memory = WindowsNative.ReadMemory();
        var battery = WindowsNative.ReadBattery();
        var disks = ReadDisks();
        var services = ServiceCollector.Collect();
        var os = WindowsIdentityCollector.GetOs();
        var now = DateTimeOffset.UtcNow;
        var inventory = includeInventory ? _inventoryCollector.Collect(network, now) : null;

        var remainingSampleTime = CpuSampleDuration - sampleTimer.Elapsed;
        if (remainingSampleTime > TimeSpan.Zero)
        {
            await Task.Delay(remainingSampleTime, cancellationToken).ConfigureAwait(false);
        }

        var finalCpu = WindowsNative.TryReadCpuTimes();
        var cpuPercent = initialCpu is not null && finalCpu is not null
            ? CpuUsageCalculator.Calculate(initialCpu.Value, finalCpu.Value)
            : null;

        return new HeartbeatRequest(
            MachineIdentity.GetHostname(),
            StringLimiter.LimitOptional(WindowsNative.GetInteractiveUsername(), 255),
            network.HeartbeatAddresses,
            network.HeartbeatMacAddresses,
            (int)Math.Min(Math.Max(Environment.TickCount64 / 1_000, 0), int.MaxValue),
            cpuPercent,
            memory,
            battery,
            disks,
            services,
            os,
            AgentVersion.Current,
            inventory);
    }

    private static IReadOnlyList<DiskSnapshot>? ReadDisks()
    {
        var disks = new List<DiskSnapshot>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            if (disks.Count >= 64 || drive.DriveType != DriveType.Fixed)
            {
                continue;
            }

            try
            {
                if (!drive.IsReady)
                {
                    continue;
                }

                var total = Math.Min(Math.Max(drive.TotalSize, 0), MaximumSafeInteger);
                var free = Math.Min(Math.Max(drive.AvailableFreeSpace, 0), total);
                disks.Add(new DiskSnapshot(
                    StringLimiter.LimitRequired(drive.Name, 200, "disk"),
                    total,
                    total - free));
            }
            catch (IOException)
            {
                // A removable or virtual disk may become unavailable while enumerating.
            }
            catch (UnauthorizedAccessException)
            {
                // Skip volumes that SYSTEM still cannot inspect.
            }
        }

        return disks.Count == 0 ? null : disks;
    }
}

internal static class AgentVersion
{
    private const string SafeFallbackVersion = "0.1.0";

    public static string Current { get; } = GetVersion();

    private static string GetVersion()
    {
        var assembly = Assembly.GetExecutingAssembly();
        return Select(
            assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
            assembly.GetName().Version);
    }

    internal static string Select(string? informationalVersion, Version? assemblyVersion)
    {
        // AssemblyName.Version cannot represent prerelease/build metadata. The SDK-generated
        // informational version can, so prefer it only when it is an exact, bounded SemVer.
        if (informationalVersion is { Length: <= 100 }
            && SemanticVersion.TryParse(informationalVersion, out _))
        {
            return informationalVersion;
        }

        if (assemblyVersion is { Major: >= 0, Minor: >= 0, Build: >= 0 })
        {
            var fallback = $"{assemblyVersion.Major}.{assemblyVersion.Minor}.{assemblyVersion.Build}";
            if (SemanticVersion.TryParse(fallback, out _))
            {
                return fallback;
            }
        }

        return SafeFallbackVersion;
    }
}
