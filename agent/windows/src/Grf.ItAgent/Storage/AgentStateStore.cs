using System.Text.Json;
using System.Text.Json.Serialization;

namespace Grf.ItAgent.Storage;

internal sealed class AgentStateStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    private readonly string _path;
    private AgentState _state = new(null);

    public AgentStateStore(string path)
    {
        _path = Path.GetFullPath(path);
    }

    public void Load()
    {
        if (!File.Exists(_path))
        {
            return;
        }

        try
        {
            var bytes = File.ReadAllBytes(_path);
            _state = JsonSerializer.Deserialize<AgentState>(bytes, JsonOptions) ?? new AgentState(null);
        }
        catch (JsonException)
        {
            _state = new AgentState(null);
        }
    }

    public bool IsInventoryDue(DateTimeOffset now, TimeSpan interval)
    {
        return _state.LastInventoryAt is null
            || _state.LastInventoryAt > now
            || now - _state.LastInventoryAt >= interval;
    }

    public void MarkInventoryAccepted(DateTimeOffset collectedAt)
    {
        _state = new AgentState(collectedAt);
        AtomicFile.WriteAllBytes(_path, JsonSerializer.SerializeToUtf8Bytes(_state, JsonOptions));
    }

    private sealed record AgentState(DateTimeOffset? LastInventoryAt);
}
