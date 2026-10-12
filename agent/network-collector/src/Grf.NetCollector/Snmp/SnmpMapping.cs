using System.Globalization;
using System.Text.RegularExpressions;
using Grf.NetCollector.Configuration;
using Grf.NetCollector.Contracts;
using Grf.NetCollector.Polling;
using Lextm.SharpSnmpLib;

namespace Grf.NetCollector.Snmp;

/// <summary>Lo leído por SNMP: escalares por OID y columnas por OID → índice → valor.</summary>
internal sealed class SnmpReadout
{
    public IReadOnlyDictionary<string, ISnmpData> Scalars { get; init; } = new Dictionary<string, ISnmpData>();
    public IReadOnlyDictionary<string, Dictionary<string, ISnmpData>> Columns { get; init; } = new Dictionary<string, Dictionary<string, ISnmpData>>();

    public IReadOnlyDictionary<string, ISnmpData> Column(string oid) =>
        Columns.TryGetValue(oid, out var column) ? column : new Dictionary<string, ISnmpData>();
}

/// <summary>Traduce IF-MIB, BRIDGE/Q-BRIDGE, LLDP y ENTITY al contrato del back. Sin red.</summary>
internal static partial class SnmpMapping
{
    /// <summary>Puerto de un agregado que el equipo no detalla por SNMP (p. ej. "lag130" en SwOS).</summary>
    public const string LagPortPrefix = "lag";

    // ethernetCsmacd, iso88023Csmacd, fastEtherFX, gigabitEthernet.
    private static readonly HashSet<int> PhysicalTypes = [6, 7, 69, 117];
    private const int MaxNeighborsPerPort = 16;

