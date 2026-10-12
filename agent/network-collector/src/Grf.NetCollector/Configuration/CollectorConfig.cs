using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Grf.NetCollector.Configuration;

/// <summary>
/// Configuración del colector (appsettings.json en la carpeta de datos). Las claves de los
/// equipos y del back NO van acá: se nombran las variables de máquina que las tienen.
/// </summary>
internal sealed class CollectorConfig
{
    public const string DefaultDataDirectory = @"C:\ProgramData\GRF\NetCollector";

    public ApiSection Api { get; init; } = new();
    public string DataDirectory { get; init; } = DefaultDataDirectory;
    public int Parallelism { get; init; } = 6;
    public int DeviceTimeoutSeconds { get; init; } = 45;
    public RouterOsSection RouterOs { get; init; } = new();
    public SnmpSection Snmp { get; init; } = new();
    public UniFiSection? UniFi { get; init; }
    public EndpointsSection Endpoints { get; init; } = new();
    public List<DeviceEntry> Devices { get; init; } = [];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public static CollectorConfig Load(string path)
    {
        if (!File.Exists(path))
        {
            throw new ConfigurationException($"No existe la configuración {path}");
        }

        CollectorConfig? config;
        try
        {
            config = JsonSerializer.Deserialize<CollectorConfig>(File.ReadAllText(path), JsonOptions);
        }
        catch (JsonException exception)
        {
            throw new ConfigurationException($"La configuración no es un JSON válido: {exception.Message}");
        }

        if (config is null)
        {
            throw new ConfigurationException("La configuración está vacía");
        }

        var errors = config.Validate();
        if (errors.Count > 0)
        {
            throw new ConfigurationException(string.Join(Environment.NewLine, errors));
        }

        return config;
    }

    public IReadOnlyList<string> Validate()
    {
        var errors = new List<string>();
        if (!Uri.TryCreate(Api.BaseUrl, UriKind.Absolute, out var api) || api.Scheme != Uri.UriSchemeHttps)
        {
            errors.Add("Api.BaseUrl tiene que ser una URL https absoluta");
        }

        if (!Regex.IsMatch(Api.ClientSlug ?? "", "^[a-z0-9][a-z0-9-]{2,60}$"))
        {
            errors.Add("Api.ClientSlug: sólo minúsculas, números y guiones (3 a 61 caracteres)");
        }

        if (Parallelism is < 1 or > 32)
        {
            errors.Add("Parallelism tiene que estar entre 1 y 32");
        }

        if (DeviceTimeoutSeconds is < 5 or > 300)
        {
            errors.Add("DeviceTimeoutSeconds tiene que estar entre 5 y 300");
        }

        if (Devices.Count == 0)
        {
            errors.Add("Devices no puede estar vacío");
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var device in Devices)
        {
            if (!IPAddress.TryParse(device.Ip, out _))
            {
                errors.Add($"Devices: \"{device.Ip}\" no es una IP");
            }
            else if (!seen.Add(device.Ip))
            {
                errors.Add($"Devices: la IP {device.Ip} está repetida");
            }

            if (device.Driver is not (DeviceEntry.RouterOsDriver or DeviceEntry.SnmpDriver))
            {
                errors.Add($"Devices {device.Ip}: Driver tiene que ser \"routeros\" o \"snmp\"");
            }

            if (device.Role is not ("router" or "core" or "access"))
            {
                errors.Add($"Devices {device.Ip}: Role tiene que ser \"router\", \"core\" o \"access\"");
            }

            if (device.CertificateSha256 is { Length: > 0 } pin && !CertificatePinFormat.IsValid(pin))
            {
                errors.Add($"Devices {device.Ip}: CertificateSha256 tiene que ser un SHA-256 en hexadecimal");
            }
        }

        if (Endpoints.ExcludeVlans.Any(vlan => vlan is < 1 or > 4094))
        {
            errors.Add("Endpoints.ExcludeVlans: las VLAN van de 1 a 4094");
        }

        if (Endpoints.SharedPortThreshold is < 2 or > 100)
        {
            errors.Add("Endpoints.SharedPortThreshold tiene que estar entre 2 y 100");
        }

        if (UniFi is not null)
        {
            if (!Uri.TryCreate(UniFi.Url, UriKind.Absolute, out var unifi) || unifi.Scheme != Uri.UriSchemeHttps)
            {
                errors.Add("UniFi.Url tiene que ser una URL https absoluta");
            }

            if (!Regex.IsMatch(UniFi.Site ?? "", "^[A-Za-z0-9_-]{1,64}$"))
            {
                errors.Add("UniFi.Site no es un nombre de sitio válido");
            }

            if (UniFi.CertificateSha256 is { Length: > 0 } pin && !CertificatePinFormat.IsValid(pin))
            {
                errors.Add("UniFi.CertificateSha256 tiene que ser un SHA-256 en hexadecimal");
            }

            if (UniFi.EveryMinutes is < 1 or > 60)
            {
                errors.Add("UniFi.EveryMinutes tiene que estar entre 1 y 60");
            }
        }

        return errors;
    }
}

