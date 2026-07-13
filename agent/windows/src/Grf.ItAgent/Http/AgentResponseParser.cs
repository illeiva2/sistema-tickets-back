using System.Text.Json;
using Grf.ItAgent.Contracts;

namespace Grf.ItAgent.Http;

internal static class AgentResponseParser
{
    public static T DeserializeEnvelope<T>(ReadOnlySpan<byte> bytes)
        where T : class
    {
        try
        {
            var envelope = JsonSerializer.Deserialize<ApiEnvelope<T>>(bytes, AgentJson.Options);
            if (envelope is null || !envelope.Success || envelope.Data is null)
            {
                throw new InvalidDataException("El servidor no confirmó la operación del agente.");
            }

            return envelope.Data;
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("La respuesta del servidor no respeta el contrato esperado.", exception);
        }
    }
}
