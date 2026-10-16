using System.Diagnostics;
using System.Net;
using Grf.NetCollector.Configuration;
using Grf.NetCollector.Polling;
using Lextm.SharpSnmpLib;

namespace Grf.NetCollector.Snmp;

/// <summary>Lee un switch por SNMP v2c (o v1) con la community de sólo lectura.</summary>
internal sealed class SnmpPoller(SnmpSection settings, Func<string, string?> readSecret, Action<string>? warn = null)
{
    public PollResult Poll(DeviceEntry entry)
    {
        var clock = Stopwatch.StartNew();
        var variable = entry.CommunityVariable ?? settings.CommunityVariable;
        if (readSecret(variable) is not { } community)
        {
            return PollResult.Failed(entry.Ip, "snmp", entry.Role, entry.Ip, $"falta la variable {variable}", clock.ElapsedMilliseconds);
        }

        try
        {
            var client = SnmpClient.Open(new IPEndPoint(IPAddress.Parse(entry.Ip), 161), community, settings.TimeoutMs);
            if (client is null)
            {
                return PollResult.Failed(entry.Ip, "snmp", entry.Role, entry.Ip,
                    "sin respuesta SNMP (¿community, IP permitida o SNMP apagado?)", clock.ElapsedMilliseconds);
            }

            var scalars = new Dictionary<string, ISnmpData>(StringComparer.Ordinal);
            foreach (var (oid, value) in client.Get(Oids.SysDescr, Oids.SysObjectId, Oids.SysUpTime, Oids.SysName))
            {
                scalars[oid] = value;
            }

            try
            {
                foreach (var (oid, value) in client.Get(Oids.BaseBridgeAddress))
                {
                    scalars[oid] = value;
                }
            }
            catch (Exception exception) when (exception is Lextm.SharpSnmpLib.Messaging.ErrorException or Lextm.SharpSnmpLib.Messaging.TimeoutException)
            {
                // Sin BRIDGE-MIB: se identifica sólo por las MACs de los puertos.
            }

            var columns = new Dictionary<string, Dictionary<string, ISnmpData>>(StringComparer.Ordinal);
            foreach (var column in Oids.Columns)
            {
                columns[column] = client.Walk(column);
            }

            // La FDB de BRIDGE-MIB (sin VLAN) sólo si el equipo no tiene la de Q-BRIDGE (el SwOS).
            if (columns[Oids.QFdbPort].Count == 0)
            {
                columns[Oids.FdbPort] = client.Walk(Oids.FdbPort);
                columns[Oids.FdbStatus] = client.Walk(Oids.FdbStatus);
            }

            // PoE: un equipo sin PoE contesta vacío y no cuesta más que una consulta por columna.
            foreach (var column in Oids.PoeColumns(scalars.GetValueOrDefault(Oids.SysObjectId)?.ToString()))
            {
                columns[column] = client.Walk(column);
            }

            foreach (var failure in client.Failures)
            {
                warn?.Invoke($"{entry.Ip}: {failure}");
            }

            return SnmpMapping.Build(entry, new SnmpReadout { Scalars = scalars, Columns = columns }, clock.ElapsedMilliseconds);
        }
        catch (Exception exception)
        {
            return PollResult.Failed(entry.Ip, "snmp", entry.Role, entry.Ip, $"{exception.GetType().Name}: {exception.Message}", clock.ElapsedMilliseconds);
        }
    }
}
