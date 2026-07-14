using System.Text.Json;

namespace Grf.ItAgent.Updates;

internal sealed record UpdateManifest(
    SemanticVersion Version,
    string Channel,
    Uri Url,
    string Sha256,
    long Size,
    DateTimeOffset PublishedAt,
    SemanticVersion MinAgentVersion);

internal static class UpdateManifestParser
{
    private static readonly HashSet<string> RequiredProperties = new(StringComparer.Ordinal)
    {
        "version",
        "channel",
        "url",
        "sha256",
        "size",
        "publishedAt",
        "minAgentVersion",
    };

    public static UpdateManifest Parse(ReadOnlySpan<byte> contents)
    {
        if (contents.IsEmpty || contents.Length > UpdateValidation.MaximumManifestBytes)
        {
            throw new InvalidDataException("El manifiesto tiene un tamaño inválido.");
        }

        try
        {
            using var document = JsonDocument.Parse(contents.ToArray(), new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 4,
            });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidDataException("El manifiesto debe ser un objeto JSON.");
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in root.EnumerateObject())
            {
                if (!RequiredProperties.Contains(property.Name) || !seen.Add(property.Name))
                {
                    throw new InvalidDataException("El manifiesto contiene propiedades desconocidas o duplicadas.");
                }
            }

            if (seen.Count != RequiredProperties.Count)
            {
                throw new InvalidDataException("Al manifiesto le faltan propiedades requeridas.");
            }

            var version = ParseVersion(GetRequiredString(root, "version", 100));
            var channel = GetRequiredString(root, "channel", 32);
            if (!UpdateValidation.IsValidChannel(channel))
            {
                throw new InvalidDataException("El canal del manifiesto no es válido.");
            }

            var urlText = GetRequiredString(root, "url", 2_048);
            if (!Uri.TryCreate(urlText, UriKind.Absolute, out var url) || !GithubUriPolicy.IsAllowed(url))
            {
                throw new InvalidDataException("La URL del paquete no está permitida.");
            }

            var sha256 = GetRequiredString(root, "sha256", 64);
            if (sha256.Length != 64 || sha256.Any(character => !char.IsAsciiHexDigit(character)))
            {
                throw new InvalidDataException("El SHA-256 del paquete no es válido.");
            }

            var sizeElement = root.GetProperty("size");
            if (sizeElement.ValueKind != JsonValueKind.Number
                || !sizeElement.TryGetInt64(out var size)
                || size is <= 0 or > UpdateValidation.MaximumPackageBytes)
            {
                throw new InvalidDataException("El tamaño del paquete no es válido.");
            }

            var publishedAtText = GetRequiredString(root, "publishedAt", 64);
            var publishedAtElement = root.GetProperty("publishedAt");
            if (!publishedAtText.EndsWith('Z')
                || !publishedAtElement.TryGetDateTimeOffset(out var publishedAt)
                || publishedAt.Offset != TimeSpan.Zero)
            {
                throw new InvalidDataException("publishedAt debe ser una fecha UTC válida.");
            }

            var minAgentVersion = ParseVersion(GetRequiredString(root, "minAgentVersion", 100));
            return new UpdateManifest(
                version,
                channel,
                url,
                sha256.ToLowerInvariant(),
                size,
                publishedAt,
                minAgentVersion);
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("El manifiesto JSON no es válido.", exception);
        }
    }

    private static string GetRequiredString(JsonElement root, string propertyName, int maximumLength)
    {
        var element = root.GetProperty(propertyName);
        if (element.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException($"{propertyName} debe ser texto.");
        }

        var value = element.GetString();
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > maximumLength
            || !string.Equals(value, value.Trim(), StringComparison.Ordinal))
        {
            throw new InvalidDataException($"{propertyName} no es válido.");
        }

        return value;
    }

    private static SemanticVersion ParseVersion(string value)
    {
        if (!SemanticVersion.TryParse(value, out var version))
        {
            throw new InvalidDataException("El manifiesto contiene una versión semántica inválida.");
        }

        return version!;
    }
}
