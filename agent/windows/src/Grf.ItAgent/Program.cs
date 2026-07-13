using Grf.ItAgent.Configuration;
using Grf.ItAgent.Logging;

namespace Grf.ItAgent;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        string configPath;
        AgentConfiguration configuration;
        try
        {
            configPath = ResolveConfigPath(args);
            configuration = ConfigurationLoader.Load(configPath);
        }
        catch
        {
            Console.Error.WriteLine("GRF.ITAgent: configuración inválida.");
            return 2;
        }

        var logPath = ConfigurationLoader.ResolveDataFile(configPath, configuration.LogFile);
        var logger = new SafeFileLogger(logPath);
        FileStream? instanceLock = null;
        try
        {
            var lockPath = ConfigurationLoader.ResolveDataFile(configPath, configuration.LockFile);
            try
            {
                // ProgramData is ACL-restricted by install.ps1. Holding this file without sharing
                // avoids a globally named mutex that an unprivileged user could pre-create.
                instanceLock = new FileStream(
                    lockPath,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 1,
                    FileOptions.WriteThrough);
            }
            catch (IOException)
            {
                logger.Write(LogSeverity.Information, "DuplicateInstanceIgnored");
                return 0;
            }

            using var cancellation = new CancellationTokenSource();
            Console.CancelKeyPress += (_, eventArgs) =>
            {
                eventArgs.Cancel = true;
                cancellation.Cancel();
            };
            AppDomain.CurrentDomain.ProcessExit += (_, _) => cancellation.Cancel();

            using var host = new AgentHost(configuration, configPath, logger);
            return await host.RunAsync(cancellation.Token).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            logger.Write(LogSeverity.Error, "AgentFatal", exception);
            return 1;
        }
        finally
        {
            instanceLock?.Dispose();
        }
    }

    internal static string ResolveConfigPath(IReadOnlyList<string> args)
    {
        string? configuredPath = null;
        for (var index = 0; index < args.Count; index++)
        {
            if (string.Equals(args[index], "--run", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (string.Equals(args[index], "--config", StringComparison.OrdinalIgnoreCase)
                && index + 1 < args.Count
                && configuredPath is null)
            {
                configuredPath = args[++index];
                continue;
            }

            throw new ConfigurationException("Argumentos no reconocidos.");
        }

        return Path.GetFullPath(configuredPath ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "GRF",
            "ITAgent",
            "config.json"));
    }
}
