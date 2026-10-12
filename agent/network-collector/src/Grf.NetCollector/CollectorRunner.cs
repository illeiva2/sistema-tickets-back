using System.Diagnostics;
using System.Reflection;
using Grf.NetCollector.Configuration;
using Grf.NetCollector.Contracts;
using Grf.NetCollector.Logging;
using Grf.NetCollector.Polling;
using Grf.NetCollector.RouterOs;
using Grf.NetCollector.Security;
using Grf.NetCollector.Snmp;
using Grf.NetCollector.Storage;
using Grf.NetCollector.Topology;
using Grf.NetCollector.UniFi;

namespace Grf.NetCollector;

internal sealed record CollectionRun(SnapshotPayload Payload, bool UniFiPolled, IReadOnlyList<PollResult> Results);

/// <summary>Una corrida: sondea todo en paralelo, deduce los enlaces y arma el envío.</summary>
internal sealed class CollectorRunner(CollectorConfig config, CollectorState state, CollectorLog log, Func<string, string?> readSecret)
{
    public static string Version =>
        typeof(CollectorRunner).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(CollectorRunner).Assembly.GetName().Version?.ToString(3)
        ?? "0.0.0";

    public async Task<CollectionRun> RunAsync(CancellationToken cancellationToken)
    {
        var startedAt = DateTimeOffset.UtcNow;
        var pins = new CertificatePins(state);
        var routerOs = new RouterOsPoller(config.RouterOs, readSecret(config.RouterOs.PasswordVariable), pins);
        var snmp = new SnmpPoller(config.Snmp, readSecret, log.Warn);

        using var gate = new SemaphoreSlim(config.Parallelism);
        var polls = config.Devices.Select(async entry =>
        {
            await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                return await PollWithTimeout(entry, routerOs, snmp, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                gate.Release();
            }
        }).ToList();

        var results = (await Task.WhenAll(polls).ConfigureAwait(false)).ToList();
        foreach (var result in results.Where(result => !result.Snapshot.Reachable))
        {
            log.Warn($"{result.Snapshot.Key}: {result.Snapshot.Error}");
        }

        var (aps, uniFiPolled) = await PollUniFiIfDue(pins, cancellationToken).ConfigureAwait(false);
        results.AddRange(aps);

        var links = LinkInference.Infer(results, state.UniFi.Aps);
        var endpoints = EndpointInference.Infer(results, state.UniFi.Aps, links, config.Endpoints);
        var payload = new SnapshotPayload(
            new CollectorInfo(Version, Environment.MachineName),
            startedAt,
            DateTimeOffset.UtcNow,
            results.Select(result => result.Snapshot).ToList(),
            links,
            config.Endpoints.Enabled ? endpoints : null);

        return new CollectionRun(payload, uniFiPolled, results);
    }

    private async Task<PollResult> PollWithTimeout(DeviceEntry entry, RouterOsPoller routerOs, SnmpPoller snmp, CancellationToken cancellationToken)
    {
        var clock = Stopwatch.StartNew();
        // Los clientes de RouterOS y SNMP son sincrónicos con sus propios timeouts; esto es la red de seguridad.
        var work = Task.Run(() => entry.Driver == DeviceEntry.RouterOsDriver ? routerOs.Poll(entry) : snmp.Poll(entry), cancellationToken);
        var finished = await Task.WhenAny(work, Task.Delay(TimeSpan.FromSeconds(config.DeviceTimeoutSeconds), cancellationToken)).ConfigureAwait(false);
        return finished == work
            ? await work.ConfigureAwait(false)
            : PollResult.Failed(entry.Ip, entry.Driver, entry.Role, entry.Ip, $"el sondeo pasó los {config.DeviceTimeoutSeconds} s", clock.ElapsedMilliseconds);
    }

    private async Task<(List<PollResult> Aps, bool Polled)> PollUniFiIfDue(CertificatePins pins, CancellationToken cancellationToken)
    {
        var settings = config.UniFi;
        if (settings is null)
        {
            return ([], false);
        }

        var due = state.UniFi.PolledAt is not { } last || DateTimeOffset.UtcNow - last >= TimeSpan.FromMinutes(settings.EveryMinutes) - TimeSpan.FromSeconds(20);
        if (!due)
        {
            return ([], false);
        }

        var user = readSecret(settings.UserVariable);
        var password = readSecret(settings.PasswordVariable);
        if (user is null || password is null)
        {
            log.Warn($"UniFi: faltan las variables {settings.UserVariable} / {settings.PasswordVariable}");
            return ([], false);
        }

        var clock = Stopwatch.StartNew();
        try
        {
            using var client = new UniFiClient(settings, user, password, state, pins);
            var devices = await client.GetDevicesAsync(cancellationToken).ConfigureAwait(false);
            var (aps, cache) = UniFiMapping.Build(devices, clock.ElapsedMilliseconds);
            state.UniFi.PolledAt = DateTimeOffset.UtcNow;
            state.UniFi.Aps = cache;
            return (aps, true);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // Si el controlador no responde, los APs quedan con su último estado y "sin datos" al rato.
            log.Warn($"UniFi: {(exception is UniFiException ? exception.Message : exception.GetType().Name + ": " + exception.Message)}");
            state.UniFi.PolledAt = DateTimeOffset.UtcNow;
            return ([], false);
        }
    }
}
