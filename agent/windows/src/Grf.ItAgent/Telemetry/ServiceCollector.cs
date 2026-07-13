using System.Diagnostics;
using System.Net.NetworkInformation;
using Microsoft.Win32;
using Grf.ItAgent.Contracts;

namespace Grf.ItAgent.Telemetry;

internal static class ServiceCollector
{
    private static readonly string[] VncServiceNames = ["uvnc_service", "winvnc", "UltraVNC"];
    private static readonly string[] VncProcessNames = ["winvnc", "uvnc_service"];

    public static ServiceSnapshot Collect()
    {
        var sshPort = ReadSshPort();
        var vncPort = ReadVncPort();
        var sshAvailable = ProcessExists("sshd") || (ServiceExists("sshd") && IsTcpPortListening(sshPort));
        var vncAvailable = VncProcessNames.Any(ProcessExists)
            || (VncServiceNames.Any(ServiceExists) && IsTcpPortListening(vncPort));

        return new ServiceSnapshot(
            new RemoteServiceSnapshot(sshAvailable, sshAvailable ? sshPort : null),
            new RemoteServiceSnapshot(vncAvailable, vncAvailable ? vncPort : null));
    }

    private static bool IsTcpPortListening(int port)
    {
        try
        {
            return IPGlobalProperties.GetIPGlobalProperties()
                .GetActiveTcpListeners()
                .Any(endpoint => endpoint.Port == port);
        }
        catch
        {
            return false;
        }
    }

    private static bool ServiceExists(string serviceName)
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Services\{serviceName}", writable: false);
            return key is not null;
        }
        catch
        {
            return false;
        }
    }

    private static bool ProcessExists(string processName)
    {
        try
        {
            var processes = Process.GetProcessesByName(processName);
            foreach (var process in processes)
            {
                process.Dispose();
            }

            return processes.Length > 0;
        }
        catch
        {
            return false;
        }
    }

    private static int ReadSshPort()
    {
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ssh", "sshd_config");
        try
        {
            var file = new FileInfo(path);
            if (!file.Exists || file.Length > 1024 * 1024)
            {
                return 22;
            }

            foreach (var rawLine in File.ReadLines(path))
            {
                var line = rawLine.Split('#', 2)[0].Trim();
                var parts = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 2
                    && parts[0].Equals("Port", StringComparison.OrdinalIgnoreCase)
                    && int.TryParse(parts[1], out var port)
                    && port is >= 1 and <= 65_535)
                {
                    return port;
                }
            }
        }
        catch
        {
            // The default remains useful when the service configuration is not readable.
        }

        return 22;
    }

    private static int ReadVncPort()
    {
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using var localMachine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                using var key = localMachine.OpenSubKey(@"SOFTWARE\uvnc bvba\UltraVNC", writable: false);
                foreach (var valueName in new[] { "PortNumber", "RfbPort" })
                {
                    if (int.TryParse(key?.GetValue(valueName)?.ToString(), out var port) && port is >= 1 and <= 65_535)
                    {
                        return port;
                    }
                }
            }
            catch
            {
                // Try the other registry view and then the product default.
            }
        }

        return 5900;
    }
}
