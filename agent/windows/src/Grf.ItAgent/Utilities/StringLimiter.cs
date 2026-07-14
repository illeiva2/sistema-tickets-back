namespace Grf.ItAgent.Utilities;

internal static class StringLimiter
{
    public static string LimitRequired(string? value, int maximumLength, string fallback)
    {
        return LimitOptional(value, maximumLength) ?? LimitOptional(fallback, maximumLength) ?? "unknown";
    }

    public static string? LimitOptional(string? value, int maximumLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var source = value.Trim();
        var characters = source.ToCharArray();
        for (var index = 0; index < characters.Length; index++)
        {
            if (char.IsControl(characters[index]))
            {
                characters[index] = ' ';
            }
        }

        var normalized = new string(characters).Trim();
        if (normalized.Length == 0)
        {
            return null;
        }
        if (normalized.Length <= maximumLength)
        {
            return normalized;
        }

        var length = maximumLength;
        if (length > 0 && char.IsHighSurrogate(normalized[length - 1]))
        {
            length--;
        }

        return normalized[..length];
    }
}
