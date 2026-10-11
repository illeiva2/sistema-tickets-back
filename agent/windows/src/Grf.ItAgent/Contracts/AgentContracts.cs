namespace Grf.ItAgent.Contracts;

internal sealed record ApiEnvelope<T>(bool Success, T? Data);

internal sealed record EnrollRequest(
    string Token,
    string DeviceSecret,
    string MachineGuid,
    string Hostname,
    string AgentVersion,
    string? OsName,
    string? OsVersion);

internal sealed record EnrollResponse(string DeviceId, int NextHeartbeatSeconds);

internal sealed record DeviceCredentials(string DeviceId, string Secret);

internal sealed record StoredEnrollment(
    string Status,
    string DeviceSecret,
    string? DeviceId,
    string? TokenFingerprint);

internal sealed record HeartbeatRequest(
    string Hostname,
    string? Username,
    IReadOnlyList<string>? IpAddresses,
    IReadOnlyList<string>? MacAddresses,
    int UptimeSeconds,
    double? CpuPercent,
    RamSnapshot Ram,
    BatterySnapshot? Battery,
    IReadOnlyList<DiskSnapshot>? Disks,
    ServiceSnapshot Services,
    OsSnapshot Os,
    string AgentVersion,
    InventorySnapshot? Inventory);

internal sealed record HeartbeatResponse(DateTimeOffset AcceptedAt, int NextHeartbeatSeconds, string State);

internal sealed record RamSnapshot(long TotalBytes, long UsedBytes);

internal sealed record BatterySnapshot(int? Percent, bool? Charging);

internal sealed record DiskSnapshot(string Name, long TotalBytes, long UsedBytes);

internal sealed record ServiceSnapshot(RemoteServiceSnapshot Ssh, RemoteServiceSnapshot Vnc);

internal sealed record RemoteServiceSnapshot(bool Available, int? Port);

internal sealed record OsSnapshot(string Name, string? Version, string? Build);

// Los campos agregados en 0.3 van al final y con valor por defecto: el JSON omite
// los null y la API los acepta como opcionales, así que conviven con agentes 0.2.
internal sealed record InventorySnapshot(
    DateTimeOffset? CollectedAt,
    HardwareSnapshot? Hardware,
    CpuInventorySnapshot? Cpu,
    IReadOnlyList<MemoryModuleSnapshot>? MemoryModules,
    IReadOnlyList<SoftwareSnapshot>? Software,
    IReadOnlyList<NetworkAdapterSnapshot>? NetworkAdapters,
    IReadOnlyList<PhysicalDiskSnapshot>? PhysicalDisks = null,
    int? MemorySlots = null);

internal sealed record HardwareSnapshot(
    string? Manufacturer,
    string? Model,
    string? SerialNumber,
    string? BiosVersion,
    string? ChassisType = null,
    string? BaseboardManufacturer = null,
    string? BaseboardModel = null,
    string? BaseboardSerial = null);

internal sealed record CpuInventorySnapshot(string? Model, int? Cores, int? LogicalProcessors);

internal sealed record MemoryModuleSnapshot(
    long CapacityBytes,
    string? Manufacturer,
    string? PartNumber,
    string? SerialNumber,
    int? SpeedMts = null,
    string? MemoryType = null,
    string? FormFactor = null,
    string? Slot = null);

internal sealed record PhysicalDiskSnapshot(
    string? Model,
    string? SerialNumber,
    long? SizeBytes,
    string? MediaType,
    string? BusType);

internal sealed record SoftwareSnapshot(string Name, string? Version, string? Publisher);

internal sealed record NetworkAdapterSnapshot(
    string Name,
    string? Description,
    string? MacAddress,
    IReadOnlyList<string>? IpAddresses);
