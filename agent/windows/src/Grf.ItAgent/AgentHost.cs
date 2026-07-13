using System.Net;
using System.Security.Cryptography;
using Grf.ItAgent.Configuration;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Http;
using Grf.ItAgent.Logging;
using Grf.ItAgent.Security;
using Grf.ItAgent.Storage;
using Grf.ItAgent.Telemetry;
using Grf.ItAgent.Utilities;

namespace Grf.ItAgent;

internal sealed class AgentHost : IDisposable
{
    private readonly AgentConfiguration _configuration;
    private readonly string _tokenPath;
    private readonly CredentialStore _credentialStore;
    private readonly AgentStateStore _stateStore;
    private readonly AgentApiClient _apiClient;
    private readonly SafeFileLogger _logger;
    private readonly TelemetryCollector _telemetryCollector = new();

    public AgentHost(AgentConfiguration configuration, string configPath, SafeFileLogger logger)
    {
        _configuration = configuration;
        _logger = logger;
        _tokenPath = ConfigurationLoader.ResolveDataFile(configPath, configuration.EnrollmentTokenFile);
        _credentialStore = new CredentialStore(
            ConfigurationLoader.ResolveDataFile(configPath, configuration.CredentialFile),
            new DpapiSecretProtector());
        _stateStore = new AgentStateStore(ConfigurationLoader.ResolveDataFile(configPath, configuration.StateFile));
        _apiClient = new AgentApiClient(configuration);
    }

    public async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        _logger.Write(LogSeverity.Information, "AgentStarted");
        DeviceCredentials credentials;
        try
        {
            credentials = await GetOrCreateCredentialsAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return 0;
        }
        catch (AgentApiException exception)
        {
            _logger.Write(LogSeverity.Error, "EnrollmentRejected", exception, (int)exception.StatusCode);
            return 3;
        }
        catch (Exception exception)
        {
            _logger.Write(LogSeverity.Error, "EnrollmentFailed", exception);
            return 3;
        }

        _stateStore.Load();
        string? previousServerState = null;
        while (!cancellationToken.IsCancellationRequested)
        {
            var delaySeconds = _configuration.HeartbeatSeconds;
            try
            {
                var inventoryDue = _stateStore.IsInventoryDue(
                    DateTimeOffset.UtcNow,
                    TimeSpan.FromMinutes(_configuration.InventoryIntervalMinutes));
                var heartbeat = await _telemetryCollector
                    .CollectAsync(inventoryDue, cancellationToken)
                    .ConfigureAwait(false);
                var result = await _apiClient
                    .SendHeartbeatAsync(credentials, heartbeat, cancellationToken)
                    .ConfigureAwait(false);

                if (result.InventoryIncluded && heartbeat.Inventory?.CollectedAt is { } collectedAt)
                {
                    _stateStore.MarkInventoryAccepted(collectedAt);
                }

                if (!string.Equals(previousServerState, result.Response.State, StringComparison.Ordinal))
                {
                    _logger.Write(LogSeverity.Information, "HeartbeatStateChanged");
                    previousServerState = result.Response.State;
                }

                delaySeconds = result.Response.NextHeartbeatSeconds;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (AgentApiException exception)
            {
                _logger.Write(LogSeverity.Warning, "HeartbeatRejected", exception, (int)exception.StatusCode);
            }
            catch (Exception exception)
            {
                _logger.Write(LogSeverity.Warning, "HeartbeatFailed", exception);
            }

            try
            {
                await Task.Delay(
                    HeartbeatSchedule.WithJitter(delaySeconds, Random.Shared.NextDouble()),
                    cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
        }

        _logger.Write(LogSeverity.Information, "AgentStopped");
        return 0;
    }

    public void Dispose()
    {
        _apiClient.Dispose();
    }

    private async Task<DeviceCredentials> GetOrCreateCredentialsAsync(CancellationToken cancellationToken)
    {
        var stored = _credentialStore.Load();
        if (stored is not null && string.Equals(stored.Status, CredentialStore.EnrolledStatus, StringComparison.Ordinal))
        {
            WipeTokenArtifacts();
            return CredentialStore.GetDeviceCredentials(stored);
        }

        var token = PlaintextTokenFile.Read(_tokenPath);
        var fingerprint = EnrollmentSecrets.FingerprintToken(token);
        string deviceSecret;
        if (stored is not null)
        {
            if (!string.Equals(stored.Status, CredentialStore.PendingStatus, StringComparison.Ordinal)
                || stored.TokenFingerprint is null
                || !EnrollmentSecrets.FingerprintsMatch(stored.TokenFingerprint, fingerprint))
            {
                throw new CryptographicException("El token no coincide con el enrolamiento pendiente.");
            }

            deviceSecret = stored.DeviceSecret;
        }
        else
        {
            deviceSecret = EnrollmentSecrets.GenerateDeviceSecret();
            // This durable DPAPI write happens before the first HTTP request. A crash after the
            // server commit can therefore retry with the exact same token, machine and secret.
            _credentialStore.SavePending(deviceSecret, fingerprint);
        }

        var os = WindowsIdentityCollector.GetOs();
        var request = new EnrollRequest(
            token,
            deviceSecret,
            WindowsIdentityCollector.GetMachineGuid(),
            MachineIdentity.GetHostname(),
            AgentVersion.Current,
            os.Name,
            os.Version);
        var response = await _apiClient.EnrollAsync(request, cancellationToken).ConfigureAwait(false);

        _credentialStore.SaveEnrolled(response.DeviceId, deviceSecret);
        WipeTokenArtifacts();
        _logger.Write(LogSeverity.Information, "EnrollmentSucceeded");
        return new DeviceCredentials(response.DeviceId, deviceSecret);
    }

    private void WipeTokenArtifacts()
    {
        PlaintextTokenFile.WipeAndDelete(_tokenPath);
        PlaintextTokenFile.WipeAndDelete(_tokenPath + ".tmp");
    }
}
