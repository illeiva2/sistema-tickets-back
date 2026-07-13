using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Grf.ItAgent.Configuration;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Http;
using Grf.ItAgent.Security;
using Grf.ItAgent.Storage;
using Grf.ItAgent.Telemetry;
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
        var request = CreateHeartbeat(null);
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
}
