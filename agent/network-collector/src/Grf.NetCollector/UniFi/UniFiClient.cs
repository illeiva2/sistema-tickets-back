using System.Net;
using System.Net.Security;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Grf.NetCollector.Configuration;
using Grf.NetCollector.Security;
using Grf.NetCollector.Storage;

namespace Grf.NetCollector.UniFi;

internal sealed class UniFiException(string message) : Exception(message);

/// <summary>
/// API clásica del UniFi Network Application autoalojado (puerto 8443) con un usuario local de
/// sólo lectura. La sesión se guarda entre corridas: loguearse en cada lectura llenaría el
/// registro del controlador de inicios de sesión.
/// </summary>
internal sealed class UniFiClient : IDisposable
{
    private readonly UniFiSection _settings;
    private readonly string _user;
    private readonly string _password;
    private readonly CollectorState _state;
    private readonly CookieContainer _cookies = new();
    private readonly HttpClient _http;
    private readonly Uri _base;

    public UniFiClient(UniFiSection settings, string user, string password, CollectorState state, CertificatePins pins)
    {
        _settings = settings;
        _user = user;
        _password = password;
        _state = state;
        _base = new Uri(settings.Url.TrimEnd('/') + "/");
        var endpoint = $"{_base.Host}:{_base.Port}";
        var handler = new SocketsHttpHandler
        {
            CookieContainer = _cookies,
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            SslOptions = new SslClientAuthenticationOptions
            {
                // Certificado autofirmado del controlador: vale si coincide con la huella anotada.
                RemoteCertificateValidationCallback = (_, certificate, _, errors) =>
                    certificate is not null
                    && (errors == SslPolicyErrors.None
                        || pins.Accept(endpoint, Convert.ToHexString(SHA256.HashData(certificate.GetRawCertData())), settings.CertificateSha256)),
            },
        };
        _http = new HttpClient(handler) { BaseAddress = _base, Timeout = TimeSpan.FromSeconds(60) };

        if (state.UniFi.SessionCookie is { Length: > 0 } session)
        {
            _cookies.Add(_base, new Cookie("unifises", session));
        }

        if (state.UniFi.CsrfToken is { Length: > 0 } csrf)
        {
            _cookies.Add(_base, new Cookie("csrf_token", csrf));
        }
    }

    /// <summary>Equipos del sitio (stat/device). Si la sesión guardada venció, se loguea una vez.</summary>
    public async Task<JsonElement> GetDevicesAsync(CancellationToken cancellationToken)
    {
        var path = $"api/s/{_settings.Site}/stat/device";
        var (status, body) = await SendAsync(HttpMethod.Get, path, null, cancellationToken).ConfigureAwait(false);
        if (status == HttpStatusCode.Unauthorized)
        {
            await LoginAsync(cancellationToken).ConfigureAwait(false);
            (status, body) = await SendAsync(HttpMethod.Get, path, null, cancellationToken).ConfigureAwait(false);
        }

        if (status != HttpStatusCode.OK || body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
        {
            throw new UniFiException($"el controlador respondió HTTP {(int)status} al pedir los equipos");
        }

        SaveSession();
        return data;
    }

    private async Task LoginAsync(CancellationToken cancellationToken)
    {
        // La sesión guardada venció: se descarta para no mandar cookies viejas con el login.
        foreach (Cookie cookie in _cookies.GetCookies(_base))
        {
            cookie.Expired = true;
        }

        var payload = JsonSerializer.Serialize(new { username = _user, password = _password, remember = true });
        var (status, body) = await SendAsync(HttpMethod.Post, "api/login", payload, cancellationToken).ConfigureAwait(false);
        var message = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("meta", out var meta) && meta.TryGetProperty("msg", out var msg)
            ? msg.GetString()
            : null;
        if (status != HttpStatusCode.OK)
        {
            throw new UniFiException(message == "api.err.Invalid"
                ? "el controlador rechazó el usuario o la clave"
                : $"el controlador rechazó el login (HTTP {(int)status}{(message is null ? "" : ", " + message)})");
        }
    }

    private async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(HttpMethod method, string path, string? json, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, path);
        if (json is not null)
        {
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }

        using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
            return (response.StatusCode, document.RootElement.Clone());
        }
        catch (JsonException)
        {
            return (response.StatusCode, default);
        }
    }

    private string? CookieValue(string name) => _cookies.GetCookies(_base)[name]?.Value;

    private void SaveSession()
    {
        _state.UniFi.SessionCookie = CookieValue("unifises");
        _state.UniFi.CsrfToken = CookieValue("csrf_token");
    }

    public void Dispose() => _http.Dispose();
}
