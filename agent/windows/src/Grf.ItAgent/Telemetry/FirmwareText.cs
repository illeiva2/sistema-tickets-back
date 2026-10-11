using Grf.ItAgent.Utilities;

namespace Grf.ItAgent.Telemetry;

// Los fabricantes dejan textos de relleno en el firmware ("To Be Filled By O.E.M.",
// "Default string", "0000000"). Para el relevamiento un relleno vale lo mismo que
// un dato ausente: se informa null y la UI muestra "No informado".
internal static class FirmwareText
{
    private static readonly string[] PlaceholderFragments =
    [
        "default string",
        "to be filled",
        "o.e.m.",
        "serial number",
        "system product name",
        "system manufacturer",
        "system version",
        "not specified",
        "not applicable",
        "not available",
        "sernum",
        "partnum",
        "manufacturer0",
        "0123456789",
        "123456789",
    ];

    private static readonly HashSet<string> PlaceholderValues = new(StringComparer.OrdinalIgnoreCase)
    {
        "none",
        "n/a",
        "na",
        "null",
        "oem",
        "unknown",
        "undefined",
        "invalid",
        "empty",
        "default",
        "x.x",
    };

    public static string? Clean(string? value, int maximumLength)
    {
        var normalized = StringLimiter.LimitOptional(value, maximumLength);
        return normalized is null || IsPlaceholder(normalized) ? null : normalized;
    }

    private static bool IsPlaceholder(string value)
    {
        if (PlaceholderValues.Contains(value))
        {
            return true;
        }

        // "00000000", "FFFFFFFF", "........": un único carácter repetido no identifica nada.
        if (value.Length > 1 && value.All(character => character == value[0]))
        {
            return true;
        }

        foreach (var fragment in PlaceholderFragments)
        {
            if (value.Contains(fragment, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }
}
