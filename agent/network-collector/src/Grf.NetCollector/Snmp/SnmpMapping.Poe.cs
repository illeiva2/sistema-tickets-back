using System.Globalization;
using Grf.NetCollector.Contracts;

namespace Grf.NetCollector.Snmp;

/// <summary>PoE por puerto y del equipo: POWER-ETHERNET-MIB y las MIB de HPE y TP-Link.</summary>
internal static partial class SnmpMapping
{
    internal sealed record PoeReadout(IReadOnlyDictionary<int, PortPoeSnapshot> ByPort, double? BudgetW, double? UsedW);

    /// <summary>
    /// Los dos fabricantes numeran los puertos PoE como el frente del switch (1, 2, 3…), que es la
    /// posición del puerto físico en el contrato: así se cruzan con los puertos de IF-MIB.
    /// </summary>
    internal static PoeReadout ReadPoe(SnmpReadout readout, string? sysObjectId)
    {
        var ports = new Dictionary<int, PortPoeSnapshot>();

        // RFC 3621 (HPE): 1 disabled, 2 searching, 3 deliveringPower, 4 fault, 5 test, 6 otherFault.
        // La clase va de 1 (clase 0) a 5 (clase 4). La potencia sale de la MIB de HPE, en mW.
        var detection = ByPort(readout.Column(Oids.PethPortDetectionStatus));
        var classes = ByPort(readout.Column(Oids.PethPortClassification));
        var hpePowerMw = ByPort(readout.Column(Oids.HpePoePortPowerMw));
        foreach (var (port, status) in detection)
        {
            var on = status == 3;
            ports[port] = new PortPoeSnapshot
            {
                Status = status switch
                {
                    1 => PortPoeSnapshot.Disabled,
                    3 => PortPoeSnapshot.On,
                    4 or 6 => PortPoeSnapshot.Fault,
                    _ => PortPoeSnapshot.Off,
                },
                PowerW = on && hpePowerMw.TryGetValue(port, out var milliwatts) ? Math.Round(milliwatts / 1000.0, 1) : null,
                Class = on && classes.TryGetValue(port, out var rfcClass) && rfcClass is >= 1 and <= 9 ? (int)rfcClass - 1 : null,
            };
        }

        // TP-Link: estado 2 = entrega; habilitado 0 = apagado a mano; potencia en décimas de W; clase
        // 0 a 4 tal cual (7 = ninguna).
        var tpStatus = ByPort(readout.Column(Oids.TpLinkPoePortStatus));
        var tpEnabled = ByPort(readout.Column(Oids.TpLinkPoePortEnable));
        var tpPower = ByPort(readout.Column(Oids.TpLinkPoePortPower));
        var tpClass = ByPort(readout.Column(Oids.TpLinkPoePortClass));
        foreach (var (port, status) in tpStatus)
        {
            if (ports.ContainsKey(port))
            {
                continue;
            }

            var on = status == 2;
            ports[port] = new PortPoeSnapshot
            {
                Status = tpEnabled.TryGetValue(port, out var enabled) && enabled == 0
                    ? PortPoeSnapshot.Disabled
                    : on ? PortPoeSnapshot.On : PortPoeSnapshot.Off,
                PowerW = on && tpPower.TryGetValue(port, out var deciwatts) ? Math.Round(deciwatts / 10.0, 1) : null,
                Class = on && tpClass.TryGetValue(port, out var tpLinkClass) && tpLinkClass is >= 0 and <= 4 ? (int)tpLinkClass : null,
            };
        }

        double? budget = null;
        double? used = null;
        if (Number(readout.Column(Oids.PethMainPower).GetValueOrDefault("1")) is { } mainPower and > 0)
        {
            budget = mainPower;
            // RFC 3621 dice watts, pero el HPE 1920S informa el consumo en mW.
            var hpe = sysObjectId?.StartsWith(Oids.HpeEnterprise, StringComparison.Ordinal) == true;
            if (Number(readout.Column(Oids.PethMainConsumption).GetValueOrDefault("1")) is { } consumption)
            {
                used = hpe ? Math.Round(consumption / 1000.0, 1) : consumption;
            }
        }
        else if (Number(readout.Column(Oids.TpLinkPoeLimit).GetValueOrDefault("0")) is { } limit and > 0)
        {
            budget = Math.Round(limit / 10.0, 1);
            used = Number(readout.Column(Oids.TpLinkPoeConsumption).GetValueOrDefault("0")) is { } consumption
                ? Math.Round(consumption / 10.0, 1)
                : null;
        }

        return new PoeReadout(ports, budget, used);
    }

    /// <summary>Columna por número de puerto: "grupo.puerto" (sólo el grupo 1) o "puerto".</summary>
    private static Dictionary<int, long> ByPort(IReadOnlyDictionary<string, Lextm.SharpSnmpLib.ISnmpData> column)
    {
        var result = new Dictionary<int, long>();
        foreach (var (suffix, value) in column)
        {
            var parts = suffix.Split('.');
            if (parts.Length > 2 || (parts.Length == 2 && parts[0] != "1"))
            {
                continue;
            }

            if (int.TryParse(parts[^1], NumberStyles.None, CultureInfo.InvariantCulture, out var port) && Number(value) is { } number)
            {
                result[port] = number;
            }
        }

        return result;
    }
}
