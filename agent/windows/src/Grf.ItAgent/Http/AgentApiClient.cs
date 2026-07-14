using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Grf.ItAgent.Configuration;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Utilities;

namespace Grf.ItAgent.Http;

internal sealed class AgentApiClient : IDisposable
{
    private const int MaximumResponseBytes = 64 * 1024;
    private readonly HttpClient _client;
    private readonly Uri _enrollUri;
    private readonly Uri _heartbeatUri;
    private readonly TimeSpan _requestTimeout;
    private readonly int _maximumRetries;
    private readonly TimeSpan _baseDelay;
    private readonly TimeSpan _maximumDelay;

    public AgentApiClient(AgentConfiguration configuration)
    {
        var baseUri = ConfigurationLoader.GetBaseUri(configuration);
        _enrollUri = new Uri(baseUri, "api/agent/enroll");
        _heartbeatUri = new Uri(baseUri, "api/agent/heartbeat");
        _requestTimeout = TimeSpan.FromSeconds(configuration.RequestTimeoutSeconds);
        _maximumRetries = configuration.MaxRetries;
        _baseDelay = TimeSpan.FromSeconds(configuration.RetryBaseDelaySeconds);
        _maximumDelay = TimeSpan.FromSeconds(configuration.RetryMaxDelaySeconds);

        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            CheckCertificateRevocationList = true,
            UseCookies = false,
        };
        // No ServerCertificateCustomValidationCallback is installed: Windows performs normal
        // hostname, chain, expiration and trust validation and invalid certificates are rejected.
        _client = new HttpClient(handler, disposeHandler: true)
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        _client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        _client.DefaultRequestHeaders.UserAgent.ParseAdd($"GRF-ITAgent/{Telemetry.AgentVersion.Current}");
    }

    public async Task<EnrollResponse> EnrollAsync(EnrollRequest request, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(request, AgentJson.Options);
        try
        {
            using var response = await SendWithRetryAsync(
                () => CreateJsonRequest(HttpMethod.Post, _enrollUri, payload),
                cancellationToken).ConfigureAwait(false);
            EnsureSuccess(response);
            var result = await DeserializeEnvelopeAsync<EnrollResponse>(response, cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(result.DeviceId)
                || result.DeviceId.Length > 200
                || result.NextHeartbeatSeconds is < 1 or > 86_400)
            {
                throw new InvalidDataException("La respuesta de enrolamiento no es válida.");
            }

            return result;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
        }
    }

    public async Task<HeartbeatSendResult> SendHeartbeatAsync(
        DeviceCredentials credentials,
        HeartbeatRequest heartbeat,
        CancellationToken cancellationToken)
    {
        var payload = HeartbeatPayloadLimiter.Serialize(heartbeat);
        try
        {
            using var response = await SendWithRetryAsync(
                () => CreateHeartbeatRequest(credentials, payload.Bytes),
                cancellationToken).ConfigureAwait(false);
            EnsureSuccess(response);
            var result = await DeserializeEnvelopeAsync<HeartbeatResponse>(response, cancellationToken).ConfigureAwait(false);
            if (result.AcceptedAt == default
                || result.NextHeartbeatSeconds is < 1 or > 86_400
                || string.IsNullOrWhiteSpace(result.State)
                || result.State.Length > 100)
            {
                throw new InvalidDataException("La respuesta de heartbeat no es válida.");
            }

            return new HeartbeatSendResult(result, payload.InventoryIncluded);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload.Bytes);
        }
    }

    public void Dispose()
    {
        _client.Dispose();
    }

    private async Task<HttpResponseMessage> SendWithRetryAsync(
        Func<HttpRequestMessage> requestFactory,
        CancellationToken cancellationToken)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                using var request = requestFactory();
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(_requestTimeout);
                var response = await _client.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    timeout.Token).ConfigureAwait(false);
                if (attempt < _maximumRetries && IsTransient(response.StatusCode))
                {
                    var delay = GetRetryDelay(attempt, response);
                    response.Dispose();
                    await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                return response;
            }
            catch (HttpRequestException) when (attempt < _maximumRetries)
            {
                await Task.Delay(GetRetryDelay(attempt, null), cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && attempt < _maximumRetries)
            {
                await Task.Delay(GetRetryDelay(attempt, null), cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private HttpRequestMessage CreateHeartbeatRequest(DeviceCredentials credentials, byte[] payload)
    {
        var request = CreateJsonRequest(HttpMethod.Post, _heartbeatUri, payload);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credentials.Secret);
        if (!request.Headers.TryAddWithoutValidation("X-Agent-Device-Id", credentials.DeviceId))
        {
            request.Dispose();
            throw new InvalidDataException("No se pudo construir la cabecera del dispositivo.");
        }

        return request;
    }

    private static HttpRequestMessage CreateJsonRequest(HttpMethod method, Uri uri, byte[] payload)
    {
        return new HttpRequestMessage(method, uri)
        {
            Content = new ByteArrayContent(payload)
            {
                Headers = { ContentType = new MediaTypeHeaderValue("application/json") },
            },
        };
    }

    private static bool IsTransient(HttpStatusCode statusCode)
    {
        var numeric = (int)statusCode;
        return statusCode is HttpStatusCode.RequestTimeout
            || numeric is 425 or 429
            || numeric >= 500;
    }

    private TimeSpan GetRetryDelay(int attempt, HttpResponseMessage? response)
    {
        var calculated = RetryPolicy.GetDelay(attempt, _baseDelay, _maximumDelay, Random.Shared.NextDouble());
        var retryAfter = response?.Headers.RetryAfter;
        var requested = retryAfter?.Delta
            ?? (retryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
        if (requested is null || requested <= TimeSpan.Zero)
        {
            return calculated;
        }

        return requested > _maximumDelay ? _maximumDelay : requested.Value;
    }

    private static void EnsureSuccess(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw new AgentApiException(response.StatusCode);
        }
    }

    private static async Task<T> DeserializeEnvelopeAsync<T>(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
        where T : class
    {
        if (response.Content.Headers.ContentLength is > MaximumResponseBytes)
        {
            throw new InvalidDataException("La respuesta del servidor es demasiado grande.");
        }

        var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        if (bytes.Length is <= 0 or > MaximumResponseBytes)
        {
            throw new InvalidDataException("La respuesta del servidor tiene un tamaño inválido.");
        }

        return AgentResponseParser.DeserializeEnvelope<T>(bytes);
    }
}

internal sealed record HeartbeatSendResult(HeartbeatResponse Response, bool InventoryIncluded);

internal sealed class AgentApiException : Exception
{
    public AgentApiException(HttpStatusCode statusCode)
        : base("El servidor rechazó la solicitud del agente.")
    {
        StatusCode = statusCode;
    }

    public HttpStatusCode StatusCode { get; }
}
