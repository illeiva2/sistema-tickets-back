using System.Globalization;
using Grf.NetCollector.Configuration;
using Grf.NetCollector.Contracts;
using Grf.NetCollector.Polling;
using Grf.NetCollector.Storage;

namespace Grf.NetCollector.Topology;

/// <summary>
/// Ubica cada equipo final (lo que no es router, switch ni AP) en el puerto de acceso donde está
/// conectado. Cada switch ve la MAC de un equipo en el puerto que lleva hacia él; descartando los
/// puertos que van a otros switches (enlaces deducidos y puertos donde aparece la MAC de otro
/// switch), queda el puerto de acceso. Si un equipo aparece en varios, gana el switch más profundo
/// del árbol. Las MACs que se ven en el puerto de un AP son clientes Wi-Fi de ese AP.
/// </summary>
internal static class EndpointInference
{
    private sealed record Candidate(string Device, string Port, int? Vlan, int Depth);

    public static List<EndpointSnapshot> Infer(
        IReadOnlyList<PollResult> devices,
        IReadOnlyList<CachedAp> cachedAps,
        IReadOnlyList<LinkSnapshot> links,
        EndpointsSection options)
    {
        if (!options.Enabled)
        {
            return [];
        }

        var excluded = options.ExcludeVlans.ToHashSet();
        var apKeys = devices.Where(device => device.Snapshot.Role == "ap").Select(device => device.Snapshot.Key)
            .Concat(cachedAps.Select(ap => ap.Key))
            .ToHashSet(StringComparer.Ordinal);

        // MACs de la infraestructura: no son equipos finales. Las de router y switches además
        // marcan los puertos que van hacia otro switch.
        var infraMacs = new HashSet<string>(StringComparer.Ordinal);
        var switchMacs = new HashSet<string>(StringComparer.Ordinal);
        foreach (var device in devices)
        {
            var isAp = device.Snapshot.Role == "ap";
            foreach (var mac in device.Macs)
            {
                infraMacs.Add(mac);
                if (!isAp)
                {
                    switchMacs.Add(mac);
                }
            }
        }

        foreach (var ap in cachedAps)
        {
            infraMacs.Add(ap.Mac);
        }

        var arp = devices.SelectMany(device => device.Arp).ToList();
        var arpByIp = arp.GroupBy(entry => entry.Ip, StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        foreach (var device in devices.Where(device => device.Snapshot.Role != "ap"))
        {
            if (device.Snapshot.ManagementIp is { } ip && arpByIp.TryGetValue(ip, out var entry))
            {
                infraMacs.Add(entry.Mac);
                switchMacs.Add(entry.Mac);
            }
        }

        var trunk = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        void Trunk(string device, IEnumerable<string> ports)
        {
            if (!trunk.TryGetValue(device, out var set))
            {
                trunk[device] = set = new HashSet<string>(StringComparer.Ordinal);
            }

            set.UnionWith(ports);
        }

        var apPorts = new Dictionary<(string Device, string Port), string>();
        foreach (var link in links)
        {
            var aIsAp = apKeys.Contains(link.A.Device);
            var bIsAp = apKeys.Contains(link.B.Device);
            if (!aIsAp && !bIsAp)
            {
                Trunk(link.A.Device, link.A.Ports);
                Trunk(link.B.Device, link.B.Ports);
            }
            else if (aIsAp != bIsAp)
            {
                var (switchEnd, ap) = aIsAp ? (link.B, link.A.Device) : (link.A, link.B.Device);
                foreach (var port in switchEnd.Ports)
                {
                    apPorts[(switchEnd.Device, port)] = ap;
                }
            }
        }

        foreach (var device in devices)
        {
            foreach (var entry in device.Fdb)
            {
                if (switchMacs.Contains(entry.Mac) && !device.Macs.Contains(entry.Mac))
                {
                    Trunk(device.Snapshot.Key, entry.Ports);
                }
            }
        }

        var depth = Depths(devices, links);

        var arpByMac = arp.GroupBy(entry => entry.Mac, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var leaseByMac = devices.SelectMany(device => device.Leases)
            .GroupBy(lease => lease.Mac, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.OrderByDescending(lease => lease.Hostname is not null).First(), StringComparer.Ordinal);

        var candidates = new Dictionary<string, List<Candidate>>(StringComparer.Ordinal);
        foreach (var device in devices)
        {
            if (!device.Snapshot.Reachable || device.Snapshot.Role == "ap" || device.Fdb.Count == 0)
            {
                continue;
            }

            var key = device.Snapshot.Key;
            trunk.TryGetValue(key, out var trunkPorts);
            foreach (var entry in device.Fdb)
            {
                if (IsMulticast(entry.Mac) || infraMacs.Contains(entry.Mac))
                {
                    continue;
                }

                var vlan = entry.Vlan ?? (arpByMac.TryGetValue(entry.Mac, out var known) ? known.Vlan : null);
                if (vlan is { } id && excluded.Contains(id))
                {
                    continue;
                }

                if (entry.Ports.Count == 0
                    || entry.Ports.Any(port => trunkPorts?.Contains(port) == true || port.StartsWith(Snmp.SnmpMapping.LagPortPrefix, StringComparison.Ordinal)))
                {
                    continue;
                }

                if (!candidates.TryGetValue(entry.Mac, out var list))
                {
                    candidates[entry.Mac] = list = [];
                }

                list.Add(new Candidate(key, entry.Ports[0], vlan, depth.GetValueOrDefault(key)));
            }
        }

        var perPort = candidates.Values.SelectMany(list => list)
            .GroupBy(candidate => (candidate.Device, candidate.Port))
            .ToDictionary(group => group.Key, group => group.Count());

        var chosen = candidates.ToDictionary(
            pair => pair.Key,
            pair => pair.Value
                .OrderByDescending(candidate => candidate.Depth)
                .ThenBy(candidate => perPort[(candidate.Device, candidate.Port)])
                .ThenBy(candidate => candidate.Device, StringComparer.Ordinal)
                .First(),
            StringComparer.Ordinal);

        var onPort = chosen.Values
            .GroupBy(candidate => (candidate.Device, candidate.Port))
            .ToDictionary(group => group.Key, group => group.Count());

        return chosen
            .Select(pair =>
            {
                var (mac, candidate) = (pair.Key, pair.Value);
                apPorts.TryGetValue((candidate.Device, candidate.Port), out var via);
                leaseByMac.TryGetValue(mac, out var lease);
                arpByMac.TryGetValue(mac, out var address);
                return new EndpointSnapshot
                {
                    Mac = mac,
                    Device = candidate.Device,
                    Port = candidate.Port,
                    Vlan = candidate.Vlan,
                    Ip = address.Ip ?? lease.Ip,
                    Hostname = lease.Hostname,
                    Via = via,
                    Shared = via is null && onPort[(candidate.Device, candidate.Port)] >= options.SharedPortThreshold ? true : null,
                };
            })
            .OrderBy(endpoint => endpoint.Device, StringComparer.Ordinal)
            .ThenBy(endpoint => endpoint.Port, StringComparer.Ordinal)
            .ThenBy(endpoint => endpoint.Mac, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>Profundidad de cada equipo en el árbol de enlaces, desde el router.</summary>
    private static Dictionary<string, int> Depths(IReadOnlyList<PollResult> devices, IReadOnlyList<LinkSnapshot> links)
    {
        var depth = new Dictionary<string, int>(StringComparer.Ordinal);
        var router = devices.FirstOrDefault(device => device.Snapshot.Role == "router")?.Snapshot.Key;
        if (router is null)
        {
            return depth;
        }

        var neighbors = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var link in links)
        {
            (neighbors.TryGetValue(link.A.Device, out var a) ? a : neighbors[link.A.Device] = []).Add(link.B.Device);
            (neighbors.TryGetValue(link.B.Device, out var b) ? b : neighbors[link.B.Device] = []).Add(link.A.Device);
        }

        depth[router] = 0;
        var queue = new Queue<string>([router]);
        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            foreach (var next in neighbors.GetValueOrDefault(current) ?? [])
            {
                if (depth.TryAdd(next, depth[current] + 1))
                {
                    queue.Enqueue(next);
                }
            }
        }

        return depth;
    }

    /// <summary>Bit de grupo del primer octeto: multicast y broadcast no son equipos.</summary>
    private static bool IsMulticast(string mac) =>
        mac.Length >= 2 && (int.Parse(mac.AsSpan(0, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture) & 1) == 1;
}
