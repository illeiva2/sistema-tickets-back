using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using Grf.NetCollector.Configuration;
using Grf.NetCollector.Contracts;
using Grf.NetCollector.Polling;

namespace Grf.NetCollector.RouterOs;

/// <summary>Lo leído por la API de RouterOS, tal cual vino (una lista de filas por comando).</summary>
internal sealed class RouterOsReadout
{
    public Dictionary<string, string>? Identity { get; init; }
    public Dictionary<string, string>? Resource { get; init; }
    public Dictionary<string, string>? RouterBoard { get; init; }
    public IReadOnlyList<Dictionary<string, string>> Interfaces { get; init; } = [];
    public IReadOnlyList<Dictionary<string, string>> Ethernet { get; init; } = [];
    public IReadOnlyList<Dictionary<string, string>> Monitor { get; init; } = [];
    public IReadOnlyList<Dictionary<string, string>> BridgePorts { get; init; } = [];
    public IReadOnlyList<Dictionary<string, string>> Bonds { get; init; } = [];
    public IReadOnlyList<Dictionary<string, string>> Neighbors { get; init; } = [];
    public IReadOnlyList<Dictionary<string, string>> BridgeHosts { get; init; } = [];
    public IReadOnlyList<Dictionary<string, string>> Arp { get; init; } = [];
    public IReadOnlyList<Dictionary<string, string>> Vlans { get; init; } = [];
    public IReadOnlyList<Dictionary<string, string>> DhcpLeases { get; init; } = [];
}

/// <summary>Traduce lo leído de un MikroTik al contrato del back. Sin red: se prueba con datos fijos.</summary>
internal static partial class RouterOsMapping
{
    private const int MaxNeighborsPerPort = 16;

    public static PollResult Build(DeviceEntry entry, RouterOsReadout readout, long elapsedMs)
    {
        // Nombre visible (renombrable, "ether10-UNIFI") → nombre de fábrica ("ether10"), que es la clave.
        var defaultNameByName = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var row in readout.Ethernet)
        {
            if (Get(row, "name") is { } name)
            {
                defaultNameByName[name] = Get(row, "default-name") ?? name;
            }
        }

        var monitorByName = readout.Monitor
            .Where(row => Get(row, "name") is not null)
            .GroupBy(row => Get(row, "name")!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

        // Miembros de cada bond: la tabla MAC y el PVID se informan sobre el bond, no sobre los puertos.
        var bondMembers = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        foreach (var bond in readout.Bonds)
        {
            if (Get(bond, "name") is { } bondName)
            {
                bondMembers[bondName] = (Get(bond, "slaves") ?? "")
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Where(defaultNameByName.ContainsKey)
                    .Select(member => defaultNameByName[member])
                    .ToList();
            }
        }

        var pvidByInterface = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var row in readout.BridgePorts)
        {
            if (Get(row, "interface") is { } iface && int.TryParse(Get(row, "pvid"), NumberStyles.None, CultureInfo.InvariantCulture, out var pvid))
            {
                pvidByInterface[iface] = pvid;
            }
        }

