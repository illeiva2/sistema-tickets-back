using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Grf.NetCollector.Configuration;
using Grf.NetCollector.Contracts;

namespace Grf.NetCollector.Upload;

internal sealed record UploadResult(bool Ok, string Message);

/// <summary>
/// POST /api/network-collector/snapshot con la credencial de servicio. El cuerpo va comprimido
/// (gzip): sale por internet cada minuto. Reintenta ante errores de red, 408, 429 y 5xx; un 4xx
/// distinto (credencial o contrato) no se reintenta.
/// </summary>
internal sealed class SnapshotUploader(ApiSection settings, string secret)
{
    private const int Attempts = 3;

    public async Task<UploadResult> UploadAsync(SnapshotPayload payload, CancellationToken cancellationToken)
    {
        var body = Compress(JsonSerializer.SerializeToUtf8Bytes(payload, SnapshotJson.Options));
        using var handler = new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(20) };
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(settings.TimeoutSeconds) };
        var url = new Uri(new Uri(settings.BaseUrl.TrimEnd('/') + "/"), "api/network-collector/snapshot");

        var last = "sin intentos";
        for (var attempt = 1; attempt <= Attempts; attempt++)
        {
            TimeSpan? retryAfter = null;
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, url);
                request.Headers.Add("x-service-client", settings.ClientSlug);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
                request.Content.Headers.ContentEncoding.Add("gzip");

                using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
                var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                if (response.IsSuccessStatusCode)
                {
                    return new UploadResult(true, $"HTTP {(int)response.StatusCode}");
                }

                last = $"HTTP {(int)response.StatusCode} {ErrorCode(text)}".Trim();
                var retryable = response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests || (int)response.StatusCode >= 500;
                if (!retryable)
                {
                    return new UploadResult(false, last);
                }

                retryAfter = response.Headers.RetryAfter?.Delta;
            }
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
            {
                last = exception is TaskCanceledException ? "el back no respondió a tiempo" : $"error de red: {exception.Message}";
            }

            if (attempt < Attempts)
            {
                var wait = retryAfter ?? TimeSpan.FromSeconds(5 * attempt);
                await Task.Delay(wait < TimeSpan.FromSeconds(30) ? wait : TimeSpan.FromSeconds(30), cancellationToken).ConfigureAwait(false);
            }
        }

        return new UploadResult(false, last);
    }

    private static byte[] Compress(byte[] json)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
        {
            gzip.Write(json);
        }

        return output.ToArray();
    }

    /// <summary>Del sobre de error del back sólo se toma el código (nunca se vuelca el cuerpo).</summary>
    private static string ErrorCode(string body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            return document.RootElement.TryGetProperty("error", out var error) && error.TryGetProperty("code", out var code)
                ? code.GetString() ?? ""
                : "";
        }
        catch (JsonException)
        {
            return "";
        }
    }
}
