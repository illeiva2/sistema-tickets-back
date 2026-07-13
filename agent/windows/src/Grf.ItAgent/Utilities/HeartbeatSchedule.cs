namespace Grf.ItAgent.Utilities;

internal static class HeartbeatSchedule
{
    public static TimeSpan WithJitter(int seconds, double jitterSample)
    {
        var boundedSeconds = Math.Clamp(seconds, 30, 3_600);
        var boundedSample = Math.Clamp(jitterSample, 0d, 1d);
        var multiplier = 0.9d + (boundedSample * 0.2d);
        var jitteredSeconds = Math.Clamp(boundedSeconds * multiplier, 30d, 3_600d);
        return TimeSpan.FromSeconds(jitteredSeconds);
    }
}
