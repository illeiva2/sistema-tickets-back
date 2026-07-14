using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Grf.ItAgent.Configuration;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Http;
using Grf.ItAgent.Security;
using Grf.ItAgent.Storage;
using Grf.ItAgent.Telemetry;
using Grf.ItAgent.Updates;
using Grf.ItAgent.Utilities;

namespace Grf.ItAgent.Tests;

internal static class Program
{
    public static async Task<int> Main()
    {
        var tests = new (string Name, Func<Task> Run)[]
        {
            ("RetryPolicy aplica exponencial, tope y jitter", RetryPolicyTest),
            ("HeartbeatSchedule respeta jitter y mínimo", HeartbeatScheduleTest),
            ("CpuUsageCalculator calcula deltas", CpuUsageTest),
            ("EnrollmentSecrets genera y compara secretos", EnrollmentSecretsTest),
            ("Configuration exige HTTPS", ConfigurationTest),
            ("NetworkCollector prioriza gateway", NetworkOrderingTest),
            ("Contrato JSON heartbeat usa camelCase", HeartbeatJsonContractTest),
            ("PayloadLimiter respeta margen del parser", PayloadLimiterTest),
            ("Envelope enroll coincide con fixture real", EnrollEnvelopeFixtureTest),
            ("Envelope heartbeat coincide con fixture real", HeartbeatEnvelopeFixtureTest),
            ("Envelope directo es rechazado", DirectResponseRejectedTest),
            ("DPAPI LocalMachine cifra y descifra", DpapiRoundTripTest),
            ("CredentialStore conserva pending y enrolled", CredentialStoreTest),
            ("StringLimiter no corta surrogate pair", StringLimiterTest),
            ("WTS usa explícitamente Unicode", WtsUnicodeInteropTest),
            ("Servicio remoto exige puerto escuchando", RemoteServiceAvailabilityTest),
            ("Semantic Versioning ordena releases de forma segura", SemanticVersionTest),
            ("Configuración de updates es opt-in y valida GitHub/RSA", UpdateConfigurationTest),
            ("Transporte limita redirecciones a hosts exactos de GitHub", UpdateRedirectPolicyTest),
            ("Updater verifica firma y prepara un EXE validado", SignedUpdatePreparationTest),
            ("Updater rechaza manifiesto alterado", TamperedManifestTest),
            ("Artefactos ZIP exigen un único EXE", ZipArtifactTest),
            ("Backoff de updates es exponencial y acotado", UpdateBackoffTest),
            ("Scheduler persiste intervalo y backoff entre procesos", UpdateAttemptScheduleTest),
            ("CLI separa preparación, validación y ejecución", UpdateCliOptionsTest),
            ("Versión del agente conserva metadata SemVer", AgentVersionSelectionTest),
        };

        var failures = 0;
        foreach (var test in tests)
        {
            try
            {
                await test.Run().ConfigureAwait(false);
                Console.WriteLine($"PASS {test.Name}");
            }
            catch (Exception exception)
            {
                failures++;
                Console.Error.WriteLine($"FAIL {test.Name}: {exception.GetType().Name} - {exception.Message}");
            }
        }

        Console.WriteLine($"Resultado: {tests.Length - failures}/{tests.Length} pruebas correctas.");
        return failures == 0 ? 0 : 1;
    }

    private static Task RetryPolicyTest()
    {
        var low = RetryPolicy.GetDelay(0, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(30), 0);
        var high = RetryPolicy.GetDelay(0, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(30), 1);
        var capped = RetryPolicy.GetDelay(20, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(30), 1);
        Assert.Equal(TimeSpan.FromMilliseconds(1_500), low);
        Assert.Equal(TimeSpan.FromMilliseconds(2_500), high);
        Assert.Equal(TimeSpan.FromSeconds(30), capped);
        return Task.CompletedTask;
    }

