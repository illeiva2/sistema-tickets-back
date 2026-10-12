using System.Text;
using Grf.NetCollector.Contracts;
using Grf.NetCollector.Polling;
using Grf.NetCollector.Storage;

namespace Grf.NetCollector.Topology;

/// <summary>
/// Deduce qué equipo cuelga de cuál. Dos fuentes:
/// <list type="number">
/// <item>Tablas MAC: el colector consulta cada equipo desde srv-datos, así que la respuesta de cada
/// uno sube por todos los switches que tiene arriba hasta el router. Cada switch aprende la MAC del
/// router en su puerto de subida y la de cada equipo de abajo en el puerto que baja hacia él. El
/// padre de un equipo es el switch más profundo que lo ve en un puerto de bajada.</item>
/// <item>LLDP: un vecino LLDP o CDP en un puerto es una conexión directa y da el puerto exacto de
/// los dos lados. MNDP no sirve para esto: los MikroTik lo difunden por toda la VLAN.</item>
/// </list>
/// </summary>
internal static class LinkInference
{
    public static List<LinkSnapshot> Infer(IReadOnlyList<PollResult> devices, IReadOnlyList<CachedAp> cachedAps)
    {
        var byKey = devices
            .GroupBy(device => device.Snapshot.Key, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var known = new HashSet<string>(byKey.Keys, StringComparer.Ordinal);
        known.UnionWith(cachedAps.Select(ap => ap.Key));

        // MAC → equipo: MACs propias, MAC de gestión según la ARP del router y APs de la última lectura de UniFi.
        var owners = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var device in devices)
        {
            foreach (var mac in device.Macs)
            {
                owners.TryAdd(mac, device.Snapshot.Key);
            }
        }

        var arp = devices
            .SelectMany(device => device.Arp)
            .GroupBy(entry => entry.Ip, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

        // VLAN de gestión de cada equipo (la de la interfaz del router donde está su IP): es la VLAN
        // por la que viaja el sondeo, y la única en la que las tablas MAC dicen la verdad sobre el
        // camino hasta él. Otras VLANs pueden tomar caminos distintos (p. ej. por un AP en mesh).
        var managementVlan = new Dictionary<string, int?>(StringComparer.Ordinal);
        var byIp = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var device in devices)
        {
            if (device.Snapshot.ManagementIp is { } ip && byIp.TryAdd(ip, device.Snapshot.Key) && arp.TryGetValue(ip, out var entry))
            {
                owners.TryAdd(entry.Mac, device.Snapshot.Key);
                managementVlan[device.Snapshot.Key] = entry.Vlan;
            }
        }

        foreach (var ap in cachedAps)
        {
            owners.TryAdd(ap.Mac, ap.Key);
            if (ap.Ip is { } ip && arp.TryGetValue(ip, out var entry))
            {
                managementVlan.TryAdd(ap.Key, entry.Vlan);
            }
        }

        var byName = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var device in devices)
        {
            if (NormalizeName(device.Snapshot.Name) is { Length: > 0 } name)
            {
                byName.TryAdd(name, device.Snapshot.Key);
            }
        }

        foreach (var ap in cachedAps)
        {
            if (NormalizeName(ap.Name) is { Length: > 0 } name)
            {
                byName.TryAdd(name, ap.Key);
            }
        }

        var links = new Dictionary<string, LinkSnapshot>(StringComparer.Ordinal);
        var fdbParents = AddFdbLinks(devices, owners, known, managementVlan, links);
        var lldpPeers = AddLldpLinks(NeighborSources(devices, cachedAps, byKey), byKey, owners, byIp, byName, links);

        // Un AP con vecino LLDP ya tiene su puerto exacto: el padre por tabla MAC sobra (y si un
        // switch del camino no se pudo leer, apunta a un switch de más arriba).
        foreach (var (child, parent) in fdbParents)
        {
            var isAp = byKey.TryGetValue(child, out var device) ? device.Snapshot.Role == "ap" : cachedAps.Any(ap => ap.Key == child);
            if (isAp && lldpPeers.TryGetValue(child, out var peers) && !peers.Contains(parent))
            {
                links.Remove(PairKey(child, parent));
            }
        }

