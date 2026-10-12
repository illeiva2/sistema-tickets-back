using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;

namespace Grf.NetCollector.RouterOs;

internal sealed class RouterOsTrapException(string message) : Exception(message);

internal sealed class CertificateRejectedException(string message) : Exception(message);

/// <summary>
/// Cliente mínimo de la API clásica de RouterOS (v6 y v7) sobre TLS (api-ssl, 8729): palabras
/// con prefijo de largo y sentencias terminadas en una palabra vacía. El certificado de los
/// equipos es autofirmado, así que no se valida contra una CA: se compara su huella SHA-256 con
/// la anotada antes de mandar el usuario y la clave.
/// </summary>
internal sealed class RouterOsClient : IDisposable
{
    private readonly TcpClient _tcp;
    private readonly SslStream _ssl;

    private RouterOsClient(TcpClient tcp, SslStream ssl, string fingerprint)
    {
        _tcp = tcp;
        _ssl = ssl;
        Fingerprint = fingerprint;
    }

    public string Fingerprint { get; }

    public static RouterOsClient Connect(string host, int port, int timeoutMs, Func<string, bool> acceptFingerprint)
    {
        var tcp = new TcpClient();
        try
        {
            if (!tcp.ConnectAsync(host, port).Wait(timeoutMs))
            {
                throw new TimeoutException($"sin respuesta en el puerto {port}");
            }

            tcp.ReceiveTimeout = timeoutMs;
            tcp.SendTimeout = timeoutMs;
            string? fingerprint = null;
            var ssl = new SslStream(tcp.GetStream(), false, (_, certificate, _, _) =>
            {
                if (certificate is null)
                {
                    return false;
                }

                fingerprint = Convert.ToHexString(SHA256.HashData(certificate.GetRawCertData())).ToLowerInvariant();
                return acceptFingerprint(fingerprint);
            });

            try
            {
                ssl.AuthenticateAsClient(host);
            }
            catch (AuthenticationException) when (fingerprint is not null)
            {
                ssl.Dispose();
                throw new CertificateRejectedException(
                    $"el certificado de {host} ({fingerprint[..12]}…) no coincide con el anotado; no se mandó la clave");
            }

            return new RouterOsClient(tcp, ssl, fingerprint ?? "");
        }
        catch
        {
            tcp.Dispose();
            throw;
        }
    }

    public void Login(string user, string password)
    {
        var (_, done) = Run("/login", "=name=" + user, "=password=" + password);
        if (done.TryGetValue("ret", out var challenge))
        {
            // RouterOS anterior a 6.43: desafío MD5. Sólo se usa si el equipo lo pide.
            var bytes = new List<byte> { 0 };
            bytes.AddRange(Encoding.UTF8.GetBytes(password));
            bytes.AddRange(Convert.FromHexString(challenge));
            Run("/login", "=name=" + user, "=response=00" + Convert.ToHexString(MD5.HashData(bytes.ToArray())).ToLowerInvariant());
        }
    }

    public List<Dictionary<string, string>> Print(params string[] words) => Run(words).Rows;

    /// <summary>Igual que Print, pero un comando que el equipo no tiene (o no deja usar) da null.</summary>
    public List<Dictionary<string, string>>? TryPrint(params string[] words)
    {
        try
        {
            return Print(words);
        }
        catch (RouterOsTrapException)
        {
            return null;
        }
    }

    private (List<Dictionary<string, string>> Rows, Dictionary<string, string> Done) Run(params string[] words)
    {
        foreach (var word in words)
        {
            var bytes = Encoding.UTF8.GetBytes(word);
            WriteLength(bytes.Length);
            _ssl.Write(bytes);
        }

        WriteLength(0);
        _ssl.Flush();

        var rows = new List<Dictionary<string, string>>();
        string? trap = null;
        while (true)
        {
            var sentence = new List<string>();
            while (true)
            {
                var word = ReadWord();
                if (word.Length == 0)
                {
                    break;
                }

                sentence.Add(word);
            }

            if (sentence.Count == 0)
            {
                continue;
            }

            var attributes = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var word in sentence.Skip(1))
            {
                if (!word.StartsWith('='))
                {
                    continue;
                }

                var separator = word.IndexOf('=', 1);
                if (separator > 0)
                {
                    attributes[word[1..separator]] = word[(separator + 1)..];
                }
            }

            switch (sentence[0])
            {
                case "!re":
                    rows.Add(attributes);
                    break;
                case "!trap":
                    trap ??= attributes.GetValueOrDefault("message") ?? "error";
                    break;
                case "!fatal":
                    throw new IOException("el equipo cerró la sesión: " + string.Join(' ', sentence.Skip(1)));
                case "!done":
                    if (trap is not null)
                    {
                        throw new RouterOsTrapException(trap);
                    }

                    return (rows, attributes);
            }
        }
    }

    private void WriteLength(int length)
    {
        if (length < 0x80)
        {
            _ssl.WriteByte((byte)length);
        }
        else if (length < 0x4000)
        {
            var value = length | 0x8000;
            _ssl.Write([(byte)(value >> 8), (byte)value]);
        }
        else if (length < 0x200000)
        {
            var value = length | 0xC00000;
            _ssl.Write([(byte)(value >> 16), (byte)(value >> 8), (byte)value]);
        }
        else if (length < 0x10000000)
        {
            var value = length | unchecked((int)0xE0000000);
            _ssl.Write([(byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value]);
        }
        else
        {
            _ssl.Write([0xF0, (byte)(length >> 24), (byte)(length >> 16), (byte)(length >> 8), (byte)length]);
        }
    }

    private int ReadByteStrict()
    {
        var value = _ssl.ReadByte();
        return value >= 0 ? value : throw new IOException("el equipo cerró la conexión");
    }

    private int ReadLength()
    {
        var first = ReadByteStrict();
        if ((first & 0x80) == 0)
        {
            return first;
        }

        if ((first & 0xC0) == 0x80)
        {
            return ((first & 0x3F) << 8) | ReadByteStrict();
        }

        if ((first & 0xE0) == 0xC0)
        {
            return ((first & 0x1F) << 16) | (ReadByteStrict() << 8) | ReadByteStrict();
        }

        if ((first & 0xF0) == 0xE0)
        {
            return ((first & 0x0F) << 24) | (ReadByteStrict() << 16) | (ReadByteStrict() << 8) | ReadByteStrict();
        }

        return (ReadByteStrict() << 24) | (ReadByteStrict() << 16) | (ReadByteStrict() << 8) | ReadByteStrict();
    }

    private string ReadWord()
    {
        var length = ReadLength();
        if (length == 0)
        {
            return string.Empty;
        }

        var buffer = new byte[length];
        var read = 0;
        while (read < length)
        {
            var count = _ssl.Read(buffer, read, length - read);
            if (count <= 0)
            {
                throw new IOException("el equipo cerró la conexión");
            }

            read += count;
        }

        return Encoding.UTF8.GetString(buffer);
    }

    public void Dispose()
    {
        _ssl.Dispose();
        _tcp.Dispose();
    }
}