    private static Task HeartbeatScheduleTest()
    {
        Assert.Equal(TimeSpan.FromSeconds(30), HeartbeatSchedule.WithJitter(30, 0));
        Assert.Equal(TimeSpan.FromSeconds(66), HeartbeatSchedule.WithJitter(60, 1));
        Assert.True(HeartbeatSchedule.WithJitter(60, 0).TotalSeconds is >= 30 and < 60);
        return Task.CompletedTask;
    }

    private static Task CpuUsageTest()
    {
        var usage = CpuUsageCalculator.Calculate(new CpuTimes(100, 500, 500), new CpuTimes(150, 600, 700));
        Assert.Equal(83.3d, usage);
        Assert.Null(CpuUsageCalculator.Calculate(new CpuTimes(100, 500, 500), new CpuTimes(90, 600, 700)));
        return Task.CompletedTask;
    }

    private static Task EnrollmentSecretsTest()
    {
        var first = EnrollmentSecrets.GenerateDeviceSecret();
        var second = EnrollmentSecrets.GenerateDeviceSecret();
        Assert.Equal(43, first.Length);
        Assert.True(first.All(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '-'));
        Assert.NotEqual(first, second);

        var fingerprint = EnrollmentSecrets.FingerprintToken("one-use-token");
        Assert.Equal(43, fingerprint.Length);
        Assert.True(EnrollmentSecrets.FingerprintsMatch(fingerprint, EnrollmentSecrets.FingerprintToken("one-use-token")));
        Assert.False(EnrollmentSecrets.FingerprintsMatch(fingerprint, EnrollmentSecrets.FingerprintToken("other-token")));
        return Task.CompletedTask;
    }

    private static Task ConfigurationTest()
    {
        var valid = new AgentConfiguration { BaseUrl = "https://it.example.test" };
        Assert.Equal("https://it.example.test/", ConfigurationLoader.GetBaseUri(valid).AbsoluteUri);
        Assert.Throws<ConfigurationException>(() => ConfigurationLoader.GetBaseUri(new AgentConfiguration
        {
            BaseUrl = "http://it.example.test",
        }));
        Assert.Throws<ConfigurationException>(() => ConfigurationLoader.GetBaseUri(new AgentConfiguration
        {
            BaseUrl = "https://user:password@it.example.test",
        }));
        return Task.CompletedTask;
    }

    private static Task NetworkOrderingTest()
    {
        var inventory = new NetworkAdapterSnapshot("adapter", null, null, ["10.0.0.2"]);
        var candidates = new[]
        {
            new NetworkCandidate("fast-no-route", false, 10_000, null, ["10.0.0.2"], inventory),
            new NetworkCandidate("default-route", true, 100, null, ["10.0.0.3"], inventory),
        };
        var ordered = NetworkCollector.OrderCandidates(candidates);
        Assert.Equal("default-route", ordered[0].Name);
        return Task.CompletedTask;
    }

    private static Task HeartbeatJsonContractTest()
    {
        var collectedAt = new DateTimeOffset(2026, 7, 13, 9, 0, 0, TimeSpan.FromHours(-3));
        var inventory = new InventorySnapshot(collectedAt, null, null, null, null, null);
        var request = CreateHeartbeat(inventory);
        var payload = HeartbeatPayloadLimiter.Serialize(request);
        using var document = JsonDocument.Parse(payload.Bytes);
        var root = document.RootElement;
        Assert.True(root.TryGetProperty("hostname", out _));
        Assert.False(root.TryGetProperty("Hostname", out _));
        Assert.True(root.TryGetProperty("ram", out var ram));
        Assert.Equal(1_000L, ram.GetProperty("totalBytes").GetInt64());
        Assert.True(root.TryGetProperty("services", out _));
        Assert.True(root.TryGetProperty("os", out _));
        Assert.False(root.TryGetProperty("username", out _));
        var serializedCollectedAt = root.GetProperty("inventory").GetProperty("collectedAt").GetString();
        Assert.Equal("2026-07-13T12:00:00.0000000Z", serializedCollectedAt);
        Assert.False(serializedCollectedAt!.Contains("+00:00", StringComparison.Ordinal));
        CryptographicOperations.ZeroMemory(payload.Bytes);
        return Task.CompletedTask;
    }

