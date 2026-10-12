using System.Globalization;
using System.Text;

namespace Grf.NetCollector.Logging;

/// <summary>
/// Un archivo por día en la carpeta de datos, con 14 días de historia. Nunca se escriben claves:
/// los mensajes son de estado ("10.0.0.5: sin conexión con la API cifrada").
/// </summary>
internal sealed class CollectorLog
{
    private const int KeepDays = 14;
    private readonly object _sync = new();
    private readonly string _directory;
    private readonly bool _echo;

    public CollectorLog(string dataDirectory, bool echo)
    {
        _directory = Path.Combine(dataDirectory, "logs");
        _echo = echo;
    }

    public void Info(string message) => Write("INFO", message);

    public void Warn(string message) => Write("WARN", message);

    public void Error(string message) => Write("ERROR", message);

    private void Write(string level, string message)
    {
        var line = string.Create(CultureInfo.InvariantCulture, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss}\t{level}\t{message}");
        if (_echo)
        {
            Console.WriteLine(line);
        }

        try
        {
            lock (_sync)
            {
                Directory.CreateDirectory(_directory);
                var path = Path.Combine(_directory, $"colector-{DateTime.Now:yyyyMMdd}.log");
                File.AppendAllText(path, line + Environment.NewLine, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            }
        }
        catch (IOException)
        {
            // Sin disco para el log no se frena el sondeo.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    public void Prune()
    {
        try
        {
            if (!Directory.Exists(_directory))
            {
                return;
            }

            var limit = DateTime.Now.AddDays(-KeepDays);
            foreach (var file in Directory.EnumerateFiles(_directory, "colector-*.log"))
            {
                if (File.GetLastWriteTime(file) < limit)
                {
                    File.Delete(file);
                }
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
