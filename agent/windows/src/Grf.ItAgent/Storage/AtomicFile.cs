namespace Grf.ItAgent.Storage;

internal static class AtomicFile
{
    public static void WriteAllBytes(string path, ReadOnlySpan<byte> contents)
    {
        var fullPath = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(fullPath)
            ?? throw new IOException("El archivo no tiene un directorio válido.");
        if (!Directory.Exists(directory))
        {
            throw new DirectoryNotFoundException("El directorio de datos debe ser creado por el instalador.");
        }

        var temporaryPath = fullPath + ".tmp";
        try
        {
            using (var stream = new FileStream(
                       temporaryPath,
                       FileMode.Create,
                       FileAccess.Write,
                       FileShare.None,
                       bufferSize: 4_096,
                       FileOptions.WriteThrough))
            {
                stream.Write(contents);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temporaryPath, fullPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }
}
