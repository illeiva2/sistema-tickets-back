using Microsoft.Win32;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Utilities;

namespace Grf.ItAgent.Telemetry;

internal sealed class InventoryCollector
{
    private const string BiosPath = @"HARDWARE\DESCRIPTION\System\BIOS";
    private const string CpuPath = @"HARDWARE\DESCRIPTION\System\CentralProcessor\0";
    private const string UninstallPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

    public InventorySnapshot Collect(NetworkCollection network, DateTimeOffset collectedAt)
    {
        var smbios = SmbiosInventoryReader.Read();
        return new InventorySnapshot(
            collectedAt,
            ReadHardware(smbios),
            ReadCpu(),
            smbios?.MemoryModules,
            ReadSoftware(),
            network.InventoryAdapters,
            PhysicalDiskCollector.Collect(),
            smbios?.MemorySlots);
    }

    private static HardwareSnapshot? ReadHardware(SmbiosInventory? smbios)
    {
        // SMBIOS primero; el registro queda de respaldo si el firmware no publica la
        // tabla. El número de serie solo existe en SMBIOS.
        var registry = ReadRegistryHardware();
        var hardware = new HardwareSnapshot(
            smbios?.Manufacturer ?? registry?.Manufacturer,
            smbios?.Model ?? registry?.Model,
            smbios?.SerialNumber,
            smbios?.BiosVersion ?? registry?.BiosVersion,
            smbios?.ChassisType,
            smbios?.BaseboardManufacturer ?? registry?.BaseboardManufacturer,
            smbios?.BaseboardModel ?? registry?.BaseboardModel,
            smbios?.BaseboardSerial);
        return hardware == new HardwareSnapshot(null, null, null, null) ? null : hardware;
    }

    private static HardwareSnapshot? ReadRegistryHardware()
    {
        try
        {
            using var localMachine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var key = localMachine.OpenSubKey(BiosPath, writable: false);
            if (key is null)
            {
                return null;
            }

            return new HardwareSnapshot(
                FirmwareText.Clean(ReadValue(key, "SystemManufacturer"), 200),
                FirmwareText.Clean(ReadValue(key, "SystemProductName"), 200),
                null,
                FirmwareText.Clean(ReadValue(key, "BIOSVersion"), 200),
                null,
                FirmwareText.Clean(ReadValue(key, "BaseBoardManufacturer"), 200),
                FirmwareText.Clean(ReadValue(key, "BaseBoardProduct"), 200));
        }
        catch
        {
            return null;
        }
    }

    private static CpuInventorySnapshot ReadCpu()
    {
        string? model = null;
        try
        {
            using var localMachine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var key = localMachine.OpenSubKey(CpuPath, writable: false);
            model = StringLimiter.LimitOptional(key?.GetValue("ProcessorNameString")?.ToString(), 300);
        }
        catch
        {
            // Logical processor count is still available without registry access.
        }

        return new CpuInventorySnapshot(
            model,
            ProcessorTopology.CountPhysicalCores(),
            Math.Clamp(Environment.ProcessorCount, 1, 2_048));
    }

    private static IReadOnlyList<SoftwareSnapshot>? ReadSoftware()
    {
        var software = new Dictionary<string, SoftwareSnapshot>(StringComparer.OrdinalIgnoreCase);
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using var localMachine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                using var uninstall = localMachine.OpenSubKey(UninstallPath, writable: false);
                if (uninstall is null)
                {
                    continue;
                }

                foreach (var subKeyName in uninstall.GetSubKeyNames())
                {
                    if (software.Count >= 500)
                    {
                        break;
                    }

                    try
                    {
                        using var product = uninstall.OpenSubKey(subKeyName, writable: false);
                        if (product is null || IsHiddenProduct(product))
                        {
                            continue;
                        }

                        var name = StringLimiter.LimitOptional(product.GetValue("DisplayName")?.ToString(), 300);
                        if (name is null)
                        {
                            continue;
                        }

                        var version = StringLimiter.LimitOptional(product.GetValue("DisplayVersion")?.ToString(), 100);
                        var publisher = StringLimiter.LimitOptional(product.GetValue("Publisher")?.ToString(), 200);
                        var key = $"{name}\u001f{version}\u001f{publisher}";
                        software.TryAdd(key, new SoftwareSnapshot(name, version, publisher));
                    }
                    catch
                    {
                        // A broken or concurrently removed installer entry is skipped.
                    }
                }
            }
            catch
            {
                // Continue with the other registry view.
            }
        }

        var ordered = software.Values
            .OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(item => item.Version, StringComparer.OrdinalIgnoreCase)
            .Take(500)
            .ToArray();
        return ordered.Length == 0 ? null : ordered;
    }

    private static bool IsHiddenProduct(RegistryKey product)
    {
        return int.TryParse(product.GetValue("SystemComponent")?.ToString(), out var hidden) && hidden == 1;
    }

    private static string? ReadValue(RegistryKey key, string valueName)
    {
        return key.GetValue(valueName) switch
        {
            string text => text,
            string[] values => string.Join(' ', values),
            object value => value.ToString(),
            _ => null,
        };
    }
}
