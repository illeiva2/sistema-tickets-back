namespace Grf.ItAgent.Utilities;

internal static class RetryPolicy
{
    public static TimeSpan GetDelay(int retryNumber, TimeSpan baseDelay, TimeSpan maximumDelay, double jitterSample)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(retryNumber);
        if (baseDelay <= TimeSpan.Zero || maximumDelay < baseDelay)
        {
            throw new ArgumentOutOfRangeException(nameof(baseDelay));
        }

        var boundedSample = Math.Clamp(jitterSample, 0d, 1d);
        var exponent = Math.Min(retryNumber, 20);
        var exponentialMilliseconds = baseDelay.TotalMilliseconds * Math.Pow(2, exponent);
        var cappedMilliseconds = Math.Min(exponentialMilliseconds, maximumDelay.TotalMilliseconds);
        var multiplier = 0.75d + (boundedSample * 0.5d);
        return TimeSpan.FromMilliseconds(Math.Min(cappedMilliseconds * multiplier, maximumDelay.TotalMilliseconds));
    }
}
