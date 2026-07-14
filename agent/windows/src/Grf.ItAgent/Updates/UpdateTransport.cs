using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;

namespace Grf.ItAgent.Updates;

internal sealed record DownloadedUpdateFile(long Size, string Sha256);

internal interface IUpdateTransport : IDisposable
{
    Task<byte[]> GetBytesAsync(Uri uri, int maximumBytes, CancellationToken cancellationToken);

    Task<DownloadedUpdateFile> DownloadFileAsync(
        Uri uri,
        string destinationPath,
        long maximumBytes,
        CancellationToken cancellationToken);
}

internal sealed class GithubUpdateTransport : IUpdateTransport
{
    private const int MaximumRedirects = 5;
    private readonly HttpClient _client;

    public GithubUpdateTransport(TimeSpan timeout)
        : this(CreateHandler(), timeout)
    {
    }

    internal GithubUpdateTransport(HttpMessageHandler handler, TimeSpan timeout)
    {
        ArgumentNullException.ThrowIfNull(handler);
        if (timeout < TimeSpan.FromSeconds(5) || timeout > TimeSpan.FromMinutes(30))
        {
            throw new ArgumentOutOfRangeException(nameof(timeout));
        }

        _client = new HttpClient(handler, disposeHandler: true)
        {
            Timeout = timeout,
        };
        _client.DefaultRequestHeaders.UserAgent.ParseAdd("GRF-ITAgent-Updater/1.0");
        _client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
    }

    public async Task<byte[]> GetBytesAsync(Uri uri, int maximumBytes, CancellationToken cancellationToken)
    {
        if (maximumBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        }

        using var response = await SendFollowingRedirectsAsync(uri, cancellationToken).ConfigureAwait(false);
        ValidateResponseLength(response, maximumBytes);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var output = new MemoryStream(Math.Min(maximumBytes, 16 * 1024));
        var buffer = new byte[8 * 1024];
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                return output.ToArray();
            }

            if (output.Length + read > maximumBytes)
            {
                throw new UpdateTransportException("La respuesta excede el límite permitido.");
            }

            output.Write(buffer, 0, read);
        }
    }

    public async Task<DownloadedUpdateFile> DownloadFileAsync(
        Uri uri,
        string destinationPath,
        long maximumBytes,
        CancellationToken cancellationToken)
    {
        if (maximumBytes <= 0 || maximumBytes > UpdateValidation.MaximumPackageBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        }

        var fullPath = Path.GetFullPath(destinationPath);
        var directory = Path.GetDirectoryName(fullPath)
            ?? throw new IOException("El destino de descarga no tiene directorio.");
        if (!Directory.Exists(directory))
        {
            throw new DirectoryNotFoundException("El directorio de descarga no existe.");
        }

        try
        {
            using var response = await SendFollowingRedirectsAsync(uri, cancellationToken).ConfigureAwait(false);
            ValidateResponseLength(response, maximumBytes);
            await using var input = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            await using var output = new FileStream(
                fullPath,
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
                if (total > maximumBytes)
                {
                    throw new UpdateTransportException("El paquete excede el límite permitido.");
                }

                hash.AppendData(buffer.AsSpan(0, read));
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
            }

            await output.FlushAsync(cancellationToken).ConfigureAwait(false);
            output.Flush(flushToDisk: true);
            return new DownloadedUpdateFile(total, Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant());
        }
        catch
        {
            TryDelete(fullPath);
            throw;
        }
    }

    public void Dispose() => _client.Dispose();

    private static HttpClientHandler CreateHandler()
    {
        return new HttpClientHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            CheckCertificateRevocationList = true,
            PreAuthenticate = false,
            UseCookies = false,
            UseDefaultCredentials = false,
        };
    }

    private async Task<HttpResponseMessage> SendFollowingRedirectsAsync(Uri initialUri, CancellationToken cancellationToken)
    {
        var currentUri = initialUri;
        for (var redirects = 0; redirects <= MaximumRedirects; redirects++)
        {
            if (!GithubUriPolicy.IsAllowed(currentUri))
            {
                throw new UpdateSecurityException("La descarga intentó usar un destino no permitido.");
            }

            using var request = new HttpRequestMessage(HttpMethod.Get, currentUri);
            var response = await _client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);
            if (!IsRedirect(response.StatusCode))
            {
                if (!response.IsSuccessStatusCode)
                {
                    var statusCode = response.StatusCode;
                    response.Dispose();
                    throw new UpdateTransportException("GitHub rechazó la descarga.", statusCode);
                }

                if (response.Content.Headers.ContentEncoding.Count > 0)
                {
                    response.Dispose();
                    throw new UpdateTransportException("No se permiten respuestas HTTP transformadas.");
                }

                return response;
            }

            var location = response.Headers.Location;
            response.Dispose();
            if (location is null || redirects == MaximumRedirects)
            {
                throw new UpdateTransportException("La cadena de redirecciones de GitHub no es válida.");
            }

            currentUri = location.IsAbsoluteUri ? location : new Uri(currentUri, location);
        }

        throw new UpdateTransportException("Se excedió el límite de redirecciones.");
    }

    private static bool IsRedirect(HttpStatusCode statusCode)
    {
        return statusCode is HttpStatusCode.Moved
            or HttpStatusCode.Redirect
            or HttpStatusCode.RedirectMethod
            or HttpStatusCode.TemporaryRedirect
            or HttpStatusCode.PermanentRedirect;
    }

    private static void ValidateResponseLength(HttpResponseMessage response, long maximumBytes)
    {
        if (response.Content.Headers.ContentLength is { } contentLength && contentLength > maximumBytes)
        {
            throw new UpdateTransportException("La respuesta declara un tamaño superior al permitido.");
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch
        {
            // The partial file remains untrusted and is never referenced by an update plan.
        }
    }
}

internal sealed class UpdateTransportException : Exception
{
    public UpdateTransportException(string message)
        : base(message)
    {
    }

    public UpdateTransportException(string message, HttpStatusCode statusCode)
        : base(message)
    {
        StatusCode = statusCode;
    }

    public HttpStatusCode? StatusCode { get; }
}