    private static Task PayloadLimiterTest()
    {
        var software = Enumerable.Range(0, 500)
            .Select(index => new SoftwareSnapshot(new string('á', 300), index.ToString(), new string('é', 200)))
            .ToArray();
        var inventory = new InventorySnapshot(DateTimeOffset.UtcNow, null, null, null, software, null);
        var payload = HeartbeatPayloadLimiter.Serialize(CreateHeartbeat(inventory), 20_000);
        Assert.True(payload.Bytes.Length <= 20_000);
        using var document = JsonDocument.Parse(payload.Bytes);
        Assert.True(document.RootElement.TryGetProperty("inventory", out _));
        CryptographicOperations.ZeroMemory(payload.Bytes);
        return Task.CompletedTask;
    }

    private static Task EnrollEnvelopeFixtureTest()
    {
        const string fixture = "{\"success\":true,\"data\":{\"deviceId\":\"cmhaaaaaaaaaaaaaaaaaaaaaaa\",\"nextHeartbeatSeconds\":60}}";
        var response = AgentResponseParser.DeserializeEnvelope<EnrollResponse>(Encoding.UTF8.GetBytes(fixture));
        Assert.Equal("cmhaaaaaaaaaaaaaaaaaaaaaaa", response.DeviceId);
        Assert.Equal(60, response.NextHeartbeatSeconds);
        return Task.CompletedTask;
    }

    private static Task HeartbeatEnvelopeFixtureTest()
    {
        const string fixture = "{\"success\":true,\"data\":{\"acceptedAt\":\"2026-07-13T12:00:00.000Z\",\"nextHeartbeatSeconds\":60,\"state\":\"ONLINE\"}}";
        var response = AgentResponseParser.DeserializeEnvelope<HeartbeatResponse>(Encoding.UTF8.GetBytes(fixture));
        Assert.Equal("ONLINE", response.State);
        Assert.Equal(60, response.NextHeartbeatSeconds);
        Assert.Equal(DateTimeOffset.Parse("2026-07-13T12:00:00Z"), response.AcceptedAt);
        return Task.CompletedTask;
    }

    private static Task DirectResponseRejectedTest()
    {
        const string direct = "{\"deviceId\":\"device\",\"nextHeartbeatSeconds\":60}";
        Assert.Throws<InvalidDataException>(() =>
            AgentResponseParser.DeserializeEnvelope<EnrollResponse>(Encoding.UTF8.GetBytes(direct)));
        return Task.CompletedTask;
    }

    private static Task DpapiRoundTripTest()
    {
        var protector = new DpapiSecretProtector();
        var plaintext = Encoding.UTF8.GetBytes("test-only-secret");
        var encrypted = protector.Protect(plaintext);
        var recovered = protector.Unprotect(encrypted);
        Assert.False(plaintext.SequenceEqual(encrypted));
        Assert.True(plaintext.SequenceEqual(recovered));
        CryptographicOperations.ZeroMemory(plaintext);
        CryptographicOperations.ZeroMemory(encrypted);
        CryptographicOperations.ZeroMemory(recovered);
        return Task.CompletedTask;
    }

