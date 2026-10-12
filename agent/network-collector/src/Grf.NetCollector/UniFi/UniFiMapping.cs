using System.Text.Json;
using Grf.NetCollector.Contracts;
using Grf.NetCollector.Polling;
using Grf.NetCollector.Storage;

namespace Grf.NetCollector.UniFi;

/// <summary>Traduce stat/device del controlador UniFi a equipos (APs). Sin red.</summary>
internal static class UniFiMapping
{
    private static readonly Dictionary<string, string> ModelNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["U7LR"] = "UAP-AC-LR",
        ["U7LT"] = "UAP-AC-Lite",
        ["U7PG2"] = "UAP-AC-Pro",
        ["U7P"] = "UAP-Pro",
        ["U7HD"] = "UAP-AC-HD",
        ["U7SHD"] = "UAP-AC-SHD",
        ["U7NHD"] = "UAP-nanoHD",
        ["U7MSH"] = "UAP-AC-Mesh",
        ["U7MP"] = "UAP-AC-M-Pro",
        ["U7IW"] = "UAP-AC-IW",
        ["U7O"] = "UAP-AC-Outdoor",
        ["UFLHD"] = "UAP-FlexHD",
        ["UAL6"] = "U6-Lite",
        ["UALR6"] = "U6-LR",
        ["UALR6v2"] = "U6-LR",
        ["UAP6MP"] = "U6-Pro",
        ["U6M"] = "U6-Mesh",
        ["UAE6"] = "U6-Enterprise",
        ["U6IW"] = "U6-IW",
    };

    public static (List<PollResult> Devices, List<CachedAp> Cache) Build(JsonElement devices, long elapsedMs)
    {
        var results = new List<PollResult>();
        var cache = new List<CachedAp>();
        foreach (var device in devices.EnumerateArray())
        {
            var type = Text(device, "type");
            var role = type switch
            {
                "uap" => "ap",
                "usw" => "access",
                _ => null,
            };
            if (role is null || Mac.Normalize(Text(device, "mac")) is not { } mac)
            {
                continue;
            }

            var key = (role == "ap" ? "ap-" : "usw-") + mac.ToLowerInvariant();
            var name = Text(device, "name") ?? mac;
            var state = Int(device, "state");
            var connected = state == 1;
            var modelCode = Text(device, "model");

            results.Add(new PollResult
            {
                Snapshot = new DeviceSnapshot
                {
                    Key = key,
                    Source = "unifi",
                    Role = role,
                    Reachable = connected,
                    Error = connected ? null : $"UniFi: {StateText(state)}",
                    PollMs = (int)Math.Min(elapsedMs, int.MaxValue),
                    Name = name,
                    ManagementIp = Text(device, "ip"),
                    MacAddress = mac,
                    Vendor = "Ubiquiti",
                    Model = modelCode is null ? null : ModelNames.GetValueOrDefault(modelCode, modelCode),
                    Firmware = Text(device, "version"),
                    SerialNumber = Text(device, "serial"),
                    UptimeSeconds = connected ? Int(device, "uptime") : null,
                    Clients = connected ? (int?)(Int(device, "num_sta") ?? 0) : null,
                    Ports = BuildPorts(device, connected),
                },
                Macs = new HashSet<string>(StringComparer.Ordinal) { mac },
            });
            cache.Add(new CachedAp(key, mac, name, Text(device, "ip")));
        }

        return (results, cache);
    }

    private static List<PortSnapshot> BuildPorts(JsonElement device, bool connected)
    {
        var neighbors = new List<(long? LocalPort, NeighborSnapshot Neighbor)>();
        if (device.TryGetProperty("lldp_table", out var lldp) && lldp.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in lldp.EnumerateArray())
            {
                if (Mac.Normalize(Text(entry, "chassis_id")) is not { } chassis)
                {
                    continue;
                }

                neighbors.Add((Int(entry, "local_port_idx"), new NeighborSnapshot
                {
                    Protocol = NeighborProtocols.Lldp,
                    Mac = chassis,
                    Port = Text(entry, "port_id"),
                }));
            }
        }

        var ports = new List<PortSnapshot>();
        if (device.TryGetProperty("port_table", out var table) && table.ValueKind == JsonValueKind.Array)
        {
            foreach (var row in table.EnumerateArray())
            {
                var index = (int)(Int(row, "port_idx") ?? ports.Count + 1);
                var up = connected && Bool(row, "up") == true;
                ports.Add(new PortSnapshot
                {
                    Key = $"eth{index - 1}",
                    Name = Text(row, "name") ?? $"eth{index - 1}",
                    Position = index,
                    Kind = PortKinds.Copper,
                    AdminUp = Bool(row, "enable") != false,
                    LinkUp = up,
                    SpeedMbps = up ? (int?)Int(row, "speed") : null,
                    FullDuplex = up ? Bool(row, "full_duplex") : null,
                    Neighbors = Neighbors(neighbors, index, ports.Count == 0),
                });
            }
        }

        if (ports.Count == 0)
        {
            ports.Add(new PortSnapshot
            {
                Key = "eth0",
                Name = "eth0",
                Position = 1,
                Kind = PortKinds.Copper,
                AdminUp = true,
                LinkUp = connected,
                Neighbors = Neighbors(neighbors, 1, true),
            });
        }

        return ports;
    }

    private static List<NeighborSnapshot>? Neighbors(List<(long? LocalPort, NeighborSnapshot Neighbor)> all, int index, bool first)
    {
        var matching = all.Where(item => item.LocalPort == index || (item.LocalPort is null && first)).Select(item => item.Neighbor).ToList();
        return matching.Count == 0 ? null : matching;
    }

    private static string StateText(long? state) => state switch
    {
        0 => "desconectado",
        2 => "pendiente de adopción",
        4 => "actualizando firmware",
        5 => "aprovisionando",
        6 => "sin latido",
        7 => "adoptando",
        9 => "error de adopción",
        10 => "adopción fallida",
        11 => "aislado",
        null => "estado desconocido",
        _ => $"estado {state}",
    };

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } text
            ? text.Trim()
            : null;

    private static long? Int(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)
            ? number
            : null;

    private static bool? Bool(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value)
            ? value.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            }
            : null;
}
