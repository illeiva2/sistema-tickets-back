using Grf.NetCollector.Contracts;

namespace Grf.NetCollector.Polling;

/// <summary>Una entrada de la tabla MAC de un switch: MAC aprendida, puerto(s) y VLAN.</summary>
internal readonly record struct FdbEntry(string Mac, IReadOnlyList<string> Ports, int? Vlan);

/// <summary>Entrada ARP del router; Vlan es el id de la interfaz VLAN donde se aprendió, si es una.</summary>
internal readonly record struct ArpEntry(string Ip, string Mac, int? Vlan = null);

/// <summary>Concesión DHCP del router: el nombre que pidió el equipo (host-name) y su IP.</summary>
internal readonly record struct LeaseEntry(string Mac, string? Ip, string? Hostname);

/// <summary>
/// Lo que deja el sondeo de un equipo: lo que se envía al back (Snapshot) más lo que sólo
/// sirve acá para deducir enlaces (tabla MAC, MACs propias, ARP del router).
/// </summary>
internal sealed class PollResult
{
    public required DeviceSnapshot Snapshot { get; init; }
    public IReadOnlyList<FdbEntry> Fdb { get; init; } = [];
    public IReadOnlySet<string> Macs { get; init; } = new HashSet<string>();
    /// <summary>MAC propia de cada puerto, si es única (los MikroTik la informan en su LLDP como id de puerto).</summary>
    public IReadOnlyDictionary<string, string> PortByMac { get; init; } = new Dictionary<string, string>();
    public IReadOnlyList<ArpEntry> Arp { get; init; } = [];
    public IReadOnlyList<LeaseEntry> Leases { get; init; } = [];

    public static PollResult Failed(string key, string source, string role, string? managementIp, string error, long elapsedMs) => new()
    {
        Snapshot = new DeviceSnapshot
        {
            Key = key,
            Source = source,
            Role = role,
            Reachable = false,
            Error = error.Length > 300 ? error[..300] : error,
            PollMs = (int)Math.Min(elapsedMs, int.MaxValue),
            ManagementIp = managementIp,
        },
    };
}
