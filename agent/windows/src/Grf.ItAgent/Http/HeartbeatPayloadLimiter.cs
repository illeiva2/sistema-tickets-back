using System.Text.Json;
using Grf.ItAgent.Contracts;

namespace Grf.ItAgent.Http;

internal static class HeartbeatPayloadLimiter
{
    // The API parser is capped at 512 KiB. Leave room for transport/parser overhead and
    // future fixed fields instead of targeting the hard limit.
    public const int MaximumPayloadBytes = 450_000;

    public static SerializedHeartbeat Serialize(HeartbeatRequest request, int maximumBytes = MaximumPayloadBytes)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maximumBytes, 1_024);

        var candidate = request;
        while (true)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(candidate, AgentJson.Options);
            if (bytes.Length <= maximumBytes)
            {
                return new SerializedHeartbeat(bytes, candidate.Inventory is not null);
            }

            var software = candidate.Inventory?.Software;
            if (software is { Count: > 0 })
            {
                var nextCount = software.Count == 1 ? 0 : software.Count / 2;
                var reducedSoftware = nextCount == 0 ? null : software.Take(nextCount).ToArray();
                candidate = candidate with
                {
                    Inventory = candidate.Inventory! with { Software = reducedSoftware },
                };
                continue;
            }

            if (candidate.Inventory is not null)
            {
                candidate = candidate with { Inventory = null };
                continue;
            }

            throw new InvalidDataException("La telemetría base excede el tamaño máximo permitido.");
        }
    }
}

internal sealed record SerializedHeartbeat(byte[] Bytes, bool InventoryIncluded);
