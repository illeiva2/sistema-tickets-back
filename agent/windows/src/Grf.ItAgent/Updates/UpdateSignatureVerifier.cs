using System.Security.Cryptography;
using System.Text;

namespace Grf.ItAgent.Updates;

internal sealed class UpdateSignatureVerifier
{
    private readonly RSAParameters _publicKey;

    public UpdateSignatureVerifier(string publicKeyPem)
    {
        _publicKey = ImportPublicKey(publicKeyPem);
    }

    public bool Verify(ReadOnlySpan<byte> manifestBytes, ReadOnlySpan<byte> detachedSignatureFile)
    {
        if (detachedSignatureFile.IsEmpty || detachedSignatureFile.Length > UpdateValidation.MaximumSignatureBytes)
        {
            return false;
        }

        byte[]? signature = null;
        try
        {
            signature = DecodeSignature(detachedSignatureFile);
            using var rsa = RSA.Create();
            rsa.ImportParameters(_publicKey);
            return rsa.VerifyData(
                manifestBytes,
                signature,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pss);
        }
        catch (FormatException)
        {
            return false;
        }
        catch (CryptographicException)
        {
            return false;
        }
        finally
        {
            if (signature is not null)
            {
                CryptographicOperations.ZeroMemory(signature);
            }
        }
    }

    public static void ValidatePublicKey(string publicKeyPem)
    {
        _ = ImportPublicKey(publicKeyPem);
    }

    private static RSAParameters ImportPublicKey(string publicKeyPem)
    {
        if (string.IsNullOrWhiteSpace(publicKeyPem)
            || publicKeyPem.Length > 16 * 1024
            || publicKeyPem.Contains("PRIVATE KEY", StringComparison.Ordinal))
        {
            throw new CryptographicException("Se requiere una clave pública RSA.");
        }

        using var rsa = RSA.Create();
        rsa.ImportFromPem(publicKeyPem);
        if (rsa.KeySize is < 2_048 or > 8_192)
        {
            throw new CryptographicException("El tamaño de la clave RSA no está permitido.");
        }

        return rsa.ExportParameters(includePrivateParameters: false);
    }

    private static byte[] DecodeSignature(ReadOnlySpan<byte> signatureFile)
    {
        var text = Encoding.ASCII.GetString(signatureFile).Trim();
        if (text.Length == 0 || text.Any(character =>
                !char.IsAsciiLetterOrDigit(character) && character is not '+' and not '/' and not '='))
        {
            throw new FormatException("La firma detached debe estar codificada en Base64.");
        }

        return Convert.FromBase64String(text);
    }
}

internal sealed class UpdateSecurityException : Exception
{
    public UpdateSecurityException(string message)
        : base(message)
    {
    }

    public UpdateSecurityException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
