import { describe, it, expect, beforeEach, vi } from "vitest";

// Tests del servicio de cifrado de secretos de Gestión IT (AES-256-GCM,
// clave maestra IT_SECRETS_KEY, formato cipherText/iv/authTag/keyVersion).
//
// El config lee IT_SECRETS_KEY al importarse, así que cada grupo resetea
// el registro de módulos y re-importa el servicio con el env que necesita
// (con la clave, sin la clave, con clave inválida).

// Clave de test: 32 bytes expresados en hex (64 chars).
const TEST_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type CryptoModule = typeof import("../src/services/crypto.service");

const loadCryptoService = async (): Promise<CryptoModule> => {
  vi.resetModules();
  return import("../src/services/crypto.service");
};

// Adultera un campo base64 invirtiendo los bits de su primer byte.
const flipFirstByte = (b64: string): string => {
  const buf = Buffer.from(b64, "base64");
  buf[0] = buf[0] ^ 0xff;
  return buf.toString("base64");
};

// Ejecuta fn esperando que lance, y devuelve el error para inspeccionarlo.
// (No usamos instanceof ApiError porque resetModules genera otra instancia
// de la clase; alcanza con code/message/statusCode.)
const catchError = (fn: () => unknown): any => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("Se esperaba que lanzara y no lanzó");
};

describe("CryptoService: roundtrip encrypt/decrypt", () => {
  let svc: CryptoModule;

  beforeEach(async () => {
    process.env.IT_SECRETS_KEY = TEST_KEY_HEX;
    svc = await loadCryptoService();
  });

  it("descifra exactamente lo que cifró", () => {
    const secret = svc.CryptoService.encryptSecret("12345678");
    expect(svc.CryptoService.decryptSecret(secret)).toBe("12345678");
  });

  it("soporta texto con tildes, ñ y símbolos", () => {
    const plain = "PUK: 87654321 — línea de Ñoño (¡temporal!)";
    const secret = svc.CryptoService.encryptSecret(plain);
    expect(svc.CryptoService.decryptSecret(secret)).toBe(plain);
  });

  it("emite el formato unificado cipherText/iv/authTag/keyVersion en base64", () => {
    const secret = svc.CryptoService.encryptSecret("vnc-password");

    expect(secret.keyVersion).toBe(svc.CURRENT_KEY_VERSION);
    // Campos base64 válidos con los tamaños esperados (IV 12B, tag 16B).
    expect(Buffer.from(secret.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(secret.authTag, "base64")).toHaveLength(16);
    expect(Buffer.from(secret.cipherText, "base64").length).toBeGreaterThan(0);
    // El texto plano no viaja en ningún campo.
    expect(secret.cipherText).not.toContain("vnc-password");
  });

  it("acepta la clave también en base64", async () => {
    process.env.IT_SECRETS_KEY = Buffer.from(TEST_KEY_HEX, "hex").toString(
      "base64",
    );
    const svcB64 = await loadCryptoService();

    const secret = svcB64.CryptoService.encryptSecret("mismo-secreto");
    expect(svcB64.CryptoService.decryptSecret(secret)).toBe("mismo-secreto");
  });
});

describe("CryptoService: payload adulterado", () => {
  let svc: CryptoModule;

  beforeEach(async () => {
    process.env.IT_SECRETS_KEY = TEST_KEY_HEX;
    svc = await loadCryptoService();
  });

  it("rechaza un authTag inválido con error claro", () => {
    const secret = svc.CryptoService.encryptSecret("12345678");
    const tampered = { ...secret, authTag: flipFirstByte(secret.authTag) };

    const err = catchError(() => svc.CryptoService.decryptSecret(tampered));
    expect(err.code).toBe("IT_SECRET_DECRYPTION_FAILED");
    expect(err.statusCode).toBe(500);
  });

  it("rechaza un cipherText modificado", () => {
    const secret = svc.CryptoService.encryptSecret("12345678");
    const tampered = {
      ...secret,
      cipherText: flipFirstByte(secret.cipherText),
    };

    const err = catchError(() => svc.CryptoService.decryptSecret(tampered));
    expect(err.code).toBe("IT_SECRET_DECRYPTION_FAILED");
  });

  it("rechaza un IV modificado", () => {
    const secret = svc.CryptoService.encryptSecret("12345678");
    const tampered = { ...secret, iv: flipFirstByte(secret.iv) };

    const err = catchError(() => svc.CryptoService.decryptSecret(tampered));
    expect(err.code).toBe("IT_SECRET_DECRYPTION_FAILED");
  });

  it("rechaza una keyVersion que este backend no conoce", () => {
    const secret = svc.CryptoService.encryptSecret("12345678");
    const fromTheFuture = { ...secret, keyVersion: 99 };

    const err = catchError(() =>
      svc.CryptoService.decryptSecret(fromTheFuture),
    );
    expect(err.code).toBe("IT_SECRETS_KEY_VERSION_UNSUPPORTED");
  });
});

describe("CryptoService: configuración de la clave", () => {
  it("falla con error claro si falta IT_SECRETS_KEY", async () => {
    // "" en vez de delete: dotenv no pisa vars ya presentes en process.env,
    // así el test no depende del contenido del .env real.
    process.env.IT_SECRETS_KEY = "";
    const svc = await loadCryptoService();

    const errEncrypt = catchError(() =>
      svc.CryptoService.encryptSecret("12345678"),
    );
    expect(errEncrypt.code).toBe("IT_SECRETS_KEY_MISSING");
    expect(errEncrypt.message).toContain("IT_SECRETS_KEY");

    const errDecrypt = catchError(() =>
      svc.CryptoService.decryptSecret({
        cipherText: "AAAA",
        iv: "AAAAAAAAAAAAAAAA",
        authTag: "AAAAAAAAAAAAAAAAAAAAAA==",
        keyVersion: 1,
      }),
    );
    expect(errDecrypt.code).toBe("IT_SECRETS_KEY_MISSING");
  });

  it("rechaza una clave que no decodifica a 32 bytes", async () => {
    process.env.IT_SECRETS_KEY = "demasiado-corta";
    const svc = await loadCryptoService();

    const err = catchError(() => svc.CryptoService.encryptSecret("12345678"));
    expect(err.code).toBe("IT_SECRETS_KEY_INVALID");
    expect(err.message).toContain("32 bytes");
  });
});

describe("CryptoService: unicidad de IV", () => {
  it("nunca repite IV entre cifrados (mismo plaintext, misma clave)", async () => {
    process.env.IT_SECRETS_KEY = TEST_KEY_HEX;
    const svc = await loadCryptoService();

    const rounds = Array.from({ length: 20 }, () =>
      svc.CryptoService.encryptSecret("12345678"),
    );

    const ivs = new Set(rounds.map((r) => r.iv));
    expect(ivs.size).toBe(rounds.length);

    // Con IV distinto, el mismo plaintext produce cipherText distinto.
    const cipherTexts = new Set(rounds.map((r) => r.cipherText));
    expect(cipherTexts.size).toBe(rounds.length);
  });
});
