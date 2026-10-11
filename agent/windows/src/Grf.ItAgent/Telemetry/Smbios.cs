using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Utilities;

namespace Grf.ItAgent.Telemetry;

// Tabla SMBIOS cruda del firmware, la misma fuente que leen Win32_BIOS o
// Win32_PhysicalMemory, pero sin depender del servicio WMI ni de paquetes extra.
// El registro (HARDWARE\DESCRIPTION\System\BIOS) no publica el número de serie:
// por eso el agente 0.2 lo informaba siempre vacío.
internal sealed class SmbiosStructure
{
    private readonly byte[] _formatted;
    private readonly string[] _strings;

    public SmbiosStructure(byte[] formatted, string[] strings)
    {
        if (formatted.Length < 4)
        {
            throw new ArgumentException("Una estructura SMBIOS tiene al menos 4 bytes.", nameof(formatted));
        }

        _formatted = formatted;
        _strings = strings;
    }

    public byte Type => _formatted[0];

    public int Length => _formatted.Length;

    public ushort Handle => BinaryPrimitives.ReadUInt16LittleEndian(_formatted.AsSpan(2, 2));

    public byte? ReadByte(int offset)
    {
        return offset >= 0 && offset < _formatted.Length ? _formatted[offset] : null;
    }

    public ushort? ReadWord(int offset)
    {
        return offset >= 0 && offset + 2 <= _formatted.Length
            ? BinaryPrimitives.ReadUInt16LittleEndian(_formatted.AsSpan(offset, 2))
            : null;
    }

    public uint? ReadDword(int offset)
    {
        return offset >= 0 && offset + 4 <= _formatted.Length
            ? BinaryPrimitives.ReadUInt32LittleEndian(_formatted.AsSpan(offset, 4))
            : null;
    }

    // Los textos se referencian por índice (1-based) desde el área formateada; 0 = sin texto.
    public string? ReadString(int offset)
    {
        var index = ReadByte(offset);
        return index is null or 0 || index.Value > _strings.Length ? null : _strings[index.Value - 1];
    }
}

internal static class SmbiosParser
{
    // RawSMBIOSData: método de llamada, versión mayor/menor, revisión DMI y longitud (DWORD).
    private const int RawHeaderLength = 8;
    private const int MaximumStructures = 1_024;
    private const int MaximumStringsPerStructure = 255;
    private const byte EndOfTable = 127;

    public static IReadOnlyList<SmbiosStructure> Parse(ReadOnlySpan<byte> raw)
    {
        if (raw.Length < RawHeaderLength)
        {
            return [];
        }

        var declaredLength = BinaryPrimitives.ReadUInt32LittleEndian(raw.Slice(4, 4));
        var availableLength = raw.Length - RawHeaderLength;
        var table = raw.Slice(RawHeaderLength, (int)Math.Min(declaredLength, (uint)availableLength));

        var structures = new List<SmbiosStructure>();
        var offset = 0;
        while (offset + 4 <= table.Length && structures.Count < MaximumStructures)
        {
            var type = table[offset];
            var length = table[offset + 1];
            if (length < 4 || offset + length > table.Length)
            {
                break;
            }

            var formatted = table.Slice(offset, length).ToArray();
            var cursor = offset + length;
            var strings = new List<string>();
            if (cursor + 1 < table.Length && table[cursor] == 0 && table[cursor + 1] == 0)
            {
                // Estructura sin textos: el conjunto vacío son dos ceros.
                cursor += 2;
            }
            else
            {
                while (cursor < table.Length)
                {
                    var end = table[cursor..].IndexOf((byte)0);
                    if (end < 0)
                    {
                        cursor = table.Length;
                        break;
                    }

                    if (end == 0)
                    {
                        cursor++;
                        break;
                    }

                    if (strings.Count < MaximumStringsPerStructure)
                    {
                        // La especificación pide ASCII; Latin1 nunca lanza ante un byte raro.
                        strings.Add(Encoding.Latin1.GetString(table.Slice(cursor, end)));
                    }

                    cursor += end + 1;
                }
            }

            structures.Add(new SmbiosStructure(formatted, strings.ToArray()));
            if (type == EndOfTable)
            {
                break;
            }

            offset = cursor;
        }

        return structures;
    }
}

internal sealed record SmbiosInventory(
    string? Manufacturer,
    string? Model,
    string? SerialNumber,
    string? BiosVersion,
    string? ChassisType,
    string? BaseboardManufacturer,
    string? BaseboardModel,
    string? BaseboardSerial,
    IReadOnlyList<MemoryModuleSnapshot>? MemoryModules,
    int? MemorySlots);

