using System.Globalization;

namespace Grf.NetCollector.Polling;

internal static class Mac
{
    /// <summary>"74-4d-28…", "744d.282c…" o "74:4D:28…" → "74:4D:28:2C:B8:82"; lo que no es una MAC, null.</summary>
    public static string? Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        Span<char> hex = stackalloc char[12];
        var length = 0;
        foreach (var character in value)
        {
            if (character is ':' or '-' or '.' or ' ')
            {
                continue;
            }

            if (!char.IsAsciiHexDigit(character) || length == 12)
            {
                return null;
            }

            hex[length++] = char.ToUpperInvariant(character);
        }

        return length == 12 ? Format(hex) : null;
    }

    public static string? FromBytes(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length != 6)
        {
            return null;
        }

        Span<char> hex = stackalloc char[12];
        for (var index = 0; index < 6; index++)
        {
            bytes[index].TryFormat(hex[(index * 2)..], out _, "X2", CultureInfo.InvariantCulture);
        }

        return Format(hex);
    }

    /// <summary>MAC sacada del índice de una tabla SNMP: los últimos seis números del OID.</summary>
    public static string? FromOidSuffix(IReadOnlyList<string> parts)
    {
        if (parts.Count < 6)
        {
            return null;
        }

        var bytes = new byte[6];
        for (var index = 0; index < 6; index++)
        {
            if (!byte.TryParse(parts[parts.Count - 6 + index], NumberStyles.None, CultureInfo.InvariantCulture, out bytes[index]))
            {
                return null;
            }
        }

        return FromBytes(bytes);
    }

    private static string Format(ReadOnlySpan<char> hex) =>
        string.Create(17, hex.ToString(), static (span, text) =>
        {
            for (int source = 0, target = 0; source < 12; source += 2)
            {
                if (target > 0)
                {
                    span[target++] = ':';
                }

                span[target++] = text[source];
                span[target++] = text[source + 1];
            }
        });
}
