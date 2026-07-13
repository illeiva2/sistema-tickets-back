using System.Security.Cryptography;
using System.Text;

namespace Grf.ItAgent.Storage;

internal static class PlaintextTokenFile
{
    private const int MaximumTokenBytes = 16 * 1024;

    public static string Read(string path)
    {
        var file = new FileInfo(Path.GetFullPath(path));
        if (!file.Exists || file.Length is <= 0 or > MaximumTokenBytes)
        {
            throw new InvalidDataException("El archivo de enrolamiento no existe o tiene un tamaño inválido.");
        }

        if ((file.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException("El archivo de enrolamiento no puede ser un enlace.");
        }

        var bytes = File.ReadAllBytes(file.FullName);
        try
        {
            var token = Encoding.UTF8.GetString(bytes).Trim();
            if (token.Length != 43
                || token.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '_' and not '-'))
            {
                throw new InvalidDataException("El token de enrolamiento no es válido.");
            }

            return token;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    public static void WipeAndDelete(string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (!File.Exists(fullPath))
        {
            return;
        }

        var attributes = File.GetAttributes(fullPath);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException("No se elimina un token que sea un enlace.");
        }

        using (var stream = new FileStream(fullPath, FileMode.Open, FileAccess.Write, FileShare.None, 4_096, FileOptions.WriteThrough))
        {
            var zeros = new byte[4_096];
            var remaining = stream.Length;
            stream.Position = 0;
            while (remaining > 0)
            {
                var count = (int)Math.Min(zeros.Length, remaining);
                stream.Write(zeros, 0, count);
                remaining -= count;
            }

            stream.SetLength(0);
            stream.Flush(flushToDisk: true);
        }

        File.Delete(fullPath);
    }
}
