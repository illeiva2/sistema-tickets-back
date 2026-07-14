using System.Text.Json;
using System.Text.Json.Serialization;
using Grf.ItAgent.Storage;

namespace Grf.ItAgent.Updates;

internal sealed record UpdateAttemptState(
    int SchemaVersion,
    int ConsecutiveFailures,
    DateTimeOffset NextAttemptAt);

internal sealed class UpdateAttemptStore
{
    private const int MaximumStateBytes = 4 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    private readonly string _path;

    public UpdateAttemptStore(string updatesDirectory)
    {
        _path = Path.Combine(Path.GetFullPath(updatesDirectory), "check-state.json");
    }

    public UpdateAttemptState? Load()
    {
        var file = new FileInfo(_path);
        if (!file.Exists || file.Length is <= 0 or > MaximumStateBytes)
        {
            return null;
        }

        try
        {
            using var stream = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read);
            var state = JsonSerializer.Deserialize<UpdateAttemptState>(stream, JsonOptions);
            return state is
            {
                SchemaVersion: 1,
                ConsecutiveFailures: >= 0 and <= 30,
            }
                ? state
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public void Save(UpdateAttemptState state)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(state, JsonOptions);
        AtomicFile.WriteAllBytes(_path, bytes);
    }
}
