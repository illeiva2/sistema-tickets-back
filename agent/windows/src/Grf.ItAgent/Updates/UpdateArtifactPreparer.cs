using System.IO.Compression;
using System.Security.Cryptography;

namespace Grf.ItAgent.Updates;

internal sealed record PreparedExecutable(long Size, string Sha256);

internal static class UpdateArtifactPreparer
{
    public static async Task<PreparedExecutable> PrepareAsync(
        string sourcePath,
        Uri sourceUri,
        string destinationPath,
        CancellationToken cancellationToken)
    {
        var sourceFullPath = Path.GetFullPath(sourcePath);
        var destinationFullPath = Path.GetFullPath(destinationPath);
        if (string.Equals(sourceFullPath, destinationFullPath, StringComparison.OrdinalIgnoreCase))
        {
            throw new IOException("El artefacto y el candidato deben ser archivos distintos.");
        }

        var temporaryPath = destinationFullPath + ".partial-" + Guid.NewGuid().ToString("N");
        try
        {
            await using var input = OpenPayloadStream(sourceFullPath, sourceUri, out var owner);
            using (owner)
            {
                var result = await CopyAndHashAsync(input, temporaryPath, cancellationToken).ConfigureAwait(false);
                ValidateWindowsX64Executable(temporaryPath);
                File.Move(temporaryPath, destinationFullPath, overwrite: true);
                return result;
            }
        }
        catch
        {
            TryDelete(temporaryPath);
            throw;
        }
    }

    public static async Task<PreparedExecutable> ValidateCandidateAsync(
        string path,
        long expectedSize,
        string expectedSha256,
        CancellationToken cancellationToken)
    {
        var fullPath = Path.GetFullPath(path);
        var file = new FileInfo(fullPath);
        if (!file.Exists || file.Length != expectedSize || file.Length is <= 0 or > UpdateValidation.MaximumExecutableBytes)
        {
            throw new InvalidDataException("El candidato no tiene el tamaño esperado.");
        }

        var result = await HashFileAsync(fullPath, cancellationToken).ConfigureAwait(false);
        if (!CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(result.Sha256),
                Convert.FromHexString(expectedSha256)))
        {
            throw new InvalidDataException("El candidato no tiene el SHA-256 esperado.");
        }

        ValidateWindowsX64Executable(fullPath);
        return result;
    }

    public static void ValidateWindowsX64Executable(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length < 512 || stream.Length > UpdateValidation.MaximumExecutableBytes)
        {
            throw new InvalidDataException("El candidato ejecutable tiene un tamaño inválido.");
        }

        Span<byte> dosHeader = stackalloc byte[64];
        stream.ReadExactly(dosHeader);
        if (dosHeader[0] != (byte)'M' || dosHeader[1] != (byte)'Z')
        {
            throw new InvalidDataException("El candidato no es un ejecutable PE.");
        }

        var peOffset = BitConverter.ToInt32(dosHeader[0x3c..0x40]);
        if (peOffset < 64 || peOffset > stream.Length - 26)
        {
            throw new InvalidDataException("El encabezado PE está fuera de rango.");
        }

        stream.Position = peOffset;
        Span<byte> peHeader = stackalloc byte[26];
        stream.ReadExactly(peHeader);
        if (peHeader[0] != (byte)'P'
            || peHeader[1] != (byte)'E'
            || peHeader[2] != 0
            || peHeader[3] != 0
            || BitConverter.ToUInt16(peHeader[4..6]) != 0x8664
            || BitConverter.ToUInt16(peHeader[24..26]) != 0x020b)
        {
            throw new InvalidDataException("El candidato no es un ejecutable PE32+ para x64.");
        }
    }

    private static Stream OpenPayloadStream(string sourcePath, Uri sourceUri, out IDisposable? owner)
    {
        var source = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        var path = sourceUri.AbsolutePath;
        if (path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
        {
            owner = null;
            return source;
        }

        if (path.EndsWith(".exe.gz", StringComparison.OrdinalIgnoreCase))
        {
            owner = source;
            return new GZipStream(source, CompressionMode.Decompress, leaveOpen: false);
        }

        if (path.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            var archive = new ZipArchive(source, ZipArchiveMode.Read, leaveOpen: false);
            try
            {
                if (archive.Entries.Count != 1
                    || !string.Equals(archive.Entries[0].FullName, "GRF.ITAgent.exe", StringComparison.Ordinal)
                    || archive.Entries[0].Length is <= 0 or > UpdateValidation.MaximumExecutableBytes)
                {
                    throw new InvalidDataException("El ZIP debe contener únicamente GRF.ITAgent.exe.");
                }

                owner = archive;
                return archive.Entries[0].Open();
            }
            catch
            {
                archive.Dispose();
                throw;
            }
        }

        source.Dispose();
        throw new InvalidDataException("El formato del artefacto de actualización no está permitido.");
    }

    private static async Task<PreparedExecutable> CopyAndHashAsync(
        Stream input,
        string destinationPath,
        CancellationToken cancellationToken)
    {
        await using var output = new FileStream(
            destinationPath,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            bufferSize: 64 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan | FileOptions.WriteThrough);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[64 * 1024];
        long total = 0;
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            total = checked(total + read);
            if (total > UpdateValidation.MaximumExecutableBytes)
            {
                throw new InvalidDataException("El ejecutable expandido excede el límite permitido.");
            }

            hash.AppendData(buffer.AsSpan(0, read));
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
        }

        await output.FlushAsync(cancellationToken).ConfigureAwait(false);
        output.Flush(flushToDisk: true);
        return new PreparedExecutable(total, Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant());
    }

    private static async Task<PreparedExecutable> HashFileAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 64 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[64 * 1024];
        long total = 0;
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            total = checked(total + read);
            if (total > UpdateValidation.MaximumExecutableBytes)
            {
                throw new InvalidDataException("El candidato excede el límite permitido durante la validación.");
            }

            hash.AppendData(buffer.AsSpan(0, read));
        }

        return new PreparedExecutable(total, Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant());
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch
        {
            // A partial candidate is never referenced by the atomic update plan.
        }
    }
}
