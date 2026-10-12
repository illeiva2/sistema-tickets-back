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

        if (payload.Endpoints is { } endpoints)
        {
            // Sin nombres ni MACs: el resumen puede terminar en un log o una captura.
            Console.WriteLine();
            Console.WriteLine(
                $"Equipos finales: {endpoints.Count} ({endpoints.Count(endpoint => endpoint.Via is null)} cableados, " +
                $"{endpoints.Count(endpoint => endpoint.Via is not null)} por Wi-Fi) · {endpoints.Count(endpoint => endpoint.Ip is not null)} con IP · " +
                $"{endpoints.Count(endpoint => endpoint.Hostname is not null)} con nombre DHCP · " +
                $"{endpoints.Where(endpoint => endpoint.Shared == true).Select(endpoint => (endpoint.Device, endpoint.Port)).Distinct().Count()} puertos compartidos");
            foreach (var group in endpoints.GroupBy(endpoint => endpoint.Device).OrderByDescending(group => group.Count()))
            {
                Console.WriteLine($"  {names.GetValueOrDefault(group.Key, group.Key),-28} {group.Count(),4} equipos en {group.Select(endpoint => endpoint.Port).Distinct().Count()} puertos");
            }
        }

        if (payload.WifiClients is { } wifi)
        {
            // También sin nombres ni MACs.
            Console.WriteLine();
            Console.WriteLine(
                $"Clientes Wi-Fi (UniFi): {wifi.Count} · " +
                string.Join(" · ", wifi.GroupBy(client => client.Band ?? "?").OrderBy(group => group.Key, StringComparer.Ordinal).Select(group => $"{group.Count()} en {group.Key} GHz")) +
                $" · {wifi.Count(client => client.Signal is < -75)} con señal débil (< -75 dBm)");
            foreach (var group in wifi.GroupBy(client => client.Ap).OrderByDescending(group => group.Count()))
            {
                Console.WriteLine($"  {names.GetValueOrDefault(group.Key, group.Key),-40} {group.Count(),3} clientes");
            }
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
