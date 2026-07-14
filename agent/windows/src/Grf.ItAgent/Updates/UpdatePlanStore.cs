using System.Text.Json;
using System.Text.Json.Serialization;
using Grf.ItAgent.Storage;

namespace Grf.ItAgent.Updates;

internal sealed record UpdatePlan(
    int SchemaVersion,
    string Version,
    string Channel,
    string CandidatePath,
    string CandidateSha256,
    long CandidateSize,
    string SourceSha256,
    long SourceSize,
    DateTimeOffset PublishedAt,
    DateTimeOffset PreparedAt);

internal sealed class UpdatePlanStore
{
    private const int MaximumPlanBytes = 16 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    private readonly string _planPath;
    private readonly string _stagingDirectory;
    private readonly string _lockPath;

    public UpdatePlanStore(string updatesDirectory)
    {
        var root = Path.GetFullPath(updatesDirectory);
        _stagingDirectory = Path.Combine(root, "staging");
        _planPath = Path.Combine(root, "update-plan.json");
        _lockPath = Path.Combine(root, "update.lock");
    }

    public string PlanPath => _planPath;

    public string UpdatesDirectory => Path.GetDirectoryName(_planPath)!;

    public string GetCandidatePath(SemanticVersion version)
    {
        return Path.Combine(_stagingDirectory, $"GRF.ITAgent-{version}.exe");
    }

    public void EnsureDirectories()
    {
        EnsureSafeDirectory(Path.GetDirectoryName(_planPath)!);
        EnsureSafeDirectory(_stagingDirectory);
    }

    public FileStream AcquireLock()
    {
        return new FileStream(
            _lockPath,
            FileMode.OpenOrCreate,
            FileAccess.ReadWrite,
            FileShare.None,
            bufferSize: 1,
            FileOptions.WriteThrough);
    }

    public void InvalidatePlan()
    {
        try
        {
            File.Delete(_planPath);
        }
        catch (FileNotFoundException)
        {
            // Already invalidated.
        }
    }

    public async Task<UpdatePlan?> TryGetMatchingAsync(
        UpdateManifest manifest,
        CancellationToken cancellationToken)
    {
        var file = new FileInfo(_planPath);
        if (!file.Exists || file.Length is <= 0 or > MaximumPlanBytes)
        {
            return null;
        }

        UpdatePlan? plan;
        try
        {
            await using var stream = new FileStream(_planPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            plan = await JsonSerializer.DeserializeAsync<UpdatePlan>(stream, JsonOptions, cancellationToken).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return null;
        }

        var expectedCandidatePath = Path.GetFullPath(GetCandidatePath(manifest.Version));
        if (plan is null
            || plan.SchemaVersion != 1
            || !string.Equals(plan.Version, manifest.Version.ToString(), StringComparison.Ordinal)
            || !string.Equals(plan.Channel, manifest.Channel, StringComparison.Ordinal)
            || !string.Equals(plan.SourceSha256, manifest.Sha256, StringComparison.Ordinal)
            || plan.SourceSize != manifest.Size
            || string.IsNullOrWhiteSpace(plan.CandidatePath)
            || plan.CandidateSize is <= 0 or > UpdateValidation.MaximumExecutableBytes
            || plan.CandidateSha256 is null
            || plan.CandidateSha256.Length != 64
            || plan.CandidateSha256.Any(character => !char.IsAsciiHexDigit(character)))
        {
            return null;
        }

        try
        {
            if (!string.Equals(
                    Path.GetFullPath(plan.CandidatePath),
                    expectedCandidatePath,
                    StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }

        try
        {
            _ = await UpdateArtifactPreparer.ValidateCandidateAsync(
                expectedCandidatePath,
                plan.CandidateSize,
                plan.CandidateSha256,
                cancellationToken).ConfigureAwait(false);
            return plan;
        }
        catch (InvalidDataException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    public void Save(UpdatePlan plan)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(plan, JsonOptions);
        if (bytes.Length > MaximumPlanBytes)
        {
            throw new InvalidDataException("El plan de actualización excede el límite permitido.");
        }

        AtomicFile.WriteAllBytes(_planPath, bytes);
    }

    private static void EnsureSafeDirectory(string path)
    {
        Directory.CreateDirectory(path);
        var directory = new DirectoryInfo(path);
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new UpdateSecurityException("El directorio de actualización no puede ser un punto de reanálisis.");
        }
    }
}
