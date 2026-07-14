using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Grf.ItAgent.Http;

internal sealed class UtcDateTimeOffsetJsonConverter : JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String
            || !reader.TryGetDateTimeOffset(out var value))
        {
            throw new JsonException("Se esperaba una fecha ISO válida.");
        }

        return value.ToUniversalTime();
    }

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options)
    {
        // Backend z.string().datetime() accepts UTC with Z but intentionally rejects numeric
        // offsets. Round-trip format preserves precision and DateTimeKind.Utc emits the Z suffix.
        writer.WriteStringValue(value.UtcDateTime.ToString("O", CultureInfo.InvariantCulture));
    }
}
