import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cobertura del verify callback de la estrategia Google: quién entra,
 * quién se autoprovisiona y quién rebota. Se accede a la estrategia
 * registrada vía passport._strategy("google") reimportando el módulo por
 * caso para poder variar las env de dominios.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  hash: vi.fn().mockResolvedValue("hashed-password"),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/lib/database", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      findFirst: mocks.userFindFirst,
      create: mocks.userCreate,
      update: mocks.userUpdate,
    },
  },
}));

vi.mock("../src/lib/logger", () => ({
  logger: {
    info: mocks.info,
    warn: mocks.warn,
    error: mocks.error,
  },
}));

vi.mock("bcryptjs", () => ({
  default: { hash: mocks.hash },
}));

type VerifyDone = (error: unknown, user?: unknown) => void;
type Verify = (
  accessToken: string,
  refreshToken: string,
  profile: Record<string, unknown>,
  done: VerifyDone,
) => Promise<void>;

const ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_WORKSPACE_DOMAINS",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

async function loadVerify(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  vi.resetModules();
  process.env.GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID ?? "client-id-test";
  process.env.GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET ?? "client-secret-test";
  if (env.GOOGLE_WORKSPACE_DOMAINS === undefined) {
    delete process.env.GOOGLE_WORKSPACE_DOMAINS;
  } else {
    process.env.GOOGLE_WORKSPACE_DOMAINS = env.GOOGLE_WORKSPACE_DOMAINS;
  }

  const { default: configuredPassport } = await import("../src/config/passport");
  const strategy = (
    configuredPassport as unknown as {
      _strategy: (name: string) => { _verify: Verify } | undefined;
    }
  )._strategy("google");
  if (!strategy) throw new Error("La estrategia google no quedó registrada");
  return strategy._verify;
}

const profileFor = (email: string, googleId = "google-123") => ({
  id: googleId,
  displayName: "Aldana Reynoso",
  name: { givenName: "Aldana" },
  emails: [{ value: email }],
});

const activeUser = (overrides: Record<string, unknown> = {}) => ({
  id: "user-1",
  email: "aldana.reynoso@grf.com.ar",
  name: "Aldana Reynoso",
  role: "USER",
  googleId: "google-123",
  isActive: true,
  deletedAt: null,
  ...overrides,
});

const runVerify = async (verify: Verify, email: string, googleId?: string) => {
  const done = vi.fn<VerifyDone>();
  await verify("access", "refresh", profileFor(email, googleId), done);
  expect(done).toHaveBeenCalledOnce();
  return done.mock.calls[0];
};

describe("acceso por Google (verify callback)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hash.mockResolvedValue("hashed-password");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("deja entrar a un usuario existente con rol USER", async () => {
    const verify = await loadVerify({
      GOOGLE_WORKSPACE_DOMAINS: "grf.com.ar,molinoforzani.com",
    });
    const user = activeUser();
    mocks.userFindUnique.mockResolvedValue(user);
    mocks.userFindFirst.mockResolvedValue(user);

    const [error, resolved] = await runVerify(
      verify,
      "aldana.reynoso@grf.com.ar",
    );

    expect(error).toBeNull();
    expect(resolved).toMatchObject({ id: "user-1", role: "USER" });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("autoprovisiona con rol USER una cuenta nueva del dominio permitido", async () => {
    const verify = await loadVerify({
      GOOGLE_WORKSPACE_DOMAINS: "grf.com.ar,molinoforzani.com",
    });
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockImplementation(({ data }: { data: object }) =>
      Promise.resolve({ id: "user-new", isActive: true, deletedAt: null, ...data }),
    );

    const [error, resolved] = await runVerify(
      verify,
      "Nuevo.Empleado@MolinoForzani.com",
      "google-999",
    );

    expect(error).toBeNull();
    expect(resolved).toMatchObject({ id: "user-new", role: "USER" });
    expect(mocks.userCreate).toHaveBeenCalledOnce();
    const createData = mocks.userCreate.mock.calls[0][0].data;
    expect(createData).toMatchObject({
      email: "nuevo.empleado@molinoforzani.com",
      googleId: "google-999",
      role: "USER",
      passwordHash: "hashed-password",
    });
  });

  it("sin allowlist configurada no autocrea cuentas", async () => {
    const verify = await loadVerify({ GOOGLE_WORKSPACE_DOMAINS: undefined });
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userFindFirst.mockResolvedValue(null);

    const [error, resolved] = await runVerify(verify, "alguien@grf.com.ar");

    expect((error as { code?: string })?.code).toBe("it_access_required");
    expect(resolved).toBe(false);
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("rechaza dominios ajenos aunque la cuenta no exista", async () => {
    const verify = await loadVerify({
      GOOGLE_WORKSPACE_DOMAINS: "grf.com.ar,molinoforzani.com",
    });

    const [error, resolved] = await runVerify(verify, "intruso@gmail.com");

    expect((error as { code?: string })?.code).toBe("domain_not_allowed");
    expect(resolved).toBe(false);
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("rechaza cuentas desactivadas sin importar el rol", async () => {
    const verify = await loadVerify({
      GOOGLE_WORKSPACE_DOMAINS: "grf.com.ar",
    });
    const disabled = activeUser({ isActive: false, role: "ADMIN" });
    mocks.userFindUnique.mockResolvedValue(disabled);
    mocks.userFindFirst.mockResolvedValue(disabled);

    const [error, resolved] = await runVerify(
      verify,
      "aldana.reynoso@grf.com.ar",
    );

    expect((error as { code?: string })?.code).toBe("account_disabled");
    expect(resolved).toBe(false);
  });

  it("rechaza conflictos de identidad googleId/email", async () => {
    const verify = await loadVerify({
      GOOGLE_WORKSPACE_DOMAINS: "grf.com.ar",
    });
    mocks.userFindUnique.mockResolvedValue(activeUser({ id: "user-1" }));
    mocks.userFindFirst.mockResolvedValue(activeUser({ id: "user-2" }));

    const [error, resolved] = await runVerify(
      verify,
      "aldana.reynoso@grf.com.ar",
    );

    expect((error as { code?: string })?.code).toBe("it_access_required");
    expect(resolved).toBe(false);
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });
});