internal sealed class ApiSection
{
    public string BaseUrl { get; init; } = "";
    public string ClientSlug { get; init; } = "";
    public string SecretVariable { get; init; } = "GRF_RED_COLECTOR_SECRETO";
    /// <summary>Render puede tardar cerca de un minuto en despertar el back.</summary>
    public int TimeoutSeconds { get; init; } = 90;
}

internal sealed class RouterOsSection
{
    public string User { get; init; } = "grf-monitor";
    public string PasswordVariable { get; init; } = "GRF_RED_MIKROTIK_CLAVE";
    public int Port { get; init; } = 8729;
    public int TimeoutMs { get; init; } = 8000;
}

internal sealed class SnmpSection
{
    public string CommunityVariable { get; init; } = "GRF_RED_SNMP_COMMUNITY";
    public int TimeoutMs { get; init; } = 4000;
}

internal sealed class UniFiSection
{
    public string Url { get; init; } = "";
    public string Site { get; init; } = "default";
    public string UserVariable { get; init; } = "GRF_RED_UNIFI_USUARIO";
    public string PasswordVariable { get; init; } = "GRF_RED_UNIFI_CLAVE";
    public string? CertificateSha256 { get; init; }
    /// <summary>
    /// Cada cuánto se consulta el controlador: cada lectura trae ~25 KB por AP por el túnel a
    /// AWS, así que no se hace en todas las corridas.
    /// </summary>
    public int EveryMinutes { get; init; } = 5;
}

internal sealed class EndpointsSection
{
    public bool Enabled { get; init; } = true;
    /// <summary>VLANs cuyos equipos no se informan (p. ej. la de invitados): son datos de terceros.</summary>
    public List<int> ExcludeVlans { get; init; } = [];
    /// <summary>Desde cuántos equipos en un mismo puerto se lo marca como compartido.</summary>
    public int SharedPortThreshold { get; init; } = 3;
}

internal sealed class DeviceEntry
{
    public const string RouterOsDriver = "routeros";
    public const string SnmpDriver = "snmp";

    public string Ip { get; init; } = "";
    public string Driver { get; init; } = "";
    public string Role { get; init; } = "access";
    public string? CertificateSha256 { get; init; }
    /// <summary>Variable con la community de este equipo si no es la general.</summary>
    public string? CommunityVariable { get; init; }
}

internal sealed class ConfigurationException(string message) : Exception(message);

internal static class CertificatePinFormat
{
    public static string Normalize(string pin) => pin.Replace(":", "", StringComparison.Ordinal).Trim().ToLowerInvariant();

    public static bool IsValid(string pin) => Regex.IsMatch(Normalize(pin), "^[0-9a-f]{64}$");
}
