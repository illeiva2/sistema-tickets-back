using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Grf.ItAgent.Contracts;
using Grf.ItAgent.Security;

namespace Grf.ItAgent.Storage;

internal sealed class CredentialStore
{
    public const string PendingStatus = "pending";
    public const string EnrolledStatus = "enrolled";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    private readonly string _path;
    private readonly DpapiSecretProtector _protector;

    public CredentialStore(string path, DpapiSecretProtector protector)
    {
        _path = Path.GetFullPath(path);
        _protector = protector;
    }

    public StoredEnrollment? Load()
    {
        if (!File.Exists(_path))
        {
            return null;
        }

        var encrypted = File.ReadAllBytes(_path);
        byte[]? plaintext = null;
        try
        {
            plaintext = _protector.Unprotect(encrypted);
            var credentials = JsonSerializer.Deserialize<StoredEnrollment>(plaintext, JsonOptions)
                ?? throw new CryptographicException("La credencial cifrada está vacía.");
            Validate(credentials);
            return credentials;
        }
        catch (JsonException exception)
        {
            throw new CryptographicException("La credencial cifrada no tiene un formato válido.", exception);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(encrypted);
            if (plaintext is not null)
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }
    }

    public void SavePending(string deviceSecret, string tokenFingerprint)
    {
        Save(new StoredEnrollment(PendingStatus, deviceSecret, null, tokenFingerprint));
    }

    public void SaveEnrolled(string deviceId, string deviceSecret)
    {
        Save(new StoredEnrollment(EnrolledStatus, deviceSecret, deviceId, null));
    }

    private void Save(StoredEnrollment credentials)
    {
        Validate(credentials);
        var plaintext = JsonSerializer.SerializeToUtf8Bytes(credentials, JsonOptions);
        byte[]? encrypted = null;
        try
        {
            encrypted = _protector.Protect(plaintext);
            AtomicFile.WriteAllBytes(_path, encrypted);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
            if (encrypted is not null)
            {
                CryptographicOperations.ZeroMemory(encrypted);
            }
        }
    }

    public static DeviceCredentials GetDeviceCredentials(StoredEnrollment enrollment)
    {
        Validate(enrollment);
        if (!string.Equals(enrollment.Status, EnrolledStatus, StringComparison.Ordinal))
        {
            throw new CryptographicException("El dispositivo todavía no está enrolado.");
        }

        return new DeviceCredentials(enrollment.DeviceId!, enrollment.DeviceSecret);
    }

    private static void Validate(StoredEnrollment enrollment)
    {
        if (enrollment.DeviceSecret.Length != 43
            || enrollment.DeviceSecret.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '_' and not '-'))
        {
            throw new CryptographicException("El secreto del dispositivo no es válido.");
        }

        if (string.Equals(enrollment.Status, PendingStatus, StringComparison.Ordinal))
        {
            if (enrollment.DeviceId is not null
                || string.IsNullOrWhiteSpace(enrollment.TokenFingerprint)
                || enrollment.TokenFingerprint.Length != 43
                || enrollment.TokenFingerprint.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '_' and not '-'))
            {
                throw new CryptographicException("El estado de enrolamiento pendiente no es válido.");
            }

            return;
        }

        if (!string.Equals(enrollment.Status, EnrolledStatus, StringComparison.Ordinal)
            || !IsValidDeviceId(enrollment.DeviceId)
            || enrollment.TokenFingerprint is not null)
        {
            throw new CryptographicException("El estado de enrolamiento confirmado no es válido.");
        }
    }

    private static bool IsValidDeviceId(string? deviceId)
    {
        return deviceId is { Length: >= 9 and <= 200 }
            && deviceId[0] == 'c'
            && deviceId.All(character => char.IsAsciiLetterOrDigit(character));
    }
}
