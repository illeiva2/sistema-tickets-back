using System.Globalization;
using System.Text;

namespace Grf.ItAgent.Logging;

internal enum LogSeverity
{
    Information,
    Warning,
    Error,
}

internal sealed class SafeFileLogger
{
    private const long MaximumLogBytes = 2 * 1024 * 1024;
    private readonly object _sync = new();
    private readonly string _path;

    public SafeFileLogger(string path)
    {
        _path = Path.GetFullPath(path);
    }

    // Intentionally accepts only an event identifier, an exception type and a status code.
    // Exception messages, URLs, request bodies, headers and identifiers never reach the log.
    public void Write(LogSeverity severity, string eventName, Exception? exception = null, int? statusCode = null)
    {
        var safeEvent = SanitizeEventName(eventName);
        var exceptionType = exception is null ? null : SanitizeEventName(exception.GetType().Name);
        var line = string.Create(
            CultureInfo.InvariantCulture,
            $"{DateTimeOffset.UtcNow:O}\t{severity}\t{safeEvent}\tstatus={statusCode?.ToString(CultureInfo.InvariantCulture) ?? "-"}\texception={exceptionType ?? "-"}{Environment.NewLine}");

        try
        {
            lock (_sync)
            {
                RotateIfRequired();
                File.AppendAllText(_path, line, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            }
        }
        catch
        {
            // Logging must never make the monitoring agent fail or expose fallback data elsewhere.
        }
    }

    private void RotateIfRequired()
    {
        var file = new FileInfo(_path);
        if (!file.Exists || file.Length < MaximumLogBytes)
        {
            return;
        }

        var previous = _path + ".1";
        File.Move(_path, previous, overwrite: true);
    }

    private static string SanitizeEventName(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "UnknownEvent";
        }

        Span<char> buffer = stackalloc char[Math.Min(value.Length, 80)];
        var written = 0;
        foreach (var character in value)
        {
            if (written == buffer.Length)
            {
                break;
            }

            buffer[written++] = char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-'
                ? character
                : '_';
        }

        return new string(buffer[..written]);
    }
}
