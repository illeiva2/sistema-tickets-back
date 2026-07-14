using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Grf.ItAgent.Updates;

namespace Grf.ItAgent.Configuration;

internal static class ConfigurationLoader
{
    private const int MaximumConfigBytes = 64 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    public static AgentConfiguration Load(string path)
    {
        var file = new FileInfo(Path.GetFullPath(path));
        if (!file.Exists || file.Length is <= 0 or > MaximumConfigBytes)
        {
            throw new ConfigurationException("El archivo de configuración no existe o tiene un tamaño inválido.");
        }

        AgentConfiguration configuration;
        try
        {
            using var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.Read);
            configuration = JsonSerializer.Deserialize<AgentConfiguration>(stream, JsonOptions)
                ?? throw new ConfigurationException("La configuración está vacía.");
        }
        catch (JsonException exception)
        {
            throw new ConfigurationException("La configuración JSON no es válida.", exception);
        }

        Validate(configuration);
        return configuration;
    }

    public static Uri GetBaseUri(AgentConfiguration configuration)
    {
        if (!Uri.TryCreate(configuration.BaseUrl, UriKind.Absolute, out var uri))
        {
            throw new ConfigurationException("baseUrl no es una URL absoluta.");
        }

        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new ConfigurationException("baseUrl debe usar HTTPS y no puede incluir credenciales, query ni fragmento.");
        }

        var normalized = uri.AbsoluteUri.EndsWith("/", StringComparison.Ordinal)
            ? uri.AbsoluteUri
            : uri.AbsoluteUri + "/";
        return new Uri(normalized, UriKind.Absolute);
    }

    public static string ResolveDataFile(string configPath, string fileName)
    {
        ValidateLocalFileName(fileName, nameof(fileName));
        var directory = Path.GetDirectoryName(Path.GetFullPath(configPath))
            ?? throw new ConfigurationException("La configuración no tiene un directorio válido.");
        return Path.Combine(directory, fileName);
    }

    private static void Validate(AgentConfiguration configuration)
    {
        _ = GetBaseUri(configuration);

        if (configuration.HeartbeatSeconds is < 30 or > 3_600)
        {
            throw new ConfigurationException("heartbeatSeconds debe estar entre 30 y 3600.");
        }

        if (configuration.InventoryIntervalMinutes is < 60 or > 10_080)
        {
            throw new ConfigurationException("inventoryIntervalMinutes debe estar entre 60 y 10080.");
        }

        if (configuration.RequestTimeoutSeconds is < 5 or > 120)
        {
            throw new ConfigurationException("requestTimeoutSeconds debe estar entre 5 y 120.");
        }

        if (configuration.MaxRetries is < 0 or > 8)
        {
            throw new ConfigurationException("maxRetries debe estar entre 0 y 8.");
        }

        if (configuration.RetryBaseDelaySeconds is < 1 or > 60
            || configuration.RetryMaxDelaySeconds < configuration.RetryBaseDelaySeconds
            || configuration.RetryMaxDelaySeconds > 300)
        {
            throw new ConfigurationException("Los límites de retry no son válidos.");
        }

        ValidateLocalFileName(configuration.EnrollmentTokenFile, nameof(configuration.EnrollmentTokenFile));
        ValidateLocalFileName(configuration.CredentialFile, nameof(configuration.CredentialFile));
        ValidateLocalFileName(configuration.StateFile, nameof(configuration.StateFile));
        ValidateLocalFileName(configuration.LogFile, nameof(configuration.LogFile));
        ValidateLocalFileName(configuration.LockFile, nameof(configuration.LockFile));

        var names = new[]
        {
            configuration.EnrollmentTokenFile,
            configuration.CredentialFile,
            configuration.StateFile,
            configuration.LogFile,
            configuration.LockFile,
        };
        if (names.Distinct(StringComparer.OrdinalIgnoreCase).Count() != names.Length)
        {
            throw new ConfigurationException("Los archivos de datos deben tener nombres distintos.");
        }

        ValidateUpdate(configuration.Update);
    }

    private static void ValidateUpdate(UpdateConfiguration update)
    {
        if (!UpdateValidation.IsValidChannel(update.Channel))
        {
            throw new ConfigurationException("update.channel no es válido.");
        }

        if (update.CheckIntervalMinutes is < 15 or > 10_080)
        {
            throw new ConfigurationException("update.checkIntervalMinutes debe estar entre 15 y 10080.");
        }

        if (!update.Enabled)
        {
            return;
        }

        if (!Uri.TryCreate(update.ManifestUrl, UriKind.Absolute, out var manifestUri)
            || !GithubUriPolicy.IsAllowed(manifestUri))
        {
            throw new ConfigurationException("update.manifestUrl debe ser una URL HTTPS permitida de GitHub.");
        }

        try
        {
            UpdateSignatureVerifier.ValidatePublicKey(update.PublicKeyPem);
        }
        catch (CryptographicException exception)
        {
            throw new ConfigurationException("update.publicKeyPem no es una clave pública RSA válida.", exception);
        }
    }

    private static void ValidateLocalFileName(string value, string property)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > 100
            || !string.Equals(value, Path.GetFileName(value), StringComparison.Ordinal)
            || value.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
            || value is "." or "..")
        {
            throw new ConfigurationException($"{property} debe ser un nombre de archivo local.");
        }
    }
}

internal sealed class ConfigurationException : Exception
{
    public ConfigurationException(string message)
        : base(message)
    {
    }

    public ConfigurationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
