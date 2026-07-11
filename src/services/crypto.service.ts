import crypto from "crypto";
import { config } from "../config";
import { ApiError } from "../lib/errors";

// Cifrado de secretos de Gestión IT (PUK de SIM, password de UltraVNC).
// Política única del diseño (docs/IT_MANAGEMENT_DESIGN.md, sección 7):
// - Por defecto los secretos NO se guardan en esta base (usar secretsRef).
// - Cuando el negocio exige persistir: AES-256-GCM con UNA clave maestra
//   (IT_SECRETS_KEY, 32 bytes, en env) e IV/nonce aleatorio por registro.
// - Formato único cipherText/iv/authTag (base64) + keyVersion para poder
//   rotar la clave maestra sin re-cifrar todo de una.
// La clave es obligatoria SOLO al usar este servicio (lazy), nunca al boot.

// Versión de clave con la que se cifra HOY. Al rotar la clave maestra se
// incrementa y decryptSecret aprende a resolver las versiones anteriores.
export const CURRENT_KEY_VERSION = 1;

// Payload cifrado tal como se persiste (ej. DeviceVncCredential o los
// campos puk* de PhoneLine).
export interface EncryptedSecret {
  cipherText: string; // base64
  iv: string; // base64, nonce único por cifrado
  authTag: string; // base64, tag de autenticación GCM
  keyVersion: number;
}

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32;
// 12 bytes es el tamaño de nonce recomendado para GCM (NIST SP 800-38D).
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

// Resuelve la clave maestra para una versión dada. Lazy a propósito:
// si IT_SECRETS_KEY no está seteada, el resto del sistema funciona y solo
// fallan (con error claro) los endpoints que cifran/descifran secretos.
const loadKey = (keyVersion: number): Buffer => {
  if (keyVersion !== CURRENT_KEY_VERSION) {
    throw new ApiError(
      "IT_SECRETS_KEY_VERSION_UNSUPPORTED",
      `Versión de clave no soportada: ${keyVersion}. Este backend solo conoce la versión ${CURRENT_KEY_VERSION}.`,
      500,
    );
  }

  const raw = config.itSecrets.key;
  if (!raw) {
    throw new ApiError(
      "IT_SECRETS_KEY_MISSING",
      "Falta configurar IT_SECRETS_KEY (clave maestra de 32 bytes, en hex o base64) para cifrar/descifrar secretos de Gestión IT.",
      500,
    );
  }

  // Hex (64 chars) o base64; en ambos casos deben decodificar a 32 bytes.
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");

  if (key.length !== KEY_LENGTH_BYTES) {
    throw new ApiError(
      "IT_SECRETS_KEY_INVALID",
      "IT_SECRETS_KEY inválida: debe decodificar a exactamente 32 bytes (hex de 64 chars o base64).",
      500,
    );
  }

  return key;
};

export class CryptoService {
  // Cifra un secreto en texto plano. Genera un IV aleatorio nuevo en cada
  // llamada (nunca se reutiliza un nonce con la misma clave en GCM).
  static encryptSecret(plainText: string): EncryptedSecret {
    const key = loadKey(CURRENT_KEY_VERSION);
    const iv = crypto.randomBytes(IV_LENGTH_BYTES);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    const cipherText = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);

    return {
      cipherText: cipherText.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion: CURRENT_KEY_VERSION,
    };
  }

  // Descifra un payload persistido. Si el cipherText/iv/authTag fue
  // adulterado (o la clave no corresponde), GCM no autentica y se
  // devuelve un error claro sin filtrar detalles criptográficos.
  static decryptSecret(secret: EncryptedSecret): string {
    const key = loadKey(secret.keyVersion);

    try {
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(secret.iv, "base64"),
        { authTagLength: AUTH_TAG_LENGTH_BYTES },
      );
      decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));

      return Buffer.concat([
        decipher.update(Buffer.from(secret.cipherText, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new ApiError(
        "IT_SECRET_DECRYPTION_FAILED",
        "No se pudo descifrar el secreto: el payload fue adulterado o la clave configurada no corresponde.",
        500,
      );
    }
  }
}
