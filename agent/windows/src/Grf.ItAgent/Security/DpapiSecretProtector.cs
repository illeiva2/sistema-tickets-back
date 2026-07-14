using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace Grf.ItAgent.Security;

internal sealed class DpapiSecretProtector
{
    private const int CryptProtectUiForbidden = 0x1;
    private const int CryptProtectLocalMachine = 0x4;
    private static readonly byte[] OptionalEntropy = Encoding.UTF8.GetBytes("GRF.ITAgent.credentials.v1");

    public byte[] Protect(ReadOnlySpan<byte> plaintext)
    {
        return Transform(plaintext, protect: true);
    }

    public byte[] Unprotect(ReadOnlySpan<byte> ciphertext)
    {
        return Transform(ciphertext, protect: false);
    }

    private static byte[] Transform(ReadOnlySpan<byte> input, bool protect)
    {
        if (input.IsEmpty)
        {
            throw new CryptographicException("DPAPI no admite datos vacíos para este almacén.");
        }

        var inputBytes = input.ToArray();
        var entropyBytes = OptionalEntropy.ToArray();
        var inputHandle = GCHandle.Alloc(inputBytes, GCHandleType.Pinned);
        var entropyHandle = GCHandle.Alloc(entropyBytes, GCHandleType.Pinned);
        var inputBlob = new DataBlob(inputBytes.Length, inputHandle.AddrOfPinnedObject());
        var entropyBlob = new DataBlob(entropyBytes.Length, entropyHandle.AddrOfPinnedObject());
        var outputBlob = default(DataBlob);
        IntPtr description = IntPtr.Zero;

        try
        {
            var succeeded = protect
                ? CryptProtectData(
                    ref inputBlob,
                    "GRF IT Agent device credential",
                    ref entropyBlob,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    CryptProtectUiForbidden | CryptProtectLocalMachine,
                    out outputBlob)
                : CryptUnprotectData(
                    ref inputBlob,
                    out description,
                    ref entropyBlob,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    CryptProtectUiForbidden,
                    out outputBlob);

            if (!succeeded)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DPAPI no pudo procesar la credencial.");
            }

            var result = new byte[outputBlob.Length];
            Marshal.Copy(outputBlob.Data, result, 0, outputBlob.Length);
            return result;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(inputBytes);
            CryptographicOperations.ZeroMemory(entropyBytes);
            inputHandle.Free();
            entropyHandle.Free();

            if (outputBlob.Data != IntPtr.Zero)
            {
                ZeroUnmanagedMemory(outputBlob.Data, outputBlob.Length);
                _ = LocalFree(outputBlob.Data);
            }

            if (description != IntPtr.Zero)
            {
                _ = LocalFree(description);
            }
        }
    }

    private static void ZeroUnmanagedMemory(IntPtr pointer, int length)
    {
        for (var index = 0; index < length; index++)
        {
            Marshal.WriteByte(pointer, index, 0);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct DataBlob
    {
        public DataBlob(int length, IntPtr data)
        {
            Length = length;
            Data = data;
        }

        public int Length { get; }
        public IntPtr Data { get; }
    }

    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(
        ref DataBlob dataIn,
        string description,
        ref DataBlob optionalEntropy,
        IntPtr reserved,
        IntPtr promptStructure,
        int flags,
        out DataBlob dataOut);

    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DataBlob dataIn,
        out IntPtr description,
        ref DataBlob optionalEntropy,
        IntPtr reserved,
        IntPtr promptStructure,
        int flags,
        out DataBlob dataOut);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
}
