using Grf.NetCollector.Contracts;

namespace Grf.NetCollector;

/// <summary>Resumen legible de una corrida sin envío (--dry-run), para instalar y diagnosticar.</summary>
internal static class DryRunReport
{
    public static void Print(SnapshotPayload payload)
    {
        var names = payload.Devices.ToDictionary(device => device.Key, device => device.Name ?? device.Key, StringComparer.Ordinal);
        foreach (var device in payload.Devices.OrderBy(device => RoleOrder(device.Role)).ThenBy(device => device.Name, StringComparer.OrdinalIgnoreCase))
        {
            if (!device.Reachable)
            {
                Console.WriteLine($"✗ {device.Key,-22} {device.Role,-7} {device.Error}");
                continue;
            }

            var ports = device.Ports ?? [];
            var neighbors = ports.Sum(port => port.Neighbors?.Count ?? 0);
            Console.WriteLine(
                $"✓ {device.Key,-22} {device.Role,-7} {device.Name} · {device.Model} · {device.Firmware}" +
                $" · {ports.Count(port => port.LinkUp)}/{ports.Count} puertos con enlace · {neighbors} vecinos" +
                (device.Clients is { } clients ? $" · {clients} clientes" : "") +
                $" · {device.PollMs} ms");
        }

        Console.WriteLine();
        Console.WriteLine($"Enlaces deducidos: {payload.Links.Count}");
        foreach (var link in payload.Links)
        {
            Console.WriteLine(
                $"  {names.GetValueOrDefault(link.A.Device, link.A.Device)} [{string.Join("+", link.A.Ports)}]" +
                $" ↔ {names.GetValueOrDefault(link.B.Device, link.B.Device)} [{string.Join("+", link.B.Ports)}]  ({link.Source})");
        }
    }

    private static int RoleOrder(string role) => role switch
    {
        "router" => 0,
        "core" => 1,
        "access" => 2,
        _ => 3,
    };
}