    private static Task CredentialStoreTest()
    {
        var directory = Path.Combine(Path.GetTempPath(), "grf-agent-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "credentials.dat");
            var store = new CredentialStore(path, new DpapiSecretProtector());
            var secret = EnrollmentSecrets.GenerateDeviceSecret();
            var fingerprint = EnrollmentSecrets.FingerprintToken("one-use-token");
            store.SavePending(secret, fingerprint);
            var pending = Assert.NotNull(store.Load());
            Assert.Equal(CredentialStore.PendingStatus, pending.Status);
            Assert.Equal(secret, pending.DeviceSecret);

            store.SaveEnrolled("cmhaaaaaaaaaaaaaaaaaaaaaaa", secret);
            var enrolled = Assert.NotNull(store.Load());
            var credentials = CredentialStore.GetDeviceCredentials(enrolled);
            Assert.Equal("cmhaaaaaaaaaaaaaaaaaaaaaaa", credentials.DeviceId);
            Assert.Equal(secret, credentials.Secret);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }

        return Task.CompletedTask;
    }

    private static Task StringLimiterTest()
    {
        Assert.Equal("ab", StringLimiter.LimitOptional("ab😀", 3));
        return Task.CompletedTask;
    }

    private static Task WtsUnicodeInteropTest()
    {
        foreach (var methodName in new[] { "WTSEnumerateSessions", "WTSQuerySessionInformation" })
        {
            var method = typeof(WindowsNative).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static);
            var import = method?.GetCustomAttribute<DllImportAttribute>();
            Assert.NotNull(import);
            Assert.Equal(CharSet.Unicode, import!.CharSet);
        }

