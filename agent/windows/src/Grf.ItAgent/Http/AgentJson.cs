using System.Text.Json;
using System.Text.Json.Serialization;

namespace Grf.ItAgent.Http;

internal static class AgentJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Converters = { new UtcDateTimeOffsetJsonConverter() },
    };
}
