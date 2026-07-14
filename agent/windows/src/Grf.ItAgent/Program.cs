using Grf.ItAgent.Configuration;
using Grf.ItAgent.Logging;
using Grf.ItAgent.Telemetry;
using Grf.ItAgent.Updates;

namespace Grf.ItAgent;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        ProgramOptions options;
        string configPath;
        AgentConfiguration configuration;
        try
        {
            options = ParseOptions(args);
            configPath = options.ConfigPath;
            configuration = ConfigurationLoader.Load(configPath);
        }
        catch
        {
            Console.Error.WriteLine("GRF.ITAgent: configuración inválida.");
            return 2;
        }

        if (options.Mode == AgentRunMode.ValidateInstall)
        {
            return ValidateInstall();
        }

        var logPath = ConfigurationLoader.ResolveDataFile(configPath, configuration.LogFile);
        var logger = new SafeFileLogger(logPath);
        if (options.Mode == AgentRunMode.PrepareUpdate)
        {
            return await PrepareUpdateAsync(configuration, configPath, logger).ConfigureAwait(false);
        }

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
        return ParseOptions(args).ConfigPath;
    }

    internal static ProgramOptions ParseOptions(IReadOnlyList<string> args)
    {
        string? configuredPath = null;
        var mode = AgentRunMode.Run;
        var explicitMode = false;
        for (var index = 0; index < args.Count; index++)
        {
            if (string.Equals(args[index], "--run", StringComparison.OrdinalIgnoreCase))
            {
                if (explicitMode)
                {
                    throw new ConfigurationException("Sólo se permite un modo de ejecución.");
                }

                mode = AgentRunMode.Run;
                explicitMode = true;
                continue;
            }

            if (string.Equals(args[index], "--prepare-update", StringComparison.OrdinalIgnoreCase))
            {
                if (explicitMode)
                {
                    throw new ConfigurationException("Sólo se permite un modo de ejecución.");
                }

                mode = AgentRunMode.PrepareUpdate;
                explicitMode = true;
                continue;
            }

            if (string.Equals(args[index], "--validate-install", StringComparison.OrdinalIgnoreCase))
            {
                if (explicitMode)
                {
                    throw new ConfigurationException("Sólo se permite un modo de ejecución.");
                }

                mode = AgentRunMode.ValidateInstall;
                explicitMode = true;
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

        var configPath = Path.GetFullPath(configuredPath ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "GRF",
            "ITAgent",
            "config.json"));
        return new ProgramOptions(mode, configPath);
    }

    private static int ValidateInstall()
    {
        try
        {
            _ = SemanticVersion.Parse(AgentVersion.Current);
            var executablePath = Environment.ProcessPath
                ?? throw new InvalidDataException("No se pudo determinar el ejecutable actual.");
            UpdateArtifactPreparer.ValidateWindowsX64Executable(executablePath);
            // This is a machine-readable contract consumed by update-agent.ps1. Keep stdout
            // to one exact SemVer line; diagnostics belong on stderr and non-zero exit codes.
            Console.Out.WriteLine(AgentVersion.Current);
            return 0;
        }
        catch
        {
            return 2;
        }
    }

    private static async Task<int> PrepareUpdateAsync(
        AgentConfiguration configuration,
        string configPath,
        SafeFileLogger logger)
    {
        if (!configuration.Update.Enabled)
        {
            logger.Write(LogSeverity.Warning, "UpdateDisabled");
            return 2;
        }

        try
        {
            var dataDirectory = Path.GetDirectoryName(Path.GetFullPath(configPath))
                ?? throw new DirectoryNotFoundException("La configuración no tiene directorio.");
            using var coordinator = new UpdateCoordinator(
                configuration.Update,
                dataDirectory,
                new GithubUpdateTransport(TimeSpan.FromMinutes(10)));
            var result = await coordinator
                .CheckWhenDueAsync(AgentVersion.Current, CancellationToken.None)
                .ConfigureAwait(false);
            logger.Write(LogSeverity.Information, $"Update{result.Status}");
            return result.Status == UpdateCheckStatus.Incompatible ? 3 : 0;
        }
        catch (Exception exception)
        {
            logger.Write(LogSeverity.Error, "UpdatePrepareFailed", exception);
            return 1;
        }
    }
}

internal enum AgentRunMode
{
    Run,
    PrepareUpdate,
    ValidateInstall,
}

internal sealed record ProgramOptions(AgentRunMode Mode, string ConfigPath);
