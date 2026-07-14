namespace Grf.ItAgent.Updates;

internal static class GithubUriPolicy
{
    private static readonly HashSet<string> AllowedHosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "github.com",
        "objects.githubusercontent.com",
        "raw.githubusercontent.com",
        "release-assets.githubusercontent.com",
    };

    public static bool IsAllowed(Uri? uri)
    {
        return uri is { IsAbsoluteUri: true }
            && string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            && uri.Port == 443
            && string.IsNullOrEmpty(uri.UserInfo)
            && string.IsNullOrEmpty(uri.Fragment)
            && AllowedHosts.Contains(uri.IdnHost);
    }

    public static Uri GetDetachedSignatureUri(Uri manifestUri)
    {
        if (!IsAllowed(manifestUri))
        {
            throw new UpdateSecurityException("La URL del manifiesto no está permitida.");
        }

        var builder = new UriBuilder(manifestUri)
        {
            Path = manifestUri.AbsolutePath + ".sig",
        };
        var signatureUri = builder.Uri;
        if (!IsAllowed(signatureUri))
        {
            throw new UpdateSecurityException("La URL de la firma no está permitida.");
        }

        return signatureUri;
    }
}