        return links.Values
            .OrderBy(link => link.A.Device, StringComparer.Ordinal)
            .ThenBy(link => link.B.Device, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>Agrega los enlaces padre → hijo de las tablas MAC y devuelve hijo → padre.</summary>
    private static Dictionary<string, string> AddFdbLinks(
        IReadOnlyList<PollResult> devices,
        IReadOnlyDictionary<string, string> owners,
        IReadOnlySet<string> known,
        IReadOnlyDictionary<string, int?> managementVlan,
        Dictionary<string, LinkSnapshot> links)
    {
        var parents = new Dictionary<string, string>(StringComparer.Ordinal);
        var switches = devices.Where(device => device.Snapshot.Reachable && device.Fdb.Count > 0).ToList();
        var router = devices.FirstOrDefault(device => device.Snapshot.Role == "router")?.Snapshot.Key;
        if (router is null)
        {
            return parents;
        }

        // seen[S][D]: entradas de la tabla de S con alguna MAC de D (con su VLAN, si S la informa).
        var seen = new Dictionary<string, Dictionary<string, List<FdbEntry>>>(StringComparer.Ordinal);
        foreach (var device in switches)
        {
            var self = device.Snapshot.Key;
            var map = new Dictionary<string, List<FdbEntry>>(StringComparer.Ordinal);
            foreach (var entry in device.Fdb)
            {
                if (owners.TryGetValue(entry.Mac, out var owner) && owner != self)
                {
                    if (!map.TryGetValue(owner, out var entries))
                    {
                        map[owner] = entries = [];
                    }

                    entries.Add(entry);
                }
            }

            seen[self] = map;
        }

        // Puertos de S donde aparece D, mirando sólo la VLAN dada (las entradas sin VLAN, como las
        // del SwOS, valen para cualquiera).
        SortedSet<string> PortsOf(string self, string device, int? vlan)
        {
            var ports = new SortedSet<string>(StringComparer.Ordinal);
            if (seen.TryGetValue(self, out var map) && map.TryGetValue(device, out var entries))
            {
                foreach (var entry in entries.Where(entry => vlan is null || entry.Vlan is null || entry.Vlan == vlan))
                {
                    ports.UnionWith(entry.Ports);
                }
            }

            return ports;
        }

        // Subida de S en una VLAN: donde aprendió la MAC del router en esa VLAN.
        SortedSet<string> Uplink(string self, int? vlan) => PortsOf(self, router, vlan);

        // ancestors[D]: switches que ven a D en un puerto de bajada, en la VLAN de gestión de D.
        var ancestors = new Dictionary<string, List<(string Switch, SortedSet<string> Ports)>>(StringComparer.Ordinal);
        foreach (var device in known)
        {
            if (device == router)
            {
                continue;
            }

            var vlan = managementVlan.GetValueOrDefault(device);
            foreach (var self in seen.Keys)
            {
                if (self == device)
                {
                    continue;
                }

                var ports = PortsOf(self, device, vlan);
                if (ports.Count == 0)
                {
                    continue;
                }

                if (self != router)
                {
                    var up = Uplink(self, vlan);
                    // Sin la MAC del router en esa VLAN no se sabe qué está arriba y qué abajo.
                    if (up.Count == 0 || ports.Overlaps(up))
                    {
                        continue;
                    }
                }

                if (!ancestors.TryGetValue(device, out var list))
                {
                    ancestors[device] = list = [];
                }

                list.Add((self, ports));
            }
        }

        int Depth(string key) => key == router ? 0 : ancestors.TryGetValue(key, out var list) ? list.Count : 0;

        foreach (var (device, candidates) in ancestors)
        {
            // El padre es el ancestro más profundo; si empatan, el que tiene menos equipos detrás de ese puerto.
            var parent = candidates
                .OrderByDescending(candidate => Depth(candidate.Switch))
                .ThenBy(candidate => seen[candidate.Switch].Keys.Count(other => PortsOf(candidate.Switch, other, null).Overlaps(candidate.Ports)))
                .ThenBy(candidate => candidate.Switch, StringComparer.Ordinal)
                .First();
            var childPorts = seen.ContainsKey(device) ? Uplink(device, managementVlan.GetValueOrDefault(device)).ToList() : [];
            Add(links, parent.Switch, parent.Ports.ToList(), device, childPorts, LinkSources.Fdb);
            parents[device] = parent.Switch;
        }

        return parents;
    }

    /// <summary>
    /// Vecinos LLDP por equipo y puerto: los de esta corrida y, para los APs que no se leyeron ahora
    /// (UniFi se consulta cada 5 minutos), los de la última lectura de UniFi. Así el enlace de un AP
    /// no cambia de una corrida a la siguiente.
    /// </summary>
    private static IEnumerable<(string Self, string Port, NeighborSnapshot Neighbor)> NeighborSources(
        IReadOnlyList<PollResult> devices,
        IReadOnlyList<CachedAp> cachedAps,
        IReadOnlyDictionary<string, PollResult> byKey)
    {
        foreach (var device in devices)
        {
            if (!device.Snapshot.Reachable || device.Snapshot.Ports is null)
            {
                continue;
            }

            foreach (var port in device.Snapshot.Ports)
            {
                foreach (var neighbor in port.Neighbors ?? [])
                {
                    yield return (device.Snapshot.Key, port.Key, neighbor);
                }
            }
        }

        foreach (var ap in cachedAps.Where(ap => !byKey.ContainsKey(ap.Key)))
        {
            foreach (var cached in ap.Neighbors ?? [])
            {
                yield return (ap.Key, cached.Port, cached.Neighbor);
            }
        }
    }

    /// <summary>Agrega los enlaces LLDP y devuelve, por equipo, con quiénes tiene uno.</summary>
    private static Dictionary<string, HashSet<string>> AddLldpLinks(
        IEnumerable<(string Self, string Port, NeighborSnapshot Neighbor)> sources,
        IReadOnlyDictionary<string, PollResult> byKey,
        IReadOnlyDictionary<string, string> owners,
        IReadOnlyDictionary<string, string> byIp,
        IReadOnlyDictionary<string, string> byName,
        Dictionary<string, LinkSnapshot> links)
    {
        var peers = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        void Peer(string a, string b)
        {
            if (!peers.TryGetValue(a, out var set))
            {
                peers[a] = set = new HashSet<string>(StringComparer.Ordinal);
            }

            set.Add(b);
        }

        foreach (var (self, port, neighbor) in sources)
        {
            if (neighbor.Protocol == NeighborProtocols.Mndp)
            {
                continue;
            }

            var target = (neighbor.Mac is { } mac && owners.TryGetValue(mac, out var byMac) ? byMac : null)
                ?? (neighbor.Ip is { } ip && byIp.TryGetValue(ip, out var byAddress) ? byAddress : null)
                ?? (NormalizeName(neighbor.Name) is { Length: > 0 } name && byName.TryGetValue(name, out var named) ? named : null);
            if (target is null || target == self)
            {
                continue;
            }

            var remotePort = RemotePort(target, neighbor.Port, byKey);
            Add(links, self, [port], target, remotePort is null ? [] : [remotePort], LinkSources.Lldp);
            Peer(self, target);
            Peer(target, self);
        }

        return peers;
    }

    /// <summary>Puerto del otro equipo según lo que anunció por LLDP: nombre, clave o MAC del puerto.</summary>
    private static string? RemotePort(string target, string? announced, IReadOnlyDictionary<string, PollResult> byKey)
    {
        if (!byKey.TryGetValue(target, out var device))
        {
            return target.StartsWith("ap-", StringComparison.Ordinal) ? "eth0" : null;
        }

        if (announced is null)
        {
            return device.Snapshot.Ports is { Count: 1 } single ? single[0].Key : null;
        }

        if (Mac.Normalize(announced) is { } mac && device.PortByMac.TryGetValue(mac, out var byMac))
        {
            return byMac;
        }

        var ports = device.Snapshot.Ports ?? [];
        // "bridge/bond_TRUNK/sfp1-TRUNK": MikroTik anuncia el camino; el puerto es lo último.
        var last = announced.Split('/')[^1];
        return ports.FirstOrDefault(port => port.Name.Equals(last, StringComparison.OrdinalIgnoreCase)
                || port.Key.Equals(last, StringComparison.OrdinalIgnoreCase))?.Key
            ?? (ports.Count == 1 ? ports[0].Key : null);
    }

    private static string PairKey(string a, string b) => string.CompareOrdinal(a, b) < 0 ? a + "|" + b : b + "|" + a;

    private static void Add(Dictionary<string, LinkSnapshot> links, string a, List<string> aPorts, string b, List<string> bPorts, string source)
    {
        var (first, firstPorts, second, secondPorts) = string.CompareOrdinal(a, b) < 0
            ? (a, aPorts, b, bPorts)
            : (b, bPorts, a, aPorts);
        var pair = PairKey(a, b);
        if (links.TryGetValue(pair, out var existing))
        {
            if (existing.Source == LinkSources.Lldp && source != LinkSources.Lldp)
            {
                return;
            }

            if (existing.Source == LinkSources.Lldp)
            {
                // El mismo enlace visto desde los dos lados: se completa el lado que faltaba.
                firstPorts = existing.A.Ports.Count > 0 ? existing.A.Ports.ToList() : firstPorts;
                secondPorts = existing.B.Ports.Count > 0 ? existing.B.Ports.ToList() : secondPorts;
            }
            else
            {
                // LLDP sobre un enlace de las tablas MAC: el lado que el vecino no pudo decir queda
                // como estaba. Pasa con los TP-Link y HPE, que anuncian como puerto la MAC del
                // switch (la misma en todos): sin esto, el AP perdía el puerto del switch.
                firstPorts = firstPorts.Count > 0 ? firstPorts : existing.A.Ports.ToList();
                secondPorts = secondPorts.Count > 0 ? secondPorts : existing.B.Ports.ToList();
            }
        }

        links[pair] = new LinkSnapshot(new LinkEnd(first, firstPorts), new LinkEnd(second, secondPorts), source);
    }

    /// <summary>
    /// Diagnóstico (--topology-debug): en qué puertos de cada switch aparece la MAC del router y la
    /// de cada otro equipo de red, con la VLAN si el switch la informa.
    /// </summary>
    public static List<string> Explain(IReadOnlyList<PollResult> devices)
    {
        var names = devices.ToDictionary(device => device.Snapshot.Key, device => device.Snapshot.Name ?? device.Snapshot.Key, StringComparer.Ordinal);
        var owners = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var device in devices.Where(device => device.Snapshot.Role != "ap"))
        {
            foreach (var mac in device.Macs)
            {
                owners.TryAdd(mac, device.Snapshot.Key);
            }
        }

        var arp = devices.SelectMany(device => device.Arp).GroupBy(entry => entry.Ip, StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.First().Mac, StringComparer.Ordinal);
        foreach (var device in devices.Where(device => device.Snapshot.Role != "ap"))
        {
            if (device.Snapshot.ManagementIp is { } ip && arp.TryGetValue(ip, out var mac))
            {
                owners.TryAdd(mac, device.Snapshot.Key);
            }
        }

        var lines = new List<string>();
        var arpEntries = devices.SelectMany(device => device.Arp).GroupBy(entry => entry.Ip, StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        foreach (var device in devices.Where(device => device.Snapshot.Role != "ap"))
        {
            var ip = device.Snapshot.ManagementIp ?? "";
            lines.Add(arpEntries.TryGetValue(ip, out var entry)
                ? $"  ARP {ip,-12} {entry.Mac} v{entry.Vlan?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "?"}  {names[device.Snapshot.Key]}"
                : $"  ARP {ip,-12} (no está en la ARP del router)  {names[device.Snapshot.Key]}");
        }

        foreach (var device in devices.Where(device => device.Fdb.Count > 0))
        {
            lines.Add($"{names[device.Snapshot.Key]} ({device.Fdb.Count} MACs en la tabla):");
            var seen = device.Fdb
                .Where(entry => owners.TryGetValue(entry.Mac, out var owner) && owner != device.Snapshot.Key)
                .GroupBy(entry => owners[entry.Mac], StringComparer.Ordinal)
                .OrderBy(group => names[group.Key], StringComparer.OrdinalIgnoreCase);
            foreach (var group in seen)
            {
                var where = group
                    .Select(entry => $"{string.Join("+", entry.Ports)}{(entry.Vlan is { } vlan ? "@v" + vlan : "")}")
                    .Distinct(StringComparer.Ordinal)
                    .Order(StringComparer.Ordinal);
                lines.Add($"    {names[group.Key],-28} {string.Join(", ", where)}");
            }
        }

        return lines;
    }

    /// <summary>
    /// "AP-010 - Taller - Galpón" y "AP-010-Taller-Galpn" (el AP saca los acentos de su nombre de
    /// host) quedan iguales: minúsculas y sólo letras y números ASCII.
    /// </summary>
    public static string? NormalizeName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        var builder = new StringBuilder(name.Length);
        foreach (var character in name.ToLowerInvariant())
        {
            if (character is >= 'a' and <= 'z' or >= '0' and <= '9')
            {
                builder.Append(character);
            }
        }

        return builder.ToString();
    }
}
