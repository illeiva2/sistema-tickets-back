using System.Text.Json;
using Grf.NetCollector.Contracts;

namespace Grf.NetCollector.Storage;

/// <summary>
/// Lo que el colector recuerda entre corridas (corre cada minuto y termina): huellas de los
/// certificados, la sesión del controlador UniFi y la última lista de APs. Vive en la carpeta
/// de datos, que el instalador deja sólo para SYSTEM y Administradores.
/// </summary>
internal sealed class CollectorState
{
    public Dictionary<string, string> Pins { get; set; } = new(StringComparer.Ordinal);
    public UniFiState UniFi { get; set; } = new();
    /// <summary>
    /// De quién cuelga cada equipo (y por qué puertos) según la última corrida en que los dos
    /// respondieron. Sirve para no cambiar el árbol cuando un switch del medio no contesta un rato.
    /// </summary>
    public Dictionary<string, CachedParent> Parents { get; set; } = new(StringComparer.Ordinal);

    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static CollectorState Load(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                var state = JsonSerializer.Deserialize<CollectorState>(File.ReadAllText(path), Options);
                if (state is not null)
                {
                    state.Pins = new Dictionary<string, string>(state.Pins, StringComparer.Ordinal);
                    state.Parents = new Dictionary<string, CachedParent>(state.Parents ?? [], StringComparer.Ordinal);
                    return state;
                }
            }
        }
        catch (JsonException)
        {
            // Un estado roto no frena el sondeo: se empieza de cero (y se vuelven a anotar las huellas).
        }

        return new CollectorState();
    }

    public void Save(string path)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(path))!;
        Directory.CreateDirectory(directory);
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this, Options));
        File.Move(temporary, path, overwrite: true);
    }
}

internal sealed class UniFiState
{
    public DateTimeOffset? PolledAt { get; set; }
    public string? SessionCookie { get; set; }
    public string? CsrfToken { get; set; }
    public List<CachedAp> Aps { get; set; } = [];
}

/// <summary>
/// AP conocido por la última lectura de UniFi: alcanza para ubicarlo en las tablas MAC y, con sus
/// vecinos LLDP, para que su enlace sea el mismo en las corridas que no leen UniFi.
/// </summary>
internal sealed record CachedAp(string Key, string Mac, string Name, string? Ip = null, List<CachedNeighbor>? Neighbors = null);

/// <summary>Vecino LLDP que un AP informa en uno de sus puertos.</summary>
internal sealed record CachedNeighbor(string Port, NeighborSnapshot Neighbor);

/// <summary>Último padre conocido de un equipo en el árbol, con los puertos de cada lado.</summary>
internal sealed record CachedParent(string Parent, List<string> ParentPorts, List<string> ChildPorts);
