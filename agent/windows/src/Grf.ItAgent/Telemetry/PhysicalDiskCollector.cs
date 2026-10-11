using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text;
using Grf.ItAgent.Contracts;
using Microsoft.Win32.SafeHandles;

namespace Grf.ItAgent.Telemetry;

// Discos físicos (no volúmenes) por IOCTL de almacenamiento: modelo, serie, tamaño,
// SSD/HDD e interfaz. Los handles se abren sin derechos de lectura (acceso 0), que
// alcanza para consultar propiedades sin tocar el contenido del disco.
internal static class PhysicalDiskCollector
{
    private const int MaximumDrives = 32;
    private const long MaximumSafeInteger = 9_007_199_254_740_991;
    private const uint FileShareRead = 0x1;
    private const uint FileShareWrite = 0x2;
    private const uint OpenExisting = 3;
    private const uint IoctlStorageQueryProperty = 0x002D_1400;
    private const uint IoctlDiskGetDriveGeometryEx = 0x0007_00A0;
    private const int StorageDeviceProperty = 0;
    private const int StorageDeviceSeekPenaltyProperty = 7;
    private const int BusTypeNvme = 17;

    public static IReadOnlyList<PhysicalDiskSnapshot>? Collect()
    {
        var disks = new List<PhysicalDiskSnapshot>();
        for (var index = 0; index < MaximumDrives; index++)
        {
            try
            {
                var disk = ReadDrive(index);
                if (disk is not null)
                {
                    disks.Add(disk);
                }
            }
            catch
            {
                // Un disco que desaparece o un driver que no responde no corta el resto.
            }
        }

        return disks.Count == 0 ? null : disks;
    }

    private static PhysicalDiskSnapshot? ReadDrive(int index)
    {
        // Los números de PhysicalDrive pueden tener huecos (discos retirados): se
        // recorre el rango completo en lugar de cortar en el primer faltante.
        using var handle = CreateFileW(
            $@"\\.\PhysicalDrive{index}",
            0,
            FileShareRead | FileShareWrite,
            IntPtr.Zero,
            OpenExisting,
            0,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            return null;
        }

        var descriptor = QueryProperty(handle, StorageDeviceProperty);
        var device = descriptor is null ? null : ParseDeviceDescriptor(descriptor);
        if (device is null || device.Removable || IsExcludedBus(device.BusType))
        {
            return null;
        }

        var mediaType = device.BusType == BusTypeNvme
            ? "SSD"
            : ReadSeekPenalty(handle) switch
            {
                true => "HDD",
                false => "SSD",
                null => null,
            };
        return new PhysicalDiskSnapshot(
            device.Model,
            device.SerialNumber,
            ReadDiskSize(handle),
            mediaType,
            BusTypeName(device.BusType));
    }

    internal sealed record StorageDeviceInfo(string? Model, string? SerialNumber, int BusType, bool Removable);

    // STORAGE_DEVICE_DESCRIPTOR: los textos son offsets a cadenas ASCII terminadas en cero.
    internal static StorageDeviceInfo? ParseDeviceDescriptor(ReadOnlySpan<byte> descriptor)
    {
        if (descriptor.Length < 32)
        {
            return null;
        }

        var removable = descriptor[10] != 0;
        var vendor = ReadAnsiString(descriptor, BinaryPrimitives.ReadInt32LittleEndian(descriptor.Slice(12, 4)));
        var product = ReadAnsiString(descriptor, BinaryPrimitives.ReadInt32LittleEndian(descriptor.Slice(16, 4)));
        var serial = ReadAnsiString(descriptor, BinaryPrimitives.ReadInt32LittleEndian(descriptor.Slice(24, 4)));
        var busType = BinaryPrimitives.ReadInt32LittleEndian(descriptor.Slice(28, 4));
        return new StorageDeviceInfo(BuildModel(vendor, product), CleanSerial(serial), busType, removable);
    }

