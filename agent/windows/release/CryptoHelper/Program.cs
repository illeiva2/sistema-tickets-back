using System.Security.Cryptography;
using System.Text;

internal static class Program
{
    private const int InvalidArgumentsExitCode = 64;
    private const int InvalidSignatureExitCode = 3;

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0)
            {
                return Usage("Missing command.");
            }

            return args[0] switch
            {
                "generate" => Generate(ParseOptions(args, 1)),
                "derive-public" => DerivePublic(ParseOptions(args, 1)),
                "sign" => Sign(ParseOptions(args, 1)),
                "verify" => Verify(ParseOptions(args, 1)),
                _ => Usage($"Unknown command: {args[0]}")
            };
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Release crypto helper failed: {exception.Message}");
            return 1;
        }
    }

    private static int DerivePublic(IReadOnlyDictionary<string, string> options)
    {
        var privatePath = Required(options, "private");
        var publicPath = Required(options, "public");

        using var rsa = RSA.Create();
        rsa.ImportFromPem(File.ReadAllText(privatePath, Encoding.UTF8));
        WriteUtf8WithoutBom(publicPath, rsa.ExportSubjectPublicKeyInfoPem() + Environment.NewLine);
        return 0;
    }

    private static int Generate(IReadOnlyDictionary<string, string> options)
    {
        var privatePath = Required(options, "private");
        var publicPath = Required(options, "public");
        var keySize = int.Parse(Required(options, "key-size"), System.Globalization.CultureInfo.InvariantCulture);
        if (keySize is not (3072 or 4096))
        {
            throw new ArgumentOutOfRangeException(nameof(keySize), "Key size must be 3072 or 4096 bits.");
        }

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(privatePath))!);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(publicPath))!);

        using var rsa = RSA.Create(keySize);
        WriteUtf8WithoutBom(privatePath, rsa.ExportPkcs8PrivateKeyPem() + Environment.NewLine);
        WriteUtf8WithoutBom(publicPath, rsa.ExportSubjectPublicKeyInfoPem() + Environment.NewLine);
        return 0;
    }

    private static int Sign(IReadOnlyDictionary<string, string> options)
    {
        var privatePath = Required(options, "private");
        var inputPath = Required(options, "input");
        var outputPath = Required(options, "output");

        using var rsa = RSA.Create();
        rsa.ImportFromPem(File.ReadAllText(privatePath, Encoding.UTF8));
        var signature = rsa.SignData(
            File.ReadAllBytes(inputPath),
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pss);

        WriteUtf8WithoutBom(outputPath, Convert.ToBase64String(signature) + "\n");
        return 0;
    }

    private static int Verify(IReadOnlyDictionary<string, string> options)
    {
        var publicPath = Required(options, "public");
        var inputPath = Required(options, "input");
        var signaturePath = Required(options, "signature");

        using var rsa = RSA.Create();
        rsa.ImportFromPem(File.ReadAllText(publicPath, Encoding.UTF8));
        var signature = Convert.FromBase64String(File.ReadAllText(signaturePath, Encoding.UTF8).Trim());
        var valid = rsa.VerifyData(
            File.ReadAllBytes(inputPath),
            signature,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pss);
        return valid ? 0 : InvalidSignatureExitCode;
    }

    private static Dictionary<string, string> ParseOptions(string[] args, int startIndex)
    {
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = startIndex; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length || !args[index].StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException("Options must use --name value pairs.");
            }

            var name = args[index][2..];
            if (!options.TryAdd(name, args[index + 1]))
            {
                throw new ArgumentException($"Duplicate option: --{name}");
            }
        }

        return options;
    }

    private static string Required(IReadOnlyDictionary<string, string> options, string name)
    {
        if (!options.TryGetValue(name, out var value) || string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"Missing --{name}.");
        }

        return value;
    }

    private static void WriteUtf8WithoutBom(string path, string content)
    {
        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
        using var writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        writer.Write(content);
    }

    private static int Usage(string message)
    {
        Console.Error.WriteLine(message);
        Console.Error.WriteLine("Commands: generate, sign, verify");
        return InvalidArgumentsExitCode;
    }
}
