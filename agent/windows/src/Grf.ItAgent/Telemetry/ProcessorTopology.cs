using System.Buffers.Binary;
using System.Runtime.InteropServices;

namespace Grf.ItAgent.Telemetry;

// Núcleos físicos según el propio Windows (lo mismo que muestra el Administrador de
// tareas). Environment.ProcessorCount solo da procesadores lógicos (hilos).
internal static class ProcessorTopology
{
    private const int RelationProcessorCore = 0;
    private const int ErrorInsufficientBuffer = 122;
    private const uint MaximumBufferBytes = 4_194_304;

    public static int? CountPhysicalCores()
    {
        try
        {
            uint length = 0;
            if (GetLogicalProcessorInformationEx(RelationProcessorCore, null, ref length)
                || Marshal.GetLastPInvokeError() != ErrorInsufficientBuffer
                || length == 0
                || length > MaximumBufferBytes)
            {
                return null;
            }

            var buffer = new byte[length];
            return GetLogicalProcessorInformationEx(RelationProcessorCore, buffer, ref length)
                ? CountCoreRecords(buffer.AsSpan(0, (int)Math.Min(length, (uint)buffer.Length)))
                : null;
        }
        catch
        {
            return null;
        }
    }

    // Registros SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX de tamaño variable:
    // Relationship (DWORD) y Size (DWORD) encabezan cada uno.
    internal static int? CountCoreRecords(ReadOnlySpan<byte> buffer)
    {
        var cores = 0;
        var offset = 0;
        while (offset + 8 <= buffer.Length)
        {
            var relationship = BinaryPrimitives.ReadInt32LittleEndian(buffer.Slice(offset, 4));
            var size = BinaryPrimitives.ReadInt32LittleEndian(buffer.Slice(offset + 4, 4));
            if (size < 8 || offset + size > buffer.Length)
            {
                break;
            }

            if (relationship == RelationProcessorCore)
            {
                cores++;
            }

            offset += size;
        }

        return cores is > 0 and <= 1_024 ? cores : null;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetLogicalProcessorInformationEx(
        int relationshipType,
        [Out] byte[]? buffer,
        ref uint returnedLength);
}