        return Task.CompletedTask;
    }

    private static Task RemoteServiceAvailabilityTest()
    {
        Assert.False(ServiceCollector.DetermineAvailability(false, true, false));
        Assert.False(ServiceCollector.DetermineAvailability(true, false, false));
        Assert.False(ServiceCollector.DetermineAvailability(false, false, true));
        Assert.True(ServiceCollector.DetermineAvailability(true, false, true));
        Assert.True(ServiceCollector.DetermineAvailability(false, true, true));
        return Task.CompletedTask;
    }

    private static Task SemanticVersionTest()
    {
        Assert.True(SemanticVersion.Parse("1.0.0").CompareTo(SemanticVersion.Parse("1.0.0-rc.1")) > 0);
        Assert.True(SemanticVersion.Parse("1.0.0-rc.2").CompareTo(SemanticVersion.Parse("1.0.0-rc.10")) < 0);
        Assert.Equal(0, SemanticVersion.Parse("1.0.0+build.1").CompareTo(SemanticVersion.Parse("1.0.0+build.2")));
        Assert.False(SemanticVersion.TryParse("01.0.0", out _));
        Assert.False(SemanticVersion.TryParse("1.0.0-alpha.01", out _));
        Assert.False(SemanticVersion.TryParse("1.0", out _));
        return Task.CompletedTask;
    }

    private static Task UpdateConfigurationTest()
    {
        using var rsa = RSA.Create(2_048);
        var directory = CreateTestDirectory();
        try
        {
            var path = Path.Combine(directory, "config.json");
            var json = JsonSerializer.Serialize(new
            {
                baseUrl = "https://it.example.test",
                update = new
                {
                    enabled = true,
                    channel = "pilot",
                    manifestUrl = "https://github.com/grf/it-agent/releases/download/pilot/manifest.json",
                    publicKeyPem = rsa.ExportSubjectPublicKeyInfoPem(),
                    checkIntervalMinutes = 30,
                },
            });
            File.WriteAllText(path, json, Encoding.UTF8);
            var configuration = ConfigurationLoader.Load(path);
            Assert.True(configuration.Update.Enabled);
            Assert.Equal("pilot", configuration.Update.Channel);

            File.WriteAllText(path, json.Replace("https://github.com/", "https://github.com.evil.test/", StringComparison.Ordinal));
            Assert.Throws<ConfigurationException>(() => ConfigurationLoader.Load(path));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }

        return Task.CompletedTask;
    }

    private static async Task UpdateRedirectPolicyTest()
    {
        var handler = new QueueHttpHandler(
            _ => new HttpResponseMessage(HttpStatusCode.Redirect)
            {
                Headers = { Location = new Uri("https://github.com.evil.test/payload") },
            });
        using (var transport = new GithubUpdateTransport(handler, TimeSpan.FromSeconds(30)))
        {
            await Assert.ThrowsAsync<UpdateSecurityException>(() => transport.GetBytesAsync(
                new Uri("https://github.com/grf/repo/manifest.json"),
                100,
                CancellationToken.None)).ConfigureAwait(false);
        }

        var allowedHandler = new QueueHttpHandler(
            _ => new HttpResponseMessage(HttpStatusCode.Redirect)
            {
                Headers = { Location = new Uri("https://release-assets.githubusercontent.com/payload") },
            },
            request =>
            {
                Assert.Null(request.Headers.Authorization);
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new ByteArrayContent(Encoding.ASCII.GetBytes("ok")),
                };
            });
        using var allowedTransport = new GithubUpdateTransport(allowedHandler, TimeSpan.FromSeconds(30));
        var result = await allowedTransport.GetBytesAsync(
            new Uri("https://github.com/grf/repo/manifest.json"),
            100,
            CancellationToken.None).ConfigureAwait(false);
        Assert.Equal("ok", Encoding.ASCII.GetString(result));
    }

    private static async Task SignedUpdatePreparationTest()
    {
        using var fixture = SignedUpdateFixture.Create("1.2.0", "0.1.0");
        var directory = CreateTestDirectory();
        try
        {
            using var coordinator = fixture.CreateCoordinator(directory);
            var result = await coordinator.CheckOnceAsync("0.1.0", CancellationToken.None).ConfigureAwait(false);
            Assert.Equal(UpdateCheckStatus.Prepared, result.Status);
            var plan = Assert.NotNull(result.Plan);
            Assert.True(File.Exists(plan.CandidatePath));
            Assert.Equal(fixture.Executable.Length, plan.CandidateSize);
            _ = await UpdateArtifactPreparer.ValidateCandidateAsync(
                plan.CandidatePath,
                plan.CandidateSize,
                plan.CandidateSha256,
                CancellationToken.None).ConfigureAwait(false);
            Assert.True(File.Exists(coordinator.PlanPath));
            Assert.Equal(1, fixture.Transport.DownloadCount);

            var repeated = await coordinator.CheckOnceAsync("0.1.0", CancellationToken.None).ConfigureAwait(false);
            Assert.Equal(UpdateCheckStatus.AlreadyPrepared, repeated.Status);
            Assert.Equal(1, fixture.Transport.DownloadCount);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static async Task TamperedManifestTest()
    {
        using var fixture = SignedUpdateFixture.Create("1.2.0", "0.1.0");
        fixture.ManifestBytes[10] ^= 1;
        var directory = CreateTestDirectory();
        try
        {
            using var coordinator = fixture.CreateCoordinator(directory);
            await Assert.ThrowsAsync<UpdateSecurityException>(() =>
                coordinator.CheckOnceAsync("0.1.0", CancellationToken.None)).ConfigureAwait(false);
            Assert.Equal(0, fixture.Transport.DownloadCount);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static async Task ZipArtifactTest()
    {
        var directory = CreateTestDirectory();
        try
        {
            var executable = CreateTestExecutable();
            var zipPath = Path.Combine(directory, "agent.zip");
            CreateZip(zipPath, ("GRF.ITAgent.exe", executable));
            var candidate = Path.Combine(directory, "candidate.exe");
            var prepared = await UpdateArtifactPreparer.PrepareAsync(
                zipPath,
                new Uri("https://github.com/grf/repo/agent.zip"),
                candidate,
                CancellationToken.None).ConfigureAwait(false);
            Assert.Equal(executable.Length, prepared.Size);

            var invalidZip = Path.Combine(directory, "invalid.zip");
            CreateZip(invalidZip, ("GRF.ITAgent.exe", executable), ("extra.txt", [1, 2, 3]));
            await Assert.ThrowsAsync<InvalidDataException>(() => UpdateArtifactPreparer.PrepareAsync(
                invalidZip,
                new Uri("https://github.com/grf/repo/agent.zip"),
                Path.Combine(directory, "invalid.exe"),
                CancellationToken.None)).ConfigureAwait(false);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static Task UpdateBackoffTest()
    {
        var first = UpdateBackoff.GetFailureDelay(0, TimeSpan.FromHours(1), 0.5);
        var second = UpdateBackoff.GetFailureDelay(1, TimeSpan.FromHours(1), 0.5);
        var capped = UpdateBackoff.GetFailureDelay(20, TimeSpan.FromHours(24), 1);
        Assert.Equal(TimeSpan.FromMinutes(5), first);
        Assert.Equal(TimeSpan.FromMinutes(10), second);
        Assert.Equal(TimeSpan.FromHours(6), capped);
        return Task.CompletedTask;
    }

    private static async Task UpdateAttemptScheduleTest()
    {
        using var fixture = SignedUpdateFixture.Create("1.2.0", "0.1.0");
        var directory = CreateTestDirectory();
        var now = new DateTimeOffset(2026, 7, 13, 15, 0, 0, TimeSpan.Zero);
        try
        {
            using var coordinator = fixture.CreateCoordinator(directory, () => now, () => 0.5);
            var first = await coordinator.CheckWhenDueAsync("0.1.0", CancellationToken.None).ConfigureAwait(false);
            Assert.Equal(UpdateCheckStatus.Prepared, first.Status);
            var deferred = await coordinator.CheckWhenDueAsync("0.1.0", CancellationToken.None).ConfigureAwait(false);
            Assert.Equal(UpdateCheckStatus.Deferred, deferred.Status);
            Assert.True(File.Exists(coordinator.PlanPath));

            now = now.AddMinutes(31);
            var dueAgain = await coordinator.CheckWhenDueAsync("0.1.0", CancellationToken.None).ConfigureAwait(false);
            Assert.Equal(UpdateCheckStatus.AlreadyPrepared, dueAgain.Status);

            now = now.AddMinutes(31);
            var noLongerApplicable = await coordinator
                .CheckWhenDueAsync("1.2.0", CancellationToken.None)
                .ConfigureAwait(false);
            Assert.Equal(UpdateCheckStatus.NoUpdate, noLongerApplicable.Status);
            Assert.False(File.Exists(coordinator.PlanPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static Task UpdateCliOptionsTest()
    {
        Assert.Equal(AgentRunMode.PrepareUpdate, Grf.ItAgent.Program.ParseOptions(["--prepare-update"]).Mode);
        Assert.Equal(AgentRunMode.ValidateInstall, Grf.ItAgent.Program.ParseOptions(["--validate-install"]).Mode);
        Assert.Throws<ConfigurationException>(() =>
            Grf.ItAgent.Program.ParseOptions(["--run", "--prepare-update"]));
        return Task.CompletedTask;
    }

    private static Task AgentVersionSelectionTest()
    {
        Assert.Equal(
            "2.3.4-rc.2+sha.abcdef",
            AgentVersion.Select("2.3.4-rc.2+sha.abcdef", new Version(9, 8, 7, 6)));
        Assert.Equal("9.8.7", AgentVersion.Select("not-semver", new Version(9, 8, 7, 6)));
        Assert.Equal("0.1.0", AgentVersion.Select("1.2", new Version(9, 8)));
        Assert.True(SemanticVersion.TryParse(AgentVersion.Current, out _));
        Assert.Equal("0.2.0", AgentVersion.Current);
        return Task.CompletedTask;
    }

    private static string CreateTestDirectory()
    {
        var directory = Path.Combine(Path.GetTempPath(), "grf-agent-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    internal static byte[] CreateTestExecutable()
    {
        var contents = new byte[1_024];
        contents[0] = (byte)'M';
        contents[1] = (byte)'Z';
        BitConverter.GetBytes(0x80).CopyTo(contents, 0x3c);
        contents[0x80] = (byte)'P';
        contents[0x81] = (byte)'E';
        BitConverter.GetBytes((ushort)0x8664).CopyTo(contents, 0x84);
        BitConverter.GetBytes((ushort)0x020b).CopyTo(contents, 0x98);
        RandomNumberGenerator.Fill(contents.AsSpan(0x100));
        return contents;
    }

    private static void CreateZip(string path, params (string Name, byte[] Contents)[] files)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        foreach (var file in files)
        {
            var entry = archive.CreateEntry(file.Name, CompressionLevel.SmallestSize);
            using var stream = entry.Open();
            stream.Write(file.Contents);
        }
    }

    private static HeartbeatRequest CreateHeartbeat(InventorySnapshot? inventory)
    {
        return new HeartbeatRequest(
            "pc-test",
            null,
            ["10.0.0.2"],
            ["AA:BB:CC:DD:EE:FF"],
            120,
            12.5,
            new RamSnapshot(1_000, 500),
            null,
            [new DiskSnapshot("C:\\", 1_000, 500)],
            new ServiceSnapshot(new RemoteServiceSnapshot(false, null), new RemoteServiceSnapshot(false, null)),
            new OsSnapshot("Windows", "11", "26100"),
            "0.1.0",
            inventory);
    }
}

internal sealed class SignedUpdateFixture : IDisposable
{
    private readonly RSA _rsa;

    private SignedUpdateFixture(
        RSA rsa,
        UpdateConfiguration configuration,
        FakeUpdateTransport transport,
        byte[] manifestBytes,
        byte[] executable)
    {
        _rsa = rsa;
        Configuration = configuration;
        Transport = transport;
        ManifestBytes = manifestBytes;
        Executable = executable;
    }

    public UpdateConfiguration Configuration { get; }
    public FakeUpdateTransport Transport { get; }
    public byte[] ManifestBytes { get; }
    public byte[] Executable { get; }

    public static SignedUpdateFixture Create(string version, string minimumVersion)
    {
        var rsa = RSA.Create(2_048);
        var executable = Program.CreateTestExecutable();
        byte[] artifact;
        using (var output = new MemoryStream())
        {
            using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
            {
                gzip.Write(executable);
            }

            artifact = output.ToArray();
        }

        var artifactHash = Convert.ToHexString(SHA256.HashData(artifact)).ToLowerInvariant();
        const string manifestUrl = "https://github.com/grf/it-agent/releases/download/pilot/manifest.json";
        const string artifactUrl = "https://github.com/grf/it-agent/releases/download/pilot/GRF.ITAgent.exe.gz";
        var manifest = string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $"{{\"version\":\"{version}\",\"channel\":\"pilot\",\"url\":\"{artifactUrl}\",\"sha256\":\"{artifactHash}\",\"size\":{artifact.Length},\"publishedAt\":\"2026-07-13T12:00:00Z\",\"minAgentVersion\":\"{minimumVersion}\"}}");
        var manifestBytes = Encoding.UTF8.GetBytes(manifest);
        var signature = rsa.SignData(
            manifestBytes,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pss);
        var signatureBytes = Encoding.ASCII.GetBytes(Convert.ToBase64String(signature));
        if (!new UpdateSignatureVerifier(rsa.ExportSubjectPublicKeyInfoPem()).Verify(manifestBytes, signatureBytes))
        {
            throw new InvalidOperationException("La fixture no pudo verificar su propia firma.");
        }

        var transport = new FakeUpdateTransport(
            new Dictionary<string, byte[]>(StringComparer.Ordinal)
            {
                [manifestUrl] = manifestBytes,
                [manifestUrl + ".sig"] = signatureBytes,
            },
            new Uri(artifactUrl),
            artifact);
        var configuration = new UpdateConfiguration
        {
            Enabled = true,
            Channel = "pilot",
            ManifestUrl = manifestUrl,
            PublicKeyPem = rsa.ExportSubjectPublicKeyInfoPem(),
            CheckIntervalMinutes = 30,
        };
        return new SignedUpdateFixture(rsa, configuration, transport, manifestBytes, executable);
    }

    public UpdateCoordinator CreateCoordinator(
        string directory,
        Func<DateTimeOffset>? utcNow = null,
        Func<double>? jitterSample = null)
    {
        return new UpdateCoordinator(
            Configuration,
            directory,
            Transport,
            utcNow ?? (() => new DateTimeOffset(2026, 7, 13, 15, 0, 0, TimeSpan.Zero)),
            jitterSample);
    }

    public void Dispose() => _rsa.Dispose();
}

internal sealed class FakeUpdateTransport : IUpdateTransport
{
    private readonly IReadOnlyDictionary<string, byte[]> _responses;
    private readonly Uri _downloadUri;
    private readonly byte[] _download;

    public FakeUpdateTransport(
        IReadOnlyDictionary<string, byte[]> responses,
        Uri downloadUri,
        byte[] download)
    {
        _responses = responses;
        _downloadUri = downloadUri;
        _download = download;
    }

    public int DownloadCount { get; private set; }

    public Task<byte[]> GetBytesAsync(Uri uri, int maximumBytes, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_responses.TryGetValue(uri.AbsoluteUri, out var response) || response.Length > maximumBytes)
        {
            throw new UpdateTransportException("Respuesta fake ausente o demasiado grande.");
        }

        return Task.FromResult(response.ToArray());
    }

    public async Task<DownloadedUpdateFile> DownloadFileAsync(
        Uri uri,
        string destinationPath,
        long maximumBytes,
        CancellationToken cancellationToken)
    {
        if (uri != _downloadUri || _download.Length > maximumBytes)
        {
            throw new UpdateTransportException("Descarga fake inválida.");
        }

        DownloadCount++;
        await File.WriteAllBytesAsync(destinationPath, _download, cancellationToken).ConfigureAwait(false);
        return new DownloadedUpdateFile(
            _download.LongLength,
            Convert.ToHexString(SHA256.HashData(_download)).ToLowerInvariant());
    }

    public void Dispose()
    {
    }
}

internal sealed class QueueHttpHandler : HttpMessageHandler
{
    private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _responses;

    public QueueHttpHandler(params Func<HttpRequestMessage, HttpResponseMessage>[] responses)
    {
        _responses = new Queue<Func<HttpRequestMessage, HttpResponseMessage>>(responses);
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_responses.Count == 0)
        {
            throw new InvalidOperationException("No quedan respuestas HTTP fake.");
        }

        return Task.FromResult(_responses.Dequeue()(request));
    }
}

internal static class Assert
{
    public static void True(bool condition)
    {
        if (!condition)
        {
            throw new InvalidOperationException("Se esperaba verdadero.");
        }
    }

    public static void False(bool condition) => True(!condition);

    public static void Null(object? value)
    {
        if (value is not null)
        {
            throw new InvalidOperationException("Se esperaba null.");
        }
    }

    public static T NotNull<T>(T? value)
        where T : class
    {
        return value ?? throw new InvalidOperationException("No se esperaba null.");
    }

    public static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"Esperado: {expected}; actual: {actual}.");
        }
    }

    public static void NotEqual<T>(T left, T right)
    {
        if (EqualityComparer<T>.Default.Equals(left, right))
        {
            throw new InvalidOperationException("No se esperaban valores iguales.");
        }
    }

    public static void Throws<TException>(Action action)
        where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }

        throw new InvalidOperationException($"Se esperaba {typeof(TException).Name}.");
    }

    public static async Task ThrowsAsync<TException>(Func<Task> action)
        where TException : Exception
    {
        try
        {
            await action().ConfigureAwait(false);
        }
        catch (TException)
        {
            return;
        }

        throw new InvalidOperationException($"Se esperaba {typeof(TException).Name}.");
    }
}
