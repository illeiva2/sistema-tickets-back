namespace Grf.ItAgent.Utilities;

internal readonly record struct CpuTimes(ulong Idle, ulong Kernel, ulong User);

internal static class CpuUsageCalculator
{
    public static double? Calculate(CpuTimes previous, CpuTimes current)
    {
        if (current.Idle < previous.Idle || current.Kernel < previous.Kernel || current.User < previous.User)
        {
            return null;
        }

        var idle = current.Idle - previous.Idle;
        var kernel = current.Kernel - previous.Kernel;
        var user = current.User - previous.User;
        var total = kernel + user;
        if (total == 0 || idle > total)
        {
            return null;
        }

        return Math.Round(Math.Clamp((total - idle) * 100d / total, 0d, 100d), 1, MidpointRounding.AwayFromZero);
    }
}