internal static class SmbiosInventoryReader
{
    private const uint RawSmbiosProvider = 0x52534D42; // 'RSMB'
    private const int MaximumTableBytes = 1_048_576;
    private const byte SystemMemoryUse = 0x03;
    private const int MaximumModules = 32;
    private const int MaximumSlots = 256;

    public static SmbiosInventory? Read()
    {
        try
        {
            var raw = ReadRawTable();
            return raw is null ? null : FromStructures(SmbiosParser.Parse(raw));
        }
        catch
        {
            // Firmware sin SMBIOS o tabla corrupta: el inventario sigue con el registro.
            return null;
        }
    }

    internal static SmbiosInventory FromStructures(IReadOnlyList<SmbiosStructure> structures)
    {
        var bios = structures.FirstOrDefault(structure => structure.Type == 0);
        var system = structures.FirstOrDefault(structure => structure.Type == 1);
        var baseboard = structures.FirstOrDefault(structure => structure.Type == 2);
        var chassis = structures.FirstOrDefault(structure => structure.Type == 3);
        var (modules, slots) = ReadMemory(structures);
        var manufacturer = FirmwareText.Clean(system?.ReadString(0x04), 200);

        return new SmbiosInventory(
            manufacturer,
            FriendlyModel(
                manufacturer,
                FirmwareText.Clean(system?.ReadString(0x05), 200),
                FirmwareText.Clean(system?.ReadString(0x06), 200)),
            FirmwareText.Clean(system?.ReadString(0x07), 200)
                ?? FirmwareText.Clean(chassis?.ReadString(0x07), 200),
            FirmwareText.Clean(bios?.ReadString(0x05), 200),
            ChassisTypeName(chassis?.ReadByte(0x05)),
            FirmwareText.Clean(baseboard?.ReadString(0x04), 200),
            FirmwareText.Clean(baseboard?.ReadString(0x05), 200),
            FirmwareText.Clean(baseboard?.ReadString(0x07), 200),
            modules,
            slots);
    }

    // Lenovo informa en ProductName el tipo de máquina ("21SH") y el nombre comercial en
    // Version ("ThinkBook 16 G8 IRL"). Se muestran los dos: el nombre para reconocer el
    // equipo y el tipo de máquina para garantía y repuestos.
    internal static string? FriendlyModel(string? manufacturer, string? productName, string? version)
    {
        if (manufacturer is null
            || !manufacturer.StartsWith("LENOVO", StringComparison.OrdinalIgnoreCase)
            || version is null
            || !version.Any(char.IsLetter)
            || string.Equals(version, productName, StringComparison.OrdinalIgnoreCase))
        {
            return productName;
        }

        return productName is null ? version : StringLimiter.LimitOptional($"{version} ({productName})", 200);
    }

    internal static long? ReadModuleCapacity(SmbiosStructure device)
    {
        var size = device.ReadWord(0x0C);
        if (size is null or 0 or 0xFFFF)
        {
            // 0 = ranura vacía; 0xFFFF = tamaño desconocido.
            return null;
        }

        if (size == 0x7FFF)
        {
            // SMBIOS 2.7+: módulos de 32 GB o más usan el tamaño extendido, en MB.
            var extended = device.ReadDword(0x1C);
            return extended is null or 0 ? null : (long)(extended.Value & 0x7FFF_FFFF) * 1_048_576;
        }

        var value = size.Value & 0x7FFF;
        return (size.Value & 0x8000) != 0 ? value * 1_024L : value * 1_048_576L;
    }

