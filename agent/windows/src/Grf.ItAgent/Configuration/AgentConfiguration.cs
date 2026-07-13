namespace Grf.ItAgent.Configuration;

internal sealed class AgentConfiguration
{
    public string BaseUrl { get; init; } = string.Empty;
    public int HeartbeatSeconds { get; init; } = 60;
    public int InventoryIntervalMinutes { get; init; } = 1_440;
    public int RequestTimeoutSeconds { get; init; } = 15;
    public int MaxRetries { get; init; } = 4;
    public int RetryBaseDelaySeconds { get; init; } = 2;
    public int RetryMaxDelaySeconds { get; init; } = 30;
    public string EnrollmentTokenFile { get; init; } = "enrollment.token";
    public string CredentialFile { get; init; } = "credentials.dat";
    public string StateFile { get; init; } = "state.json";
    public string LogFile { get; init; } = "agent.log";
    public string LockFile { get; init; } = "agent.lock";
}