    private static string? BuildModel(string? vendor, string? product)
    {
        // Detrás de la traducción SCSI los SATA informan "ATA" como fabricante: no aporta.
        var usefulVendor = vendor is null
                           || vendor.Equals("ATA", StringComparison.OrdinalIgnoreCase)
                           || vendor.Equals("NVMe", StringComparison.OrdinalIgnoreCase)
            ? null
            : vendor;
        var model = usefulVendor is not null
                    && (product is null || !product.StartsWith(usefulVendor, StringComparison.OrdinalIgnoreCase))
            ? $"{usefulVendor} {product}"
            : product;
        return FirmwareText.Clean(model, 200);
    }

    private static string? CleanSerial(string? serial)
    {
        // NVMe suele informar el EUI-64 con punto final ("0025_3881_0000_0000.").
        return FirmwareText.Clean(serial?.Trim().TrimEnd('.').Trim(), 200);
    }

    private static string? ReadAnsiString(ReadOnlySpan<byte> buffer, int offset)
    {
        if (offset <= 0 || offset >= buffer.Length)
        {
            return null;
        }

        var slice = buffer[offset..];
        var end = slice.IndexOf((byte)0);
        var text = Encoding.Latin1.GetString(end < 0 ? slice : slice[..end]).Trim();
        return text.Length == 0 ? null : text;
    }

    internal static bool IsExcludedBus(int busType)
    {
        // USB, SD/MMC, 1394, iSCSI y discos virtuales (VHD, Storage Spaces) no son
        // hardware propio del equipo para el relevamiento.
        return busType is 4 or 7 or 9 or 12 or 13 or 14 or 15 or 16;
    }

    internal static string? BusTypeName(int busType)
    {
        return busType switch
        {
            1 => "SCSI",
            2 => "ATAPI",
            3 => "ATA",
            8 => "RAID",
            10 => "SAS",
            11 => "SATA",
            17 => "NVME",
            18 => "SCM",
            19 => "UFS",
            _ => null,
        };
    }

    private static byte[]? QueryProperty(SafeFileHandle handle, int propertyId)
    {
        // STORAGE_PROPERTY_QUERY: PropertyId, QueryType (0 = consulta estándar) y relleno.
        var query = new byte[12];
        BinaryPrimitives.WriteInt32LittleEndian(query.AsSpan(0, 4), propertyId);
        var output = new byte[1_024];
        if (!DeviceIoControl(handle, IoctlStorageQueryProperty, query, query.Length, output, output.Length, out var returned, IntPtr.Zero)
            || returned < 8)
        {
            return null;
        }

        var declaredSize = BinaryPrimitives.ReadInt32LittleEndian(output.AsSpan(4, 4));
        if (declaredSize > output.Length && declaredSize <= 65_536)
        {
            output = new byte[declaredSize];
            if (!DeviceIoControl(handle, IoctlStorageQueryProperty, query, query.Length, output, output.Length, out returned, IntPtr.Zero)
                || returned < 8)
            {
                return null;
            }
        }

        return output[..Math.Min(returned, output.Length)];
    }

    private static bool? ReadSeekPenalty(SafeFileHandle handle)
    {
        // DEVICE_SEEK_PENALTY_DESCRIPTOR: con penalidad de búsqueda = disco mecánico.
        var descriptor = QueryProperty(handle, StorageDeviceSeekPenaltyProperty);
        return descriptor is null || descriptor.Length < 9 ? null : descriptor[8] != 0;
    }

    private static long? ReadDiskSize(SafeFileHandle handle)
    {
        // DISK_GEOMETRY_EX: geometría (24 bytes) seguida del tamaño total en bytes.
        var output = new byte[256];
        if (!DeviceIoControl(handle, IoctlDiskGetDriveGeometryEx, null, 0, output, output.Length, out var returned, IntPtr.Zero)
            || returned < 32)
        {
            return null;
        }

        var size = BinaryPrimitives.ReadInt64LittleEndian(output.AsSpan(24, 8));
        return size > 0 ? Math.Min(size, MaximumSafeInteger) : null;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(
        SafeFileHandle device,
        uint ioControlCode,
        byte[]? inBuffer,
        int inBufferSize,
        [Out] byte[] outBuffer,
        int outBufferSize,
        out int bytesReturned,
        IntPtr overlapped);
}
