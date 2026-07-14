using System.Security.Cryptography;
using Grf.ItAgent.Configuration;

namespace Grf.ItAgent.Updates;

internal enum UpdateCheckStatus
{
    NoUpdate,
    Incompatible,
    Deferred,
    AlreadyPrepared,
    Prepared,
}

internal sealed record UpdateCheckResult(UpdateCheckStatus Status, UpdatePlan? Plan = null);

internal sealed class UpdateCoordinator : IDisposable
{
    private readonly UpdateConfiguration _configuration;
    private readonly Uri _manifestUri;
    private readonly IUpdateTransport _transport;
    private readonly UpdateSignatureVerifier _signatureVerifier;
    private readonly UpdatePlanStore _planStore;
    private readonly UpdateAttemptStore _attemptStore;
    private readonly Func<DateTimeOffset> _utcNow;
    private readonly Func<double> _jitterSample;

    public UpdateCoordinator(
        UpdateConfiguration configuration,
        string dataDirectory,
        IUpdateTransport transport,
        Func<DateTimeOffset>? utcNow = null,
        Func<double>? jitterSample = null)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(transport);
        if (!configuration.Enabled)
        {
            throw new ArgumentException("El coordinador requiere update.enabled=true.", nameof(configuration));
        }

        if (!Uri.TryCreate(configuration.ManifestUrl, UriKind.Absolute, out var manifestUri)
            || !GithubUriPolicy.IsAllowed(manifestUri))
        {
            throw new UpdateSecurityException("La URL del manifiesto no está permitida.");
        }

