using System.Net;
using Lextm.SharpSnmpLib;
using Lextm.SharpSnmpLib.Messaging;

namespace Grf.NetCollector.Snmp;

/// <summary>Sólo GET y GETBULK/GETNEXT con una community de lectura: nunca SET.</summary>
internal sealed class SnmpClient
{
    private const int MaxRepetitions = 20;
    private readonly IPEndPoint _endpoint;
    private readonly OctetString _community;
    private readonly int _timeoutMs;

    private SnmpClient(IPEndPoint endpoint, OctetString community, int timeoutMs, VersionCode version)
    {
        _endpoint = endpoint;
        _community = community;
        _timeoutMs = timeoutMs;
        Version = version;
    }

    public VersionCode Version { get; }

    /// <summary>Columnas que no se pudieron leer completas (se usó lo que llegó).</summary>
    public List<string> Failures { get; } = [];

    /// <summary>Prueba v2c y después v1 (el SwOS viejo sólo habla v1). Null si no contesta ninguna.</summary>
    public static SnmpClient? Open(IPEndPoint endpoint, string community, int timeoutMs)
    {
        var octets = new OctetString(community);
        // v2c, v1 y otra vez v2c: el SwOS a veces no contesta un pedido suelto y, sin el tercer
        // intento, toda la corrida lo daba por caído (y con él, el árbol de lo que cuelga).
        var attempts = new[] { VersionCode.V2, VersionCode.V1, VersionCode.V2 };
        for (var attempt = 0; attempt < attempts.Length; attempt++)
        {
            var version = attempts[attempt];
            if (attempt == attempts.Length - 1)
            {
                Thread.Sleep(500);
            }

            try
            {
                Messenger.Get(version, endpoint, octets, [new Variable(new ObjectIdentifier(Oids.SysName))], timeoutMs);
                return new SnmpClient(endpoint, octets, timeoutMs, version);
            }
            catch (Exception exception) when (exception is Lextm.SharpSnmpLib.Messaging.TimeoutException or ErrorException or System.Net.Sockets.SocketException)
            {
                // Sin respuesta con esta versión: se prueba la siguiente.
            }
        }

        return null;
    }

    public Dictionary<string, ISnmpData> Get(params string[] oids)
    {
        var result = new Dictionary<string, ISnmpData>(StringComparer.Ordinal);
        var variables = Messenger.Get(Version, _endpoint, _community, oids.Select(oid => new Variable(new ObjectIdentifier(oid))).ToList(), _timeoutMs);
        foreach (var variable in variables)
        {
            if (IsValue(variable.Data))
            {
                result[variable.Id.ToString()] = variable.Data;
            }
        }

        return result;
    }

    /// <summary>Recorre una columna. Lo que el equipo no implementa da vacío; un timeout, lo leído hasta ahí.</summary>
    public Dictionary<string, ISnmpData> Walk(string column)
    {
        var list = new List<Variable>();
        try
        {
            if (Version == VersionCode.V1)
            {
                Messenger.Walk(Version, _endpoint, _community, new ObjectIdentifier(column), list, _timeoutMs, WalkMode.WithinSubtree);
            }
            else
            {
                Messenger.BulkWalk(Version, _endpoint, _community, OctetString.Empty, new ObjectIdentifier(column), list, _timeoutMs, MaxRepetitions, WalkMode.WithinSubtree, null, null);
            }
        }
        catch (Exception exception) when (exception is Lextm.SharpSnmpLib.Messaging.TimeoutException or ErrorException or SnmpException)
        {
            // Se usa lo que haya llegado. Algunos TP-Link mandan respuestas que la librería no puede
            // decodificar (p. ej. en las tablas LLDP): eso no puede dejar al switch entero sin leer.
            Failures.Add($"columna {column} incompleta ({exception.GetType().Name}: {exception.Message})");
        }

        var prefix = column + ".";
        var result = new Dictionary<string, ISnmpData>(StringComparer.Ordinal);
        foreach (var variable in list)
        {
            var id = variable.Id.ToString();
            if (id.StartsWith(prefix, StringComparison.Ordinal) && IsValue(variable.Data))
            {
                result[id[prefix.Length..]] = variable.Data;
            }
        }

        return result;
    }

    private static bool IsValue(ISnmpData data) =>
        data.TypeCode is not (SnmpType.NoSuchInstance or SnmpType.NoSuchObject or SnmpType.EndOfMibView or SnmpType.Null);
}
