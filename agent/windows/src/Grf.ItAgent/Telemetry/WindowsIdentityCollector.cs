using System.Globalization;
using Microsoft.Win32;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Utilities;

namespace Grf.ItAgent.Telemetry;

internal static class WindowsIdentityCollector
{
    private const string CurrentVersionPath = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

    public static string GetMachineGuid()
    {
        using var localMachine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var key = localMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography", writable: false);
        var rawValue = key?.GetValue("MachineGuid")?.ToString();
        if (!Guid.TryParse(rawValue, out var machineGuid) || machineGuid == Guid.Empty)
        {
            throw new InvalidDataException("Windows MachineGuid no está disponible o no es válido.");
        }

        // The API canonical form is lowercase UUID without braces.
        return machineGuid.ToString("D");
    }

    public static OsSnapshot GetOs()
    {
        try
        {
            using var localMachine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var key = localMachine.OpenSubKey(CurrentVersionPath, writable: false);
            var version = StringLimiter.LimitOptional(
                key?.GetValue("DisplayVersion") as string ?? key?.GetValue("ReleaseId") as string,
                100);
            var buildNumber = key?.GetValue("CurrentBuildNumber")?.ToString();
            var revision = key?.GetValue("UBR")?.ToString();
            var name = NormalizeProductName(
                StringLimiter.LimitRequired(key?.GetValue("ProductName") as string, 200, "Windows"),
                buildNumber);
            var build = StringLimiter.LimitOptional(
                string.IsNullOrWhiteSpace(revision) ? buildNumber : $"{buildNumber}.{revision}",
                100);
            return new OsSnapshot(name, version, build);
        }
        catch
        {
            return new OsSnapshot("Windows", StringLimiter.LimitOptional(Environment.OSVersion.VersionString, 100), null);
        }
    }

    // Windows 11 conserva "Windows 10" en ProductName por compatibilidad con
    // instaladores viejos; el build 22000+ es la única marca confiable.
    internal static string NormalizeProductName(string productName, string? buildNumber)
    {
        const string windows10 = "Windows 10";
        return int.TryParse(buildNumber, NumberStyles.None, CultureInfo.InvariantCulture, out var build)
               && build >= 22_000
               && productName.StartsWith(windows10, StringComparison.OrdinalIgnoreCase)
            ? string.Concat("Windows 11", productName.AsSpan(windows10.Length))
            : productName;
    }
}
