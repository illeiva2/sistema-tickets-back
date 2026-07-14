using System.Security.Cryptography;
using System.Text;

namespace Grf.ItAgent.Security;

internal static class EnrollmentSecrets
{
    public static string GenerateDeviceSecret()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        try
        {
            return ToBase64Url(bytes);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    public static string FingerprintToken(string token)
    {
        var tokenBytes = Encoding.UTF8.GetBytes(token);
        try
        {
            var digest = SHA256.HashData(tokenBytes);
            try
            {
                return ToBase64Url(digest);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(digest);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(tokenBytes);
        }
    }

    public static bool FingerprintsMatch(string left, string right)
    {
        var leftBytes = Encoding.ASCII.GetBytes(left);
        var rightBytes = Encoding.ASCII.GetBytes(right);
        try
        {
            return leftBytes.Length == rightBytes.Length
                && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(leftBytes);
            CryptographicOperations.ZeroMemory(rightBytes);
        }
    }

    private static string ToBase64Url(ReadOnlySpan<byte> value)
    {
        return Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
}