    public static PollResult Build(DeviceEntry entry, SnmpReadout readout, long elapsedMs)
    {
        var sysDescr = Text(readout.Scalars.GetValueOrDefault(Oids.SysDescr));
        var sysObjectId = readout.Scalars.GetValueOrDefault(Oids.SysObjectId)?.ToString();
        var vendor = VendorFromObjectId(sysObjectId);
        var (model, firmware) = DescribeModel(
            sysDescr,
            FirstText(readout.Column(Oids.EntModelName)),
            FirstText(readout.Column(Oids.EntSoftwareRev)));

        // Puerto de bridge → ifIndex (la FDB, el PVID y a veces LLDP vienen por puerto de bridge).
        var ifIndexByBasePort = new Dictionary<int, int>();
        foreach (var (suffix, value) in readout.Column(Oids.BasePortIfIndex))
        {
            if (int.TryParse(suffix, NumberStyles.None, CultureInfo.InvariantCulture, out var basePort) && Number(value) is { } ifIndex)
            {
                ifIndexByBasePort[basePort] = (int)ifIndex;
            }
        }

        var bridgeIfIndexes = ifIndexByBasePort.Values.ToHashSet();
        var descr = TextByIfIndex(readout.Column(Oids.IfDescr));
        var names = TextByIfIndex(readout.Column(Oids.IfName));
        var types = NumberByIfIndex(readout.Column(Oids.IfType));

        var physical = descr.Keys
            .Where(ifIndex => types.TryGetValue(ifIndex, out var type) && PhysicalTypes.Contains((int)type))
            .Where(ifIndex => bridgeIfIndexes.Count == 0 || bridgeIfIndexes.Contains(ifIndex))
            .Where(ifIndex => !LooksVirtual(names.GetValueOrDefault(ifIndex) ?? descr.GetValueOrDefault(ifIndex)))
            .OrderBy(ifIndex => ifIndex)
            .ToList();
        var physicalSet = physical.ToHashSet();

        // Agregados (LAG): la FDB del uplink puede apuntar al LAG y no a sus puertos.
        var lagMembers = new Dictionary<int, List<int>>();
        foreach (var (suffix, value) in readout.Column(Oids.LagAttachedAggregator))
        {
            if (int.TryParse(suffix, NumberStyles.None, CultureInfo.InvariantCulture, out var member) && Number(value) is { } aggregator && aggregator > 0 && aggregator != member)
            {
                if (!lagMembers.TryGetValue((int)aggregator, out var list))
                {
                    lagMembers[(int)aggregator] = list = [];
                }

                list.Add(member);
            }
        }

        var aliases = TextByIfIndex(readout.Column(Oids.IfAlias));
        var speeds = NumberByIfIndex(readout.Column(Oids.IfSpeed));
        var highSpeeds = NumberByIfIndex(readout.Column(Oids.IfHighSpeed));
        var admin = NumberByIfIndex(readout.Column(Oids.IfAdminStatus));
        var oper = NumberByIfIndex(readout.Column(Oids.IfOperStatus));
        var duplex = NumberByIfIndex(readout.Column(Oids.DuplexStatus));
        var pvids = new Dictionary<int, int>();
        foreach (var (suffix, value) in readout.Column(Oids.QPvid))
        {
            if (int.TryParse(suffix, NumberStyles.None, CultureInfo.InvariantCulture, out var basePort)
                && ifIndexByBasePort.TryGetValue(basePort, out var ifIndex)
                && Number(value) is { } pvid and >= 1 and <= 4094)
            {
                pvids[ifIndex] = (int)pvid;
            }
        }

        var neighbors = BuildNeighbors(readout, physicalSet, names, descr, ifIndexByBasePort);

        var ports = new List<PortSnapshot>();
        var number = 0;
        foreach (var ifIndex in physical)
        {
            number++;
            var name = names.GetValueOrDefault(ifIndex) ?? descr.GetValueOrDefault(ifIndex) ?? ifIndex.ToString(CultureInfo.InvariantCulture);
            var linkUp = oper.GetValueOrDefault(ifIndex) == 1;
            int? speed = null;
            if (linkUp)
            {
                var high = highSpeeds.GetValueOrDefault(ifIndex);
                var bits = speeds.GetValueOrDefault(ifIndex);
                speed = high > 0 ? (int)high : bits > 0 ? (int)(bits / 1_000_000) : null;
            }

            bool? fullDuplex = null;
            if (linkUp && duplex.TryGetValue(ifIndex, out var duplexStatus))
            {
                fullDuplex = duplexStatus switch
                {
                    3 => true,
                    2 => false,
                    _ => null,
                };
            }

            var alias = aliases.GetValueOrDefault(ifIndex);
            ports.Add(new PortSnapshot
            {
                Key = ifIndex.ToString(CultureInfo.InvariantCulture),
                Name = name,
                Description = alias is not null && alias != name ? alias : null,
                Position = number,
                Kind = PortKinds.FromModel(model, number, name, speed),
                AdminUp = admin.GetValueOrDefault(ifIndex) != 2,
                LinkUp = linkUp,
                SpeedMbps = speed,
                FullDuplex = fullDuplex,
                Pvid = pvids.TryGetValue(ifIndex, out var pvid) ? pvid : null,
                Neighbors = neighbors.TryGetValue(ifIndex, out var list) ? list : null,
            });
        }

        var macs = new HashSet<string>(StringComparer.Ordinal);
        var baseMac = MacOf(readout.Scalars.GetValueOrDefault(Oids.BaseBridgeAddress));
        if (baseMac is not null)
        {
            macs.Add(baseMac);
        }

        var portMacs = new List<(string Mac, int IfIndex)>();
        foreach (var (suffix, value) in readout.Column(Oids.IfPhysAddress))
        {
            if (MacOf(value) is { } mac)
            {
                macs.Add(mac);
                if (int.TryParse(suffix, NumberStyles.None, CultureInfo.InvariantCulture, out var ifIndex) && physicalSet.Contains(ifIndex))
                {
                    portMacs.Add((mac, ifIndex));
                }
            }
        }

        // HPE y TP-Link usan la misma MAC en todos los puertos: ahí no sirve para ubicar un puerto.
        var portByMac = portMacs
            .GroupBy(item => item.Mac, StringComparer.Ordinal)
            .Where(group => group.Count() == 1)
            .ToDictionary(group => group.Key, group => group.First().IfIndex.ToString(CultureInfo.InvariantCulture), StringComparer.Ordinal);

        var snapshot = new DeviceSnapshot
        {
            Key = entry.Ip,
            Source = "snmp",
            Role = entry.Role,
            Reachable = true,
            PollMs = (int)Math.Min(elapsedMs, int.MaxValue),
            Name = Text(readout.Scalars.GetValueOrDefault(Oids.SysName)),
            ManagementIp = entry.Ip,
            MacAddress = baseMac ?? macs.FirstOrDefault(),
            Vendor = vendor,
            Model = model,
            Firmware = firmware,
            SerialNumber = FirstText(readout.Column(Oids.EntSerial)),
            UptimeSeconds = readout.Scalars.GetValueOrDefault(Oids.SysUpTime) is TimeTicks ticks ? ticks.ToUInt32() / 100 : null,
            Ports = ports,
        };

        return new PollResult
        {
            Snapshot = snapshot,
            Fdb = BuildFdb(readout, ifIndexByBasePort, physicalSet, lagMembers),
            Macs = macs,
            PortByMac = portByMac,
        };
    }

