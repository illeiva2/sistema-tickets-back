using System.Globalization;
using System.Text.RegularExpressions;

namespace Grf.NetCollector.Polling;

/// <summary>
/// Tipo de cada puerto físico (cobre, SFP, SFP+, combo) y su orden en el frente del equipo,
/// para que la pantalla dibuje el panel como es.
/// </summary>
internal static partial class PortKinds
{
    public const string Copper = "copper";
    public const string Sfp = "sfp";
    public const string SfpPlus = "sfpplus";
    public const string Combo = "combo";
    public const string Other = "other";

    // Las SFP+ van después de los puertos de cobre y de las SFP en el panel.
    private const int SfpOffset = 100;
    private const int SfpPlusOffset = 200;
    private const int OtherOffset = 300;

    /// <summary>RouterOS: el nombre de fábrica (default-name) dice el tipo y el número.</summary>
    public static (string Kind, int Position) FromRouterOsDefaultName(string defaultName)
    {
        var match = RouterOsName().Match(defaultName);
        if (!match.Success)
        {
            return (Other, OtherOffset);
        }

        var number = int.Parse(match.Groups["number"].Value, CultureInfo.InvariantCulture);
        return match.Groups["kind"].Value.ToLowerInvariant() switch
        {
            "ether" => (Copper, number),
            "combo" => (Combo, number),
            "sfp" => (Sfp, SfpOffset + number),
            "sfp-sfpplus" or "sfpplus" => (SfpPlus, SfpPlusOffset + number),
            _ => (Other, OtherOffset + number),
        };
    }

    /// <summary>
    /// SNMP no dice el tipo de jaula: se usa lo conocido de cada modelo y, si no se conoce, lo
    /// que sugieran el nombre y la velocidad. <paramref name="number"/> es 1..N en orden de ifIndex.
    /// </summary>
    public static string FromModel(string? model, int number, string name, int? speedMbps)
    {
        var known = model ?? "";
        if (known.Contains("JL382A", StringComparison.OrdinalIgnoreCase))
        {
            return number > 48 ? Sfp : Copper;
        }

        if (known.Contains("JL385A", StringComparison.OrdinalIgnoreCase) || known.Contains("JL381A", StringComparison.OrdinalIgnoreCase))
        {
            return number > 24 ? Sfp : Copper;
        }

        if (known.Contains("TL-SG2428P", StringComparison.OrdinalIgnoreCase))
        {
            return number > 24 ? Sfp : Copper;
        }

        if (known.Contains("CRS328-4C-20S-4S+", StringComparison.OrdinalIgnoreCase))
        {
            return number switch
            {
                <= 4 => Combo,
                <= 24 => Sfp,
                _ => SfpPlus,
            };
        }

        if (name.Contains("sfp", StringComparison.OrdinalIgnoreCase))
        {
            return speedMbps >= 10_000 ? SfpPlus : Sfp;
        }

        return speedMbps >= 10_000 ? SfpPlus : Copper;
    }

    [GeneratedRegex("^(?<kind>ether|combo|sfp-sfpplus|sfpplus|sfp|qsfpplus|qsfp)(?<number>\\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex RouterOsName();
}