        _manifestUri = manifestUri;
        _configuration = configuration;
        _transport = transport;
        _signatureVerifier = new UpdateSignatureVerifier(configuration.PublicKeyPem);
        _planStore = new UpdatePlanStore(Path.Combine(Path.GetFullPath(dataDirectory), "updates"));
        _attemptStore = new UpdateAttemptStore(_planStore.UpdatesDirectory);
        _utcNow = utcNow ?? (() => DateTimeOffset.UtcNow);
        _jitterSample = jitterSample ?? (() => Random.Shared.NextDouble());
    }

    public string PlanPath => _planStore.PlanPath;

    public async Task<UpdateCheckResult> CheckWhenDueAsync(
        string currentVersionText,
        CancellationToken cancellationToken)
    {
        _planStore.EnsureDirectories();
        var now = _utcNow();
        var previous = _attemptStore.Load();
        if (previous is not null && previous.NextAttemptAt > now)
        {
            return new UpdateCheckResult(UpdateCheckStatus.Deferred);
        }

        try
        {
            var result = await CheckOnceAsync(currentVersionText, cancellationToken).ConfigureAwait(false);
            // Preserve a prepared plan across a not-yet-due invocation so the SYSTEM helper
            // can consume it. Once a newly verified manifest says the update is no longer
            // applicable, invalidate the old publication point before returning.
            if (result.Status is UpdateCheckStatus.NoUpdate or UpdateCheckStatus.Incompatible)
            {
                _planStore.InvalidatePlan();
            }

            _attemptStore.Save(new UpdateAttemptState(
                1,
                0,
                now.AddMinutes(_configuration.CheckIntervalMinutes)));
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            var failures = Math.Min((previous?.ConsecutiveFailures ?? 0) + 1, 30);
            var delay = UpdateBackoff.GetFailureDelay(
                failures - 1,
                TimeSpan.FromMinutes(_configuration.CheckIntervalMinutes),
                _jitterSample());
            _attemptStore.Save(new UpdateAttemptState(1, failures, now.Add(delay)));
            throw;
        }
    }

    public async Task<UpdateCheckResult> CheckOnceAsync(
        string currentVersionText,
        CancellationToken cancellationToken)
    {
        if (!SemanticVersion.TryParse(currentVersionText, out var currentVersion))
        {
            throw new InvalidDataException("La versión actual del agente no es semántica.");
        }

        _planStore.EnsureDirectories();
        using var updateLock = _planStore.AcquireLock();
        var manifestBytes = await _transport
            .GetBytesAsync(_manifestUri, UpdateValidation.MaximumManifestBytes, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var signatureUri = GithubUriPolicy.GetDetachedSignatureUri(_manifestUri);
            var signatureBytes = await _transport
                .GetBytesAsync(signatureUri, UpdateValidation.MaximumSignatureBytes, cancellationToken)
                .ConfigureAwait(false);
            try
            {
                if (!_signatureVerifier.Verify(manifestBytes, signatureBytes))
                {
                    throw new UpdateSecurityException("La firma del manifiesto no es válida.");
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(signatureBytes);
            }

            var manifest = UpdateManifestParser.Parse(manifestBytes);
            if (!string.Equals(manifest.Channel, _configuration.Channel, StringComparison.Ordinal))
            {
                throw new UpdateSecurityException("El canal del manifiesto no coincide con la configuración.");
            }

            if (manifest.PublishedAt > _utcNow().AddHours(24))
            {
                throw new UpdateSecurityException("La fecha del manifiesto está demasiado adelantada.");
            }

            if (currentVersion!.CompareTo(manifest.MinAgentVersion) < 0)
            {
                return new UpdateCheckResult(UpdateCheckStatus.Incompatible);
            }

            if (currentVersion.CompareTo(manifest.Version) >= 0)
            {
                return new UpdateCheckResult(UpdateCheckStatus.NoUpdate);
            }

            var existingPlan = await _planStore
                .TryGetMatchingAsync(manifest, cancellationToken)
                .ConfigureAwait(false);
            if (existingPlan is not null)
            {
                return new UpdateCheckResult(UpdateCheckStatus.AlreadyPrepared, existingPlan);
            }

            return await DownloadAndPrepareAsync(manifest, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(manifestBytes);
        }
    }

    public void Dispose() => _transport.Dispose();

    private async Task<UpdateCheckResult> DownloadAndPrepareAsync(
        UpdateManifest manifest,
        CancellationToken cancellationToken)
    {
        var stagingDirectory = Path.GetDirectoryName(_planStore.GetCandidatePath(manifest.Version))!;
        var sourcePath = Path.Combine(stagingDirectory, $"source-{Guid.NewGuid():N}.download");
        try
        {
            var downloaded = await _transport
                .DownloadFileAsync(manifest.Url, sourcePath, manifest.Size, cancellationToken)
                .ConfigureAwait(false);
            if (downloaded.Size != manifest.Size
                || !FixedTimeHashEquals(downloaded.Sha256, manifest.Sha256))
            {
                throw new UpdateSecurityException("El artefacto no coincide con el manifiesto firmado.");
            }

            var candidatePath = _planStore.GetCandidatePath(manifest.Version);
            var candidate = await UpdateArtifactPreparer
                .PrepareAsync(sourcePath, manifest.Url, candidatePath, cancellationToken)
                .ConfigureAwait(false);
            var now = _utcNow();
            var plan = new UpdatePlan(
                1,
                manifest.Version.ToString(),
                manifest.Channel,
                Path.GetFullPath(candidatePath),
                candidate.Sha256,
                candidate.Size,
                manifest.Sha256,
                manifest.Size,
                manifest.PublishedAt,
                now);
            _planStore.Save(plan);
            return new UpdateCheckResult(UpdateCheckStatus.Prepared, plan);
        }
        finally
        {
            TryDelete(sourcePath);
        }
    }

    private static bool FixedTimeHashEquals(string left, string right)
    {
        try
        {
            return CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(left),
                Convert.FromHexString(right));
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch
        {
            // The random source file is not referenced by the plan and is safe to ignore.
        }
    }
}

internal static class UpdateBackoff
{
    public static TimeSpan GetFailureDelay(int consecutiveFailures, TimeSpan checkInterval, double jitterSample)
    {
        var maximum = checkInterval < TimeSpan.FromHours(6) ? checkInterval : TimeSpan.FromHours(6);
        var baseDelay = maximum < TimeSpan.FromMinutes(5) ? maximum : TimeSpan.FromMinutes(5);
        return Utilities.RetryPolicy.GetDelay(consecutiveFailures, baseDelay, maximum, jitterSample);
    }
}
