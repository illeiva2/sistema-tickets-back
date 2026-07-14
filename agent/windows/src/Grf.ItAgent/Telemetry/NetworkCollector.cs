using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Utilities;

namespace Grf.ItAgent.Telemetry;

internal sealed record NetworkCandidate(
    string Name,
    bool HasDefaultGateway,
    long Speed,
    string? MacAddress,
    IReadOnlyList<string> Addresses,
    NetworkAdapterSnapshot Inventory);

internal sealed record NetworkCollection(
    IReadOnlyList<string>? HeartbeatAddresses,
    IReadOnlyList<string>? HeartbeatMacAddresses,
    IReadOnlyList<NetworkAdapterSnapshot>? InventoryAdapters);

internal static class NetworkCollector
{
    public static NetworkCollection Collect()
    {
        var candidates = new List<NetworkCandidate>();
        foreach (var networkInterface in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (networkInterface.OperationalStatus != OperationalStatus.Up
                || networkInterface.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
            {
                continue;
            }

            try
            {
                var properties = networkInterface.GetIPProperties();
                var addresses = properties.UnicastAddresses
                    .Select(item => NormalizeAddress(item.Address))
                    .Where(address => address is not null && IsUseful(address))
                    .Cast<IPAddress>()
                    .Distinct()
                    .OrderBy(GetAddressPriority)
                    .ThenBy(address => address.ToString(), StringComparer.Ordinal)
                    .Take(16)
                    .Select(address => address.ToString())
                    .ToArray();

                if (addresses.Length == 0)
                {
                    continue;
                }

                var mac = FormatMacAddress(networkInterface.GetPhysicalAddress());
                var name = StringLimiter.LimitRequired(networkInterface.Name, 200, networkInterface.Id);
                var inventory = new NetworkAdapterSnapshot(
                    name,
                    StringLimiter.LimitOptional(networkInterface.Description, 300),
                    mac,
                    addresses);
                var hasGateway = properties.GatewayAddresses.Any(gateway =>
                    gateway.Address.AddressFamily == AddressFamily.InterNetwork
                    && !IPAddress.Any.Equals(gateway.Address)
                    && !IPAddress.None.Equals(gateway.Address));
                candidates.Add(new NetworkCandidate(
                    name,
                    hasGateway,
                    Math.Max(0, networkInterface.Speed),
                    mac,
                    addresses,
                    inventory));
            }
            catch (NetworkInformationException)
            {
                // An adapter may disappear while it is being inspected.
            }
        }

        var ordered = OrderCandidates(candidates).Take(64).ToArray();
        var heartbeatAddresses = ordered
            .SelectMany(candidate => candidate.Addresses)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(32)
            .ToArray();
        var heartbeatMacs = ordered
            .Select(candidate => candidate.MacAddress)
            .Where(address => address is not null)
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(32)
            .ToArray();

        return new NetworkCollection(
            heartbeatAddresses.Length == 0 ? null : heartbeatAddresses,
            heartbeatMacs.Length == 0 ? null : heartbeatMacs,
            ordered.Length == 0 ? null : ordered.Select(candidate => candidate.Inventory).ToArray());
    }

    internal static IReadOnlyList<NetworkCandidate> OrderCandidates(IEnumerable<NetworkCandidate> candidates)
    {
        return candidates
            .OrderByDescending(candidate => candidate.HasDefaultGateway)
            .ThenBy(candidate => candidate.Addresses.Count == 0 ? int.MaxValue : GetAddressPriority(IPAddress.Parse(candidate.Addresses[0])))
            .ThenByDescending(candidate => candidate.Speed)
            .ThenBy(candidate => candidate.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static IPAddress? NormalizeAddress(IPAddress address)
    {
        if (address.AddressFamily == AddressFamily.InterNetworkV6 && address.ScopeId != 0)
        {
            return new IPAddress(address.GetAddressBytes());
        }

        return address;
    }

    private static bool IsUseful(IPAddress address)
    {
        if (IPAddress.IsLoopback(address) || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any))
        {
            return false;
        }

        var bytes = address.GetAddressBytes();
        return address.AddressFamily != AddressFamily.InterNetwork || bytes[0] != 169 || bytes[1] != 254;
    }

    private static int GetAddressPriority(IPAddress address)
    {
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var bytes = address.GetAddressBytes();
            var isPrivate = bytes[0] == 10
                || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31)
                || (bytes[0] == 192 && bytes[1] == 168);
            return isPrivate ? 0 : 1;
        }

        return address.IsIPv6LinkLocal ? 3 : 2;
    }

    private static string? FormatMacAddress(PhysicalAddress address)
    {
        var bytes = address.GetAddressBytes();
        return bytes.Length == 6 ? string.Join(':', bytes.Select(value => value.ToString("X2"))) : null;
    }
}