    private static (IReadOnlyList<MemoryModuleSnapshot>? Modules, int? Slots) ReadMemory(
        IReadOnlyList<SmbiosStructure> structures)
    {
        // Solo la memoria del sistema: la flash del firmware también aparece como arreglo.
        var systemArrays = structures
            .Where(structure => structure.Type == 16 && structure.ReadByte(0x05) == SystemMemoryUse)
            .ToArray();
        var arrayHandles = systemArrays.Select(structure => structure.Handle).ToHashSet();
        var devices = structures
            .Where(structure => structure.Type == 17 && structure.Length >= 0x15)
            .Where(structure => arrayHandles.Count == 0
                                || (structure.ReadWord(0x04) is { } handle && arrayHandles.Contains(handle)))
            .ToArray();

        var modules = new List<MemoryModuleSnapshot>();
        foreach (var device in devices)
        {
            var capacity = ReadModuleCapacity(device);
            if (capacity is null || modules.Count >= MaximumModules)
            {
                continue;
            }

            modules.Add(new MemoryModuleSnapshot(
                capacity.Value,
                FirmwareText.Clean(device.ReadString(0x17), 200),
                FirmwareText.Clean(device.ReadString(0x1A), 200),
                FirmwareText.Clean(device.ReadString(0x18), 200),
                ReadSpeed(device),
                MemoryTypeName(device.ReadByte(0x12)),
                FormFactorName(device.ReadByte(0x0E)),
                FirmwareText.Clean(device.ReadString(0x10), 100)));
        }

        var declaredSlots = systemArrays.Sum(structure => (int)(structure.ReadWord(0x0D) ?? 0));
        int? slots = declaredSlots > 0 ? declaredSlots : devices.Length > 0 ? devices.Length : null;
        if (slots is not null)
        {
            // Firmware inconsistente: nunca informar menos ranuras que módulos instalados.
            slots = Math.Min(Math.Max(slots.Value, modules.Count), MaximumSlots);
        }

        return (modules.Count == 0 ? null : modules, slots);
    }

    private static int? ReadSpeed(SmbiosStructure device)
    {
        var speed = device.ReadWord(0x15);
        if (speed is null or 0)
        {
            return null;
        }

        if (speed == 0xFFFF)
        {
            var extended = device.ReadDword(0x54);
            return extended is null or 0 ? null : (int)Math.Min(extended.Value & 0x7FFF_FFFF, 100_000);
        }

        return speed.Value;
    }

    internal static string? ChassisTypeName(byte? value)
    {
        // El bit 7 indica si el gabinete tiene traba; el tipo son los 7 bits bajos.
        return (value & 0x7F) switch
        {
            0x01 => "OTHER",
            0x03 => "DESKTOP",
            0x04 => "LOW_PROFILE_DESKTOP",
            0x05 => "PIZZA_BOX",
            0x06 => "MINI_TOWER",
            0x07 => "TOWER",
            0x08 => "PORTABLE",
            0x09 => "LAPTOP",
            0x0A => "NOTEBOOK",
            0x0B => "HAND_HELD",
            0x0C => "DOCKING_STATION",
            0x0D => "ALL_IN_ONE",
            0x0E => "SUB_NOTEBOOK",
            0x0F => "SPACE_SAVING",
            0x10 => "LUNCH_BOX",
            0x11 => "MAIN_SERVER",
            0x17 => "RACK_MOUNT",
            0x18 => "SEALED_CASE_PC",
            0x1C => "BLADE",
            0x1E => "TABLET",
            0x1F => "CONVERTIBLE",
            0x20 => "DETACHABLE",
            0x22 => "EMBEDDED_PC",
            0x23 => "MINI_PC",
            0x24 => "STICK_PC",
            _ => null,
        };
    }

    internal static string? MemoryTypeName(byte? value)
    {
        return value switch
        {
            0x0F => "SDRAM",
            0x12 => "DDR",
            0x13 => "DDR2",
            0x14 => "DDR2",
            0x18 => "DDR3",
            0x1A => "DDR4",
            0x1B => "LPDDR",
            0x1C => "LPDDR2",
            0x1D => "LPDDR3",
            0x1E => "LPDDR4",
            0x22 => "DDR5",
            0x23 => "LPDDR5",
            _ => null,
        };
    }

    internal static string? FormFactorName(byte? value)
    {
        return value switch
        {
            0x09 => "DIMM",
            0x0D => "SODIMM",
            0x0F => "FB-DIMM",
            0x0C => "RIMM",
            0x11 => "CAMM",
            // Fila de chips, chip o die: memoria soldada a la placa (típico en notebooks).
            0x05 or 0x0B or 0x10 => "SOLDERED",
            _ => null,
        };
    }

    private static byte[]? ReadRawTable()
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var size = GetSystemFirmwareTable(RawSmbiosProvider, 0, null, 0);
            if (size == 0 || size > MaximumTableBytes)
            {
                return null;
            }

            var buffer = new byte[size];
            var written = GetSystemFirmwareTable(RawSmbiosProvider, 0, buffer, size);
            if (written == 0)
            {
                return null;
            }

            if (written <= size)
            {
                return written == size ? buffer : buffer[..(int)written];
            }

            // La tabla creció entre las dos llamadas: se reintenta una vez con el tamaño nuevo.
        }

        return null;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetSystemFirmwareTable(
        uint firmwareTableProviderSignature,
        uint firmwareTableId,
        [Out] byte[]? firmwareTableBuffer,
        uint bufferSize);
}
