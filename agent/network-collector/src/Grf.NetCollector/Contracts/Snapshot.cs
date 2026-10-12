using System.Text.Json;
using System.Text.Json.Serialization;

namespace Grf.NetCollector.Contracts;

// Contrato con POST /api/network-collector/snapshot (src/validations/networkLive.ts del back).
// Los nombres salen en camelCase y los null no se mandan.

internal sealed record SnapshotPayload(
    CollectorInfo Collector,
    DateTimeOffset StartedAt,
    DateTimeOffset FinishedAt,
    IReadOnlyList<DeviceSnapshot> Devices,
    IReadOnlyList<LinkSnapshot> Links);

internal sealed record CollectorInfo(string Version, string Host);

internal sealed record DeviceSnapshot
{
    public required string Key { get; init; }
    public required string Source { get; init; }
    public required string Role { get; init; }
    public required bool Reachable { get; init; }
    public string? Error { get; init; }
    public int? PollMs { get; init; }
    public string? Name { get; init; }
    public string? ManagementIp { get; init; }
    public string? MacAddress { get; init; }
    public string? Vendor { get; init; }
    public string? Model { get; init; }
    public string? Firmware { get; init; }
    public string? SerialNumber { get; init; }
    public long? UptimeSeconds { get; init; }
    public int? Clients { get; init; }
    public IReadOnlyList<PortSnapshot>? Ports { get; init; }
}

internal sealed record PortSnapshot
{
    public required string Key { get; init; }
    public required string Name { get; init; }
    public string? Description { get; init; }
    public required int Position { get; init; }
    public required string Kind { get; init; }
    public required bool AdminUp { get; init; }
    public required bool LinkUp { get; init; }
    public int? SpeedMbps { get; init; }
    public bool? FullDuplex { get; init; }
    public int? Pvid { get; init; }
    public IReadOnlyList<NeighborSnapshot>? Neighbors { get; init; }
}

internal sealed record NeighborSnapshot
{
    public required string Protocol { get; init; }
    public string? Name { get; init; }
    public string? Mac { get; init; }
    public string? Ip { get; init; }
    public string? Port { get; init; }
    public string? Platform { get; init; }
}

internal sealed record LinkSnapshot(LinkEnd A, LinkEnd B, string Source);

internal sealed record LinkEnd(string Device, IReadOnlyList<string> Ports);

internal static class NeighborProtocols
{
    public const string Lldp = "lldp";
    public const string Mndp = "mndp";
    public const string Cdp = "cdp";
}

internal static class LinkSources
{
    public const string Lldp = "lldp";
    public const string Fdb = "fdb";
}

internal static class SnapshotJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public static JsonSerializerOptions Indented { get; } = new(Options) { WriteIndented = true };
}
