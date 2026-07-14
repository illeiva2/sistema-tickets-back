namespace Grf.ItAgent.Telemetry;

internal static class MachineIdentity
{
    public static string GetHostname()
    {
        var hostname = Environment.MachineName.Trim();
        if (hostname.Length is < 1 or > 255
            || !IsAsciiLetterOrDigit(hostname[0])
            || !IsAsciiLetterOrDigit(hostname[^1])
            || hostname.Any(character => !IsAsciiLetterOrDigit(character) && character is not '.' and not '_' and not '-'))
        {
            throw new InvalidDataException("El hostname de Windows no cumple el contrato del agente.");
        }

        return hostname;
    }

    private static bool IsAsciiLetterOrDigit(char value) => char.IsAsciiLetterOrDigit(value);
}