    private static Dictionary<int, List<NeighborSnapshot>> BuildNeighbors(
        SnmpReadout readout,
        IReadOnlySet<int> physical,
        IReadOnlyDictionary<int, string> names,
        IReadOnlyDictionary<int, string> descr,
        IReadOnlyDictionary<int, int> ifIndexByBasePort)
    {
        // Puerto local de LLDP → ifIndex: por nombre (TP-Link), por puerto de bridge (HPE) o tal cual.
        var byName = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var ifIndex in physical)
        {
            if (names.GetValueOrDefault(ifIndex) is { } name)
            {
                byName.TryAdd(name, ifIndex);
            }

            if (descr.GetValueOrDefault(ifIndex) is { } description)
            {
                byName.TryAdd(description, ifIndex);
            }
        }

        var portIds = readout.Column(Oids.LldpLocPortId);
        var portDescs = readout.Column(Oids.LldpLocPortDesc);
        int? LocalIfIndex(int localPort)
        {
            var key = localPort.ToString(CultureInfo.InvariantCulture);
            foreach (var label in new[] { Text(portIds.GetValueOrDefault(key)), Text(portDescs.GetValueOrDefault(key)) })
            {
                if (label is not null && byName.TryGetValue(label, out var named))
                {
                    return named;
                }
            }

            if (ifIndexByBasePort.TryGetValue(localPort, out var bridged) && physical.Contains(bridged))
            {
                return bridged;
            }

            return physical.Contains(localPort) ? localPort : null;
        }

        var managementIps = new Dictionary<(int, int), string>();
        foreach (var suffix in readout.Column(Oids.LldpRemManAddrIfSubtype).Keys)
        {
            // ….localPort.remIndex.1.4.a.b.c.d (IPv4).
            var parts = suffix.Split('.');
            if (parts.Length >= 8 && parts[^6] == "1" && parts[^5] == "4"
                && int.TryParse(parts[^8], NumberStyles.None, CultureInfo.InvariantCulture, out var localPort)
                && int.TryParse(parts[^7], NumberStyles.None, CultureInfo.InvariantCulture, out var remIndex))
            {
                managementIps.TryAdd((localPort, remIndex), string.Join('.', parts[^4..]));
            }
        }

        var chassisSubtypes = readout.Column(Oids.LldpRemChassisIdSubtype);
        var chassisIds = readout.Column(Oids.LldpRemChassisId);
        var portSubtypes = readout.Column(Oids.LldpRemPortIdSubtype);
        var remotePortIds = readout.Column(Oids.LldpRemPortId);
        var remotePortDescs = readout.Column(Oids.LldpRemPortDesc);
        var sysNames = readout.Column(Oids.LldpRemSysName);
        var sysDescs = readout.Column(Oids.LldpRemSysDesc);

        var result = new Dictionary<int, List<NeighborSnapshot>>();
        foreach (var suffix in chassisIds.Keys)
        {
            // El índice es [timeMark.]localPort.remIndex: algunos TP-Link omiten el timeMark.
            var parts = suffix.Split('.');
            if (parts.Length < 2
                || !int.TryParse(parts[^2], NumberStyles.None, CultureInfo.InvariantCulture, out var localPort)
                || !int.TryParse(parts[^1], NumberStyles.None, CultureInfo.InvariantCulture, out var remIndex)
                || LocalIfIndex(localPort) is not { } ifIndex)
            {
                continue;
            }

            var chassis = chassisIds[suffix];
            var chassisSubtype = Number(chassisSubtypes.GetValueOrDefault(suffix));
            var portSubtype = Number(portSubtypes.GetValueOrDefault(suffix));
            var remotePort = Text(remotePortDescs.GetValueOrDefault(suffix))
                ?? (portSubtype == 3 ? MacOf(remotePortIds.GetValueOrDefault(suffix)) : Text(remotePortIds.GetValueOrDefault(suffix)));

            var neighbor = new NeighborSnapshot
            {
                Protocol = NeighborProtocols.Lldp,
                Name = Text(sysNames.GetValueOrDefault(suffix)),
                Mac = chassisSubtype == 4 || chassisSubtype is null ? MacOf(chassis) : null,
                Ip = managementIps.GetValueOrDefault((localPort, remIndex)) ?? (chassisSubtype == 5 ? NetworkAddress(chassis) : null),
                Port = remotePort,
                Platform = FirstLine(Text(sysDescs.GetValueOrDefault(suffix))),
            };

            if (!result.TryGetValue(ifIndex, out var list))
            {
                result[ifIndex] = list = [];
            }

            if (list.Count < MaxNeighborsPerPort)
            {
                list.Add(neighbor);
            }
        }

