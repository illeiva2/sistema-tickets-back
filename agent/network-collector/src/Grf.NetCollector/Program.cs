using System.Diagnostics;
using System.Text.Json;
using Grf.NetCollector;
using Grf.NetCollector.Configuration;
using Grf.NetCollector.Contracts;
using Grf.NetCollector.Logging;
using Grf.NetCollector.Storage;
using Grf.NetCollector.Upload;

// GRF.NetCollector: lee router, switches y APs en sólo lectura y envía el estado al sistema de
// tickets. Lo corre una tarea programada cada minuto (como SYSTEM): sondea, envía y termina.
//
//   GRF.NetCollector.exe [--config <ruta>] [--dry-run] [--json <archivo>] [--verbose]
//
//   --dry-run   sondea y muestra un resumen, sin enviar nada al back.
//   --json      además guarda el envío completo en ese archivo (para revisar o depurar).

Console.OutputEncoding = System.Text.Encoding.UTF8;
var options = CliOptions.Parse(args);
if (options.Error is not null)
{
    Console.Error.WriteLine(options.Error);
    Console.Error.WriteLine("Uso: GRF.NetCollector.exe [--config <ruta>] [--dry-run] [--json <archivo>] [--verbose]");
    return 64;
}

CollectorConfig config;
try
{
    config = CollectorConfig.Load(options.ConfigPath ?? Path.Combine(CollectorConfig.DefaultDataDirectory, "appsettings.json"));
}
catch (ConfigurationException exception)
{
    Console.Error.WriteLine("Configuración inválida:");
    Console.Error.WriteLine(exception.Message);
    return 78;
}

var log = new CollectorLog(config.DataDirectory, echo: options.Verbose || options.DryRun);
var statePath = Path.Combine(config.DataDirectory, "state.json");
var state = CollectorState.Load(statePath);
using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(4));

try
{
    var clock = Stopwatch.StartNew();
    var run = await new CollectorRunner(config, state, log, Secrets.Read).RunAsync(cancellation.Token);
    var payload = run.Payload;
    var polled = payload.Devices.Where(device => device.Source != "unifi").ToList();
    var aps = payload.Devices.Where(device => device.Source == "unifi").ToList();
    var summary = $"{polled.Count} equipos ({polled.Count(device => device.Reachable)} OK)" +
        (run.UniFiPolled ? $", {aps.Count} APs de UniFi ({aps.Count(device => device.Reachable)} conectados)" : "") +
        $", {payload.Links.Count} enlaces, sondeo en {clock.Elapsed.TotalSeconds:0.0} s";

    if (options.JsonPath is not null)
    {
        await File.WriteAllTextAsync(options.JsonPath, JsonSerializer.Serialize(payload, SnapshotJson.Indented), cancellation.Token);
    }

    if (options.DryRun)
    {
        DryRunReport.Print(payload);
        if (options.TopologyDebug)
        {
            Console.WriteLine();
            Console.WriteLine("Tablas MAC (dónde ve cada switch a los demás equipos de red):");
            foreach (var line in Grf.NetCollector.Topology.LinkInference.Explain(run.Results))
            {
                Console.WriteLine(line);
            }
        }

        log.Info("Prueba sin envío: " + summary);
        state.Save(statePath);
        return 0;
    }

    if (Secrets.Read(config.Api.SecretVariable) is not { } secret)
    {
        log.Error($"Falta la variable {config.Api.SecretVariable} con la credencial del colector; no se envió nada.");
        state.Save(statePath);
        return 2;
    }

    var upload = await new SnapshotUploader(config.Api, secret).UploadAsync(payload, cancellation.Token);
    state.Save(statePath);
    if (upload.Ok)
    {
        log.Info(summary + ", envío OK");
        log.Prune();
        return 0;
    }

    log.Error(summary + ", el envío falló: " + upload.Message);
    return 2;
}
catch (OperationCanceledException)
{
    log.Error("La corrida pasó los 4 minutos y se cortó.");
    state.Save(statePath);
    return 3;
}
catch (Exception exception)
{
    log.Error($"Error inesperado: {exception.GetType().Name}: {exception.Message}");
    return 3;
}

internal sealed record CliOptions(string? ConfigPath, bool DryRun, string? JsonPath, bool Verbose, string? Error, bool TopologyDebug = false)
{
    public static CliOptions Parse(string[] args)
    {
        string? config = null;
        string? json = null;
        var dryRun = false;
        var verbose = false;
        var topologyDebug = false;
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--config" when index + 1 < args.Length:
                    config = args[++index];
                    break;
                case "--json" when index + 1 < args.Length:
                    json = args[++index];
                    break;
                case "--dry-run":
                    dryRun = true;
                    break;
                case "--verbose":
                    verbose = true;
                    break;
                case "--topology-debug":
                    topologyDebug = true;
                    dryRun = true;
                    break;
                case "--once":
                    // Compatibilidad: correr una vez es lo único que hace.
                    break;
                default:
                    return new CliOptions(null, false, null, false, $"Argumento desconocido: {args[index]}");
            }
        }

        return new CliOptions(config, dryRun, json, verbose, null, topologyDebug);
    }
}
