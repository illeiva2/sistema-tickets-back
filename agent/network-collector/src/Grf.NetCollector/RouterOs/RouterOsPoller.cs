using System.Diagnostics;
using Grf.NetCollector.Configuration;
using Grf.NetCollector.Polling;
using Grf.NetCollector.Security;

namespace Grf.NetCollector.RouterOs;

/// <summary>
/// Lee un MikroTik por la API cifrada con el usuario de sólo lectura. Sólo comandos "print" y
/// "monitor once": nada que cambie la configuración del equipo.
/// </summary>
internal sealed class RouterOsPoller(RouterOsSection settings, string? password, CertificatePins pins)
{
    public PollResult Poll(DeviceEntry entry)
    {
        var clock = Stopwatch.StartNew();
        if (password is null)
        {
            return PollResult.Failed(entry.Ip, "routeros", entry.Role, entry.Ip, $"falta la variable {settings.PasswordVariable}", clock.ElapsedMilliseconds);
        }

        try
        {
            using var api = RouterOsClient.Connect(
                entry.Ip,
                settings.Port,
                settings.TimeoutMs,
                fingerprint => pins.Accept($"{entry.Ip}:{settings.Port}", fingerprint, entry.CertificateSha256));
            api.Login(settings.User, password);

            var ethernet = api.Print("/interface/ethernet/print", "=.proplist=.id,name,default-name,disabled,running,mac-address,comment");
            // Por id y no por nombre: un nombre con coma ("ether5-Caja,Oficina") rompería la lista.
            var ids = string.Join(",", ethernet.Select(row => row.GetValueOrDefault(".id")).Where(id => !string.IsNullOrEmpty(id)));
            var readout = new RouterOsReadout
            {
                Identity = api.Print("/system/identity/print").FirstOrDefault(),
                Resource = api.Print("/system/resource/print").FirstOrDefault(),
                RouterBoard = api.TryPrint("/system/routerboard/print")?.FirstOrDefault(),
                Interfaces = api.Print("/interface/print", "=.proplist=name,default-name,type,mac-address"),
                Ethernet = ethernet,
                Monitor = ids.Length > 0 ? api.TryPrint("/interface/ethernet/monitor", "=numbers=" + ids, "=once=") ?? [] : [],
                BridgePorts = api.TryPrint("/interface/bridge/port/print", "=.proplist=interface,pvid") ?? [],
                Bonds = api.TryPrint("/interface/bonding/print", "=.proplist=name,slaves") ?? [],
                Neighbors = api.TryPrint("/ip/neighbor/print", "=.proplist=interface,address,address4,mac-address,identity,platform,board,interface-name") ?? [],
                BridgeHosts = api.TryPrint("/interface/bridge/host/print", "=.proplist=mac-address,on-interface,vid,local") ?? [],
                Arp = entry.Role == "router" ? api.TryPrint("/ip/arp/print", "=.proplist=address,mac-address,interface") ?? [] : [],
                Vlans = entry.Role == "router" ? api.TryPrint("/interface/vlan/print", "=.proplist=name,vlan-id") ?? [] : [],
            };

            return RouterOsMapping.Build(entry, readout, clock.ElapsedMilliseconds);
        }
        catch (Exception exception)
        {
            return PollResult.Failed(entry.Ip, "routeros", entry.Role, entry.Ip, Describe(exception), clock.ElapsedMilliseconds);
        }
    }

    private static string Describe(Exception exception) => exception switch
    {
        RouterOsTrapException trap when trap.Message.Contains("password", StringComparison.OrdinalIgnoreCase) =>
            "el equipo rechazó el usuario o la clave",
        RouterOsTrapException trap => "el equipo respondió: " + trap.Message,
        CertificateRejectedException rejected => rejected.Message,
        AggregateException { InnerException: { } inner } => Describe(inner),
        System.Net.Sockets.SocketException socket => $"sin conexión con la API cifrada ({socket.SocketErrorCode})",
        System.Security.Authentication.AuthenticationException => "falló el TLS con la API cifrada (¿api-ssl sin certificado?)",
        IOException io => io.Message,
        TimeoutException timeout => timeout.Message,
        _ => $"{exception.GetType().Name}: {exception.Message}",
    };
}
