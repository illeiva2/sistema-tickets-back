using Grf.NetCollector.Configuration;
using Grf.NetCollector.Storage;

namespace Grf.NetCollector.Security;

/// <summary>
/// Huellas de los certificados autofirmados (MikroTik, controlador UniFi). Si la configuración
/// trae la huella se exige esa; si no, la primera que se ve queda anotada en el estado y desde
/// ahí se exige (confianza en el primer uso). Un certificado distinto corta antes de mandar la clave.
/// </summary>
internal sealed class CertificatePins(CollectorState state)
{
    private readonly object _sync = new();

    public bool Accept(string endpoint, string fingerprint, string? configured)
    {
        var seen = CertificatePinFormat.Normalize(fingerprint);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return CertificatePinFormat.Normalize(configured) == seen;
        }

        lock (_sync)
        {
            if (state.Pins.TryGetValue(endpoint, out var known))
            {
                return known == seen;
            }

            state.Pins[endpoint] = seen;
            return true;
        }
    }
}
