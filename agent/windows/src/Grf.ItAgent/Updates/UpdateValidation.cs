namespace Grf.ItAgent.Updates;

internal static class UpdateValidation
{
    public const int MaximumManifestBytes = 64 * 1024;
    public const int MaximumSignatureBytes = 16 * 1024;
    public const long MaximumPackageBytes = 512L * 1024 * 1024;
    public const long MaximumExecutableBytes = 256L * 1024 * 1024;

    public static bool IsValidChannel(string? value)
    {
        return value is { Length: >= 1 and <= 32 }
            && IsAsciiLower(value[0])
            && value.All(character => IsAsciiLower(character) || char.IsAsciiDigit(character) || character == '-');
    }

    private static bool IsAsciiLower(char value) => value is >= 'a' and <= 'z';
}