        return result;
    }

    private static List<FdbEntry> BuildFdb(
        SnmpReadout readout,
        IReadOnlyDictionary<int, int> ifIndexByBasePort,
        IReadOnlySet<int> physical,
        IReadOnlyDictionary<int, List<int>> lagMembers)
    {
        var ordered = physical.Order().ToList();

        IReadOnlyList<string>? PortsOf(int basePort)
        {
            if (ifIndexByBasePort.TryGetValue(basePort, out var ifIndex))
            {
                if (physical.Contains(ifIndex))
                {
                    return [ifIndex.ToString(CultureInfo.InvariantCulture)];
                }

                return lagMembers.TryGetValue(ifIndex, out var members)
                    ? members.Where(physical.Contains).Select(member => member.ToString(CultureInfo.InvariantCulture)).ToList()
                    : null;
            }

            // Algunos TP-Link numeran la tabla MAC por puerto físico (1..N) aunque su tabla de puertos
            // de bridge use 49153 en adelante.
            if (basePort >= 1 && basePort <= ordered.Count)
            {
                return [ordered[basePort - 1].ToString(CultureInfo.InvariantCulture)];
            }

            // Agregados que el equipo no detalla (el SwOS los informa como 130, 131…): quedan como
            // "lag130" para que el enlace exista aunque no se sepa por cuáles puertos físicos va.
            return basePort > 0 ? [LagPortPrefix + basePort.ToString(CultureInfo.InvariantCulture)] : null;
        }

        var entries = new List<FdbEntry>();
        var qPorts = readout.Column(Oids.QFdbPort);
        var useQ = qPorts.Count > 0;
        var ports = useQ ? qPorts : readout.Column(Oids.FdbPort);
        var statuses = readout.Column(useQ ? Oids.QFdbStatus : Oids.FdbStatus);
        foreach (var (suffix, value) in ports)
        {
            // Se descartan invalid(2) y self(4). El SwOS informa casi todo lo aprendido como other(1).
            if (Number(statuses.GetValueOrDefault(suffix)) is 2 or 4)
            {
                continue;
            }

            var parts = suffix.Split('.');
            if (Mac.FromOidSuffix(parts) is not { } mac || Number(value) is not { } basePort || PortsOf((int)basePort) is not { Count: > 0 } portKeys)
            {
                continue;
            }

            int? vlan = useQ && parts.Length >= 7 && int.TryParse(parts[^7], NumberStyles.None, CultureInfo.InvariantCulture, out var fdbId) ? fdbId : null;
            entries.Add(new FdbEntry(mac, portKeys, vlan));
        }

        return entries;
    }

    public static string? VendorFromObjectId(string? objectId)
    {
        if (objectId is null || !objectId.StartsWith("1.3.6.1.4.1.", StringComparison.Ordinal))
        {
            return null;
        }

        var enterprise = objectId["1.3.6.1.4.1.".Length..].Split('.')[0];
        return enterprise switch
        {
            "14988" => "MikroTik",
            "11" or "25506" or "47196" => "HPE",
            "11863" => "TP-Link",
            "41112" or "4413" => "Ubiquiti",
            "9" => "Cisco",
            _ => null,
        };
    }

    /// <summary>Modelo y firmware a partir de sysDescr (y ENTITY-MIB si el equipo lo tiene).</summary>
    public static (string? Model, string? Firmware) DescribeModel(string? sysDescr, string? entityModel, string? entitySoftware)
    {
        var description = FirstLine(sysDescr);
        if (description is null)
        {
            return (entityModel, entitySoftware);
        }

        // "HPE OfficeConnect Switch 1920S 48G 4SFP JL382A, PD.02.23, Linux 3.6.5-…"
        if (description.StartsWith("HPE OfficeConnect Switch ", StringComparison.OrdinalIgnoreCase))
        {
            var parts = description.Split(", ");
            var model = "OfficeConnect " + parts[0]["HPE OfficeConnect Switch ".Length..];
            var firmware = parts.Length > 1 && parts[1].StartsWith("PD.", StringComparison.OrdinalIgnoreCase) ? parts[1] : entitySoftware;
            return (model, firmware);
        }

        // "CRS328-4C-20S-4S+ SwOS v2.13"
        var swos = SwOsDescription().Match(description);
        if (swos.Success)
        {
            return (swos.Groups["model"].Value, "SwOS " + swos.Groups["version"].Value);
        }

        // Los TP-Link de esta línea no informan el modelo, sólo la descripción comercial.
        if (description.Equals("JetStream 28-Port Gigabit Smart Switch with 24-Port PoE+", StringComparison.OrdinalIgnoreCase))
        {
            return ("TL-SG2428P", entitySoftware);
        }

        return (entityModel ?? (description.Length > 80 ? description[..80] : description), entitySoftware);
    }

    private static bool LooksVirtual(string? name) =>
        name is not null && (name.StartsWith("vlan", StringComparison.OrdinalIgnoreCase)
            || name.Contains("CPU", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("loopback", StringComparison.OrdinalIgnoreCase));

    private static Dictionary<int, string> TextByIfIndex(IReadOnlyDictionary<string, ISnmpData> column)
    {
        var result = new Dictionary<int, string>();
        foreach (var (suffix, value) in column)
        {
            if (int.TryParse(suffix, NumberStyles.None, CultureInfo.InvariantCulture, out var ifIndex) && Text(value) is { } text)
            {
                result[ifIndex] = text;
            }
        }

        return result;
    }

    private static Dictionary<int, long> NumberByIfIndex(IReadOnlyDictionary<string, ISnmpData> column)
    {
        var result = new Dictionary<int, long>();
        foreach (var (suffix, value) in column)
        {
            if (int.TryParse(suffix, NumberStyles.None, CultureInfo.InvariantCulture, out var ifIndex) && Number(value) is { } number)
            {
                result[ifIndex] = number;
            }
        }

        return result;
    }

    private static long? Number(ISnmpData? data) => data switch
    {
        Integer32 integer => integer.ToInt32(),
        Gauge32 gauge => gauge.ToUInt32(),
        Counter32 counter => counter.ToUInt32(),
        TimeTicks ticks => ticks.ToUInt32(),
        _ => null,
    };

    private static string? Text(ISnmpData? data)
    {
        if (data is not OctetString octets)
        {
            return null;
        }

        var raw = octets.GetRaw();
        var text = new string(System.Text.Encoding.UTF8.GetString(raw).Where(character => !char.IsControl(character)).ToArray()).Trim();
        return text.Length == 0 ? null : text;
    }

    private static string? FirstText(IReadOnlyDictionary<string, ISnmpData> column) =>
        column.Values.Select(Text).FirstOrDefault(text => text is not null);

    private static string? MacOf(ISnmpData? data) => data is OctetString octets ? Mac.FromBytes(octets.GetRaw()) : null;

    private static string? NetworkAddress(ISnmpData data)
    {
        // Subtipo networkAddress: primer byte = familia (1 = IPv4) y después la dirección.
        var raw = data is OctetString octets ? octets.GetRaw() : Array.Empty<byte>();
        return raw.Length == 5 && raw[0] == 1 ? string.Join('.', raw[1..].Select(b => b.ToString(CultureInfo.InvariantCulture))) : null;
    }

    private static string? FirstLine(string? text)
    {
        if (text is null)
        {
            return null;
        }

        var line = text.Split('\n', '\r')[0].Trim();
        return line.Length == 0 ? null : line.Length > 120 ? line[..120] : line;
    }

    [GeneratedRegex("^(?<model>\\S+) SwOS v?(?<version>[\\d.]+)", RegexOptions.IgnoreCase)]
    private static partial Regex SwOsDescription();
}