        var pvidByPort = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (iface, pvid) in pvidByInterface)
        {
            if (defaultNameByName.TryGetValue(iface, out var key))
            {
                pvidByPort[key] = pvid;
            }
            else if (bondMembers.TryGetValue(iface, out var members))
            {
                foreach (var member in members)
                {
                    pvidByPort.TryAdd(member, pvid);
                }
            }
        }

        var neighborsByPort = BuildNeighbors(readout.Neighbors, defaultNameByName);

        var ports = new List<PortSnapshot>();
        foreach (var row in readout.Ethernet)
        {
            if (Get(row, "name") is not { } name)
            {
                continue;
            }

            var key = defaultNameByName[name];
            var (kind, position) = PortKinds.FromRouterOsDefaultName(key);
            monitorByName.TryGetValue(name, out var monitor);
            var linkUp = Get(monitor, "status") is { } status ? status == "link-ok" : Get(row, "running") == "true";
            ports.Add(new PortSnapshot
            {
                Key = key,
                Name = name,
                Description = Get(row, "comment"),
                Position = position,
                Kind = kind,
                AdminUp = Get(row, "disabled") != "true",
                LinkUp = linkUp,
                SpeedMbps = linkUp ? ParseRate(Get(monitor, "rate")) : null,
                FullDuplex = linkUp && Get(monitor, "full-duplex") is { } duplex ? duplex == "true" : null,
                Pvid = pvidByPort.TryGetValue(key, out var pvid) ? pvid : null,
                Neighbors = neighborsByPort.TryGetValue(key, out var neighbors) ? neighbors : null,
            });
        }

        ports.Sort((left, right) => left.Position != right.Position
            ? left.Position.CompareTo(right.Position)
            : string.CompareOrdinal(left.Key, right.Key));

        var macs = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in readout.Interfaces)
        {
            if (Mac.Normalize(Get(row, "mac-address")) is { } mac)
            {
                macs.Add(mac);
            }
        }

        var firstPortMac = ports
            .Select(port => readout.Ethernet.FirstOrDefault(row => Get(row, "name") == port.Name))
            .Select(row => Mac.Normalize(Get(row, "mac-address")))
            .FirstOrDefault(mac => mac is not null);

        var snapshot = new DeviceSnapshot
        {
            Key = entry.Ip,
            Source = "routeros",
            Role = entry.Role,
            Reachable = true,
            PollMs = (int)Math.Min(elapsedMs, int.MaxValue),
            Name = Get(readout.Identity, "name"),
            ManagementIp = entry.Ip,
            MacAddress = firstPortMac,
            Vendor = "MikroTik",
            Model = Get(readout.RouterBoard, "model") ?? Get(readout.Resource, "board-name"),
            Firmware = Get(readout.Resource, "version") is { } version ? "RouterOS " + version : null,
            SerialNumber = Get(readout.RouterBoard, "serial-number"),
            UptimeSeconds = ParseUptime(Get(readout.Resource, "uptime")),
            Ports = ports,
        };

        var vlanIds = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var row in readout.Vlans)
        {
            if (Get(row, "name") is { } vlanName && int.TryParse(Get(row, "vlan-id"), NumberStyles.None, CultureInfo.InvariantCulture, out var vlanId))
            {
                vlanIds[vlanName] = vlanId;
            }
        }

        var portByMac = readout.Ethernet
            .Select(row => (Mac: Mac.Normalize(Get(row, "mac-address")), Name: Get(row, "name")))
            .Where(item => item.Mac is not null && item.Name is not null)
            .GroupBy(item => item.Mac!, StringComparer.Ordinal)
            .Where(group => group.Count() == 1)
            .ToDictionary(group => group.Key, group => defaultNameByName[group.First().Name!], StringComparer.Ordinal);

        return new PollResult
        {
            Snapshot = snapshot,
            Fdb = BuildFdb(readout.BridgeHosts, defaultNameByName, bondMembers),
            Macs = macs,
            PortByMac = portByMac,
            Arp = readout.Arp
                .Select(row => (Ip: Get(row, "address"), Mac: Mac.Normalize(Get(row, "mac-address")), Interface: Get(row, "interface")))
                .Where(item => item.Ip is not null && item.Mac is not null)
                .Select(item => new ArpEntry(item.Ip!, item.Mac!, item.Interface is not null && vlanIds.TryGetValue(item.Interface, out var vlan) ? vlan : null))
                .ToList(),
            Leases = readout.DhcpLeases
                .Select(row => new LeaseEntry(
                    Mac.Normalize(Get(row, "active-mac-address") ?? Get(row, "mac-address")) ?? "",
                    Get(row, "active-address") ?? Get(row, "address"),
                    Get(row, "host-name")))
                .Where(lease => lease.Mac.Length > 0)
                .ToList(),
        };
    }

    private static Dictionary<string, List<NeighborSnapshot>> BuildNeighbors(
        IReadOnlyList<Dictionary<string, string>> rows,
        IReadOnlyDictionary<string, string> defaultNameByName)
    {
        var result = new Dictionary<string, List<NeighborSnapshot>>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            // "ether10-UNIFI,bridge": el primero es el puerto físico. Si es una VLAN o el bridge,
            // el vecino no está en un puerto de este equipo (MNDP cruza toda la VLAN).
            var local = (Get(row, "interface") ?? "").Split(',')[0].Trim();
            if (!defaultNameByName.TryGetValue(local, out var portKey))
            {
                continue;
            }

            var platform = Get(row, "platform");
            var protocol = platform switch
            {
                "MikroTik" => NeighborProtocols.Mndp,
                { } vendor when vendor.Contains("Cisco", StringComparison.OrdinalIgnoreCase) => NeighborProtocols.Cdp,
                _ => NeighborProtocols.Lldp,
            };

            var neighbor = new NeighborSnapshot
            {
                Protocol = protocol,
                Name = Get(row, "identity"),
                Mac = Mac.Normalize(Get(row, "mac-address")),
                Ip = FirstIpv4(Get(row, "address4"), Get(row, "address")),
                Port = Get(row, "interface-name"),
                Platform = string.Join(' ', new[] { platform, Get(row, "board") }.Where(part => !string.IsNullOrWhiteSpace(part))) is { Length: > 0 } text ? text : null,
            };

            if (!result.TryGetValue(portKey, out var list))
            {
                result[portKey] = list = [];
            }

            if (!list.Any(existing => existing.Mac == neighbor.Mac && existing.Name == neighbor.Name))
            {
                list.Add(neighbor);
            }
        }

        // Primero los vecinos directos (LLDP/CDP); los de MNDP pueden venir de toda la VLAN.
        foreach (var (key, list) in result.ToList())
        {
            result[key] = list
                .OrderBy(neighbor => neighbor.Protocol == NeighborProtocols.Mndp ? 1 : 0)
                .Take(MaxNeighborsPerPort)
                .ToList();
        }

        return result;
    }

    private static List<FdbEntry> BuildFdb(
        IReadOnlyList<Dictionary<string, string>> hosts,
        IReadOnlyDictionary<string, string> defaultNameByName,
        IReadOnlyDictionary<string, IReadOnlyList<string>> bondMembers)
    {
        var entries = new List<FdbEntry>();
        foreach (var row in hosts)
        {
            if (Get(row, "local") == "true" || Mac.Normalize(Get(row, "mac-address")) is not { } mac)
            {
                continue;
            }

            var on = Get(row, "on-interface") ?? Get(row, "interface");
            IReadOnlyList<string>? ports = on is null
                ? null
                : defaultNameByName.TryGetValue(on, out var key)
                    ? [key]
                    : bondMembers.TryGetValue(on, out var members) && members.Count > 0 ? members : null;
            if (ports is null)
            {
                continue;
            }

            int? vlan = int.TryParse(Get(row, "vid"), NumberStyles.None, CultureInfo.InvariantCulture, out var vid) ? vid : null;
            entries.Add(new FdbEntry(mac, ports, vlan));
        }

        return entries;
    }

    /// <summary>"10Mbps", "1Gbps", "2.5Gbps" → Mb/s.</summary>
    public static int? ParseRate(string? rate)
    {
        if (rate is null)
        {
            return null;
        }

        var match = RateFormat().Match(rate);
        if (!match.Success)
        {
            return null;
        }

        var value = double.Parse(match.Groups["value"].Value, CultureInfo.InvariantCulture);
        return (int)Math.Round(match.Groups["unit"].Value.Equals("G", StringComparison.OrdinalIgnoreCase) ? value * 1000 : value);
    }

    /// <summary>"4w6d16h34m21s" → segundos.</summary>
    public static long? ParseUptime(string? uptime)
    {
        if (string.IsNullOrWhiteSpace(uptime))
        {
            return null;
        }

        long total = 0;
        var any = false;
        foreach (Match part in UptimePart().Matches(uptime))
        {
            any = true;
            var amount = long.Parse(part.Groups["amount"].Value, CultureInfo.InvariantCulture);
            total += part.Groups["unit"].Value switch
            {
                "w" => amount * 604_800,
                "d" => amount * 86_400,
                "h" => amount * 3_600,
                "m" => amount * 60,
                _ => amount,
            };
        }

        return any ? total : null;
    }

    private static string? FirstIpv4(params string?[] candidates)
    {
        foreach (var candidate in candidates)
        {
            if (IPAddress.TryParse(candidate, out var address) && address.AddressFamily == AddressFamily.InterNetwork)
            {
                return candidate;
            }
        }

        return null;
    }

    private static string? Get(Dictionary<string, string>? row, string key) =>
        row is not null && row.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;

    [GeneratedRegex("^(?<value>\\d+(?:\\.\\d+)?)(?<unit>[MG])bps$", RegexOptions.IgnoreCase)]
    private static partial Regex RateFormat();

    [GeneratedRegex("(?<amount>\\d+)(?<unit>[wdhms])")]
    private static partial Regex UptimePart();
}
