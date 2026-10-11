namespace Grf.ItAgent.Telemetry;

internal static class MachineIdentity
{
    public static string GetHostname()
    {
        var hostname = Environment.MachineName.Trim();
        if (!IsValidHostname(hostname))
        {
            throw new InvalidDataException("El hostname de Windows no cumple el contrato del agente.");
        }

        return hostname;
    }

    // Windows admite letras con acento y ñ en el nombre del equipo (p. ej. CONTADURÍA);
    // la API acepta el mismo conjunto: letras y dígitos Unicode más '.', '_' y '-'.
    internal static bool IsValidHostname(string hostname)
    {
        return hostname.Length is >= 1 and <= 255
               && char.IsLetterOrDigit(hostname[0])
               && char.IsLetterOrDigit(hostname[^1])
               && hostname.All(character => char.IsLetterOrDigit(character) || character is '.' or '_' or '-');
    }
}
