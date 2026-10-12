namespace Grf.NetCollector.Configuration;

internal static class Secrets
{
    /// <summary>
    /// Lee una variable de máquina. La tarea corre como SYSTEM y las claves se cargan como
    /// variables de sistema; leerlas del registro de máquina evita depender del entorno
    /// heredado (un proceso lanzado antes de cargarlas, como el sshd, no las ve).
    /// </summary>
    public static string? Read(string name)
    {
        var value = OperatingSystem.IsWindows()
            ? Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.Machine) ?? Environment.GetEnvironmentVariable(name)
            : Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }
}
