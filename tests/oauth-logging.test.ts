import type { NextFunction, Request, Response } from "express";
import { createHmac } from "crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  deserializeUser: vi.fn(),
  serializeUser: vi.fn(),
  strategyOptions: vi.fn(),
  strategyVerify: vi.fn(),
  use: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  updateUser: vi.fn(),
  createUser: vi.fn(),
  createPreferences: vi.fn(),
  createExchangeCode: vi.fn(),
  hash: vi.fn(),
}));

vi.mock("passport", () => ({
  default: {
    authenticate: mocks.authenticate,
    deserializeUser: mocks.deserializeUser,
    serializeUser: mocks.serializeUser,
    use: mocks.use,
  },
}));

vi.mock("passport-google-oauth20", () => ({
  Strategy: class {
    constructor(options: unknown, verify: (...args: unknown[]) => unknown) {
      mocks.strategyOptions(options);
      mocks.strategyVerify.mockImplementation(verify);
    }
  },
}));

vi.mock("bcryptjs", () => ({
  default: { hash: mocks.hash },
}));

vi.mock("../src/lib/database", () => ({
  prisma: {
    user: {
      findFirst: mocks.findFirst,
      findUnique: mocks.findUnique,
      update: mocks.updateUser,
      create: mocks.createUser,
    },
    notificationPreferences: { create: mocks.createPreferences },
    oAuthExchangeCode: { create: mocks.createExchangeCode },
  },
}));

vi.mock("../src/config/oauth", () => ({
  oauthConfig: {
    google: {
      clientID: "test-google-client-id",
      clientSecret: "test-google-client-secret",
      callbackURL:
        "https://api.staging.example.test/api/auth/google/callback?token=callback-config-secret",
      scope: ["profile", "email"],
      allowedDomains: ["grf.com.ar"],
    },
    jwt: {
      secret: "test-jwt-secret",
      expiresIn: "8h",
      refreshExpiresIn: "7d",
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

import { OAuthController } from "../src/controllers/oauth.controller";

const originalFrontendUrl = process.env.FRONTEND_URL;
const serializeLogs = () =>
  JSON.stringify([
    ...mocks.info.mock.calls,
    ...mocks.warn.mock.calls,
    ...mocks.error.mock.calls,
  ]);

describe("OAuthController logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = "https://staging.example.test";
  });

  afterEach(() => {
    if (originalFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = originalFrontendUrl;
    }
  });

  it("redirige solo con código one-time sin registrar secretos", async () => {
    const sensitiveCode = "google-one-time-code";
    const sensitiveState = "A".repeat(43);
    const stateSignature = createHmac(
      "sha256",
      process.env.SESSION_SECRET!,
    )
      .update(`google-oauth-state:v1:${sensitiveState}`)
      .digest("base64url");
    const sensitiveEmail = "sensitive.user@grf.com.ar";
    const user = {
      id: "user-safe-id",
      email: sensitiveEmail,
      name: "Sensitive User",
      role: "AGENT",
      googleId: "google-sensitive-id",
    };

    mocks.authenticate.mockImplementation(
      (
        _strategy: string,
        _options: unknown,
        callback: (error: unknown, authenticatedUser: unknown, info: unknown) => void,
      ) =>
        (_req: Request, _res: Response, _next: NextFunction) =>
          callback(null, user, { accessToken: "passport-sensitive-info" }),
    );

    const req = {
      headers: {
        "x-request-id": "req-oauth-123",
        cookie: `oauth_state=${sensitiveState}.${stateSignature}`,
      },
      query: { code: sensitiveCode, state: sensitiveState },
    } as unknown as Request;
    const redirect = vi.fn();
    const res = {
      status: vi.fn().mockReturnThis(),
      redirect,
      clearCookie: vi.fn(),
      setHeader: vi.fn(),
    } as unknown as Response;
    const next = vi.fn();

    OAuthController.googleCallback(req, res, next);
    await vi.waitFor(() => expect(redirect).toHaveBeenCalledOnce());

    expect(next).not.toHaveBeenCalled();
    const redirectUrl = new URL(redirect.mock.calls[0][0]);
    const exchangeCode = redirectUrl.searchParams.get("code");
    expect(exchangeCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redirectUrl.searchParams.has("accessToken")).toBe(false);
    expect(redirectUrl.searchParams.has("refreshToken")).toBe(false);
    expect(redirectUrl.searchParams.has("user")).toBe(false);

    const serializedLogs = serializeLogs();

    expect(serializedLogs).toContain("req-oauth-123");
    expect(serializedLogs).toContain("user-safe-id");
    expect(serializedLogs).toContain("https://staging.example.test");
    expect(serializedLogs).toContain("/oauth/callback");
    expect(serializedLogs).not.toContain(sensitiveCode);
    expect(serializedLogs).not.toContain(sensitiveState);
    expect(serializedLogs).not.toContain(sensitiveEmail);
    expect(serializedLogs).not.toContain("Sensitive User");
    expect(serializedLogs).not.toContain("google-sensitive-id");
    expect(serializedLogs).not.toContain("passport-sensitive-info");
    expect(serializedLogs).not.toContain(exchangeCode!);
  });
});

describe("Google Passport pipeline logging", () => {
  const accessToken = "google-access-token-secret";
  const refreshToken = "google-refresh-token-secret";
  const sensitiveEmail = "sensitive.user@grf.com.ar";
  const sensitiveProfileId = "google-profile-sensitive-id";
  const sensitiveDisplayName = "Sensitive Google User";
  let configurationLogs = "";

  const profile = (email = sensitiveEmail) => ({
    id: sensitiveProfileId,
    displayName: sensitiveDisplayName,
    name: { givenName: "Sensitive", familyName: "User" },
    emails: [{ value: email }],
  });

  beforeAll(async () => {
    vi.clearAllMocks();
    mocks.hash.mockResolvedValue("hashed-random-password");
    await import("../src/config/passport");
    configurationLogs = serializeLogs();
  });

  beforeEach(() => {
    mocks.info.mockClear();
    mocks.warn.mockClear();
    mocks.error.mockClear();
    mocks.findFirst.mockReset();
    mocks.findUnique.mockReset().mockResolvedValue(null);
    mocks.updateUser.mockReset();
    mocks.createUser.mockReset();
    mocks.createPreferences.mockReset();
    mocks.hash.mockReset().mockResolvedValue("hashed-random-password");
  });

  afterAll(() => {
    vi.clearAllMocks();
  });

  it("configura la estrategia sin registrar credenciales ni query del callback", () => {
    expect(configurationLogs).toContain("api.staging.example.test");
    expect(configurationLogs).toContain("/api/auth/google/callback");
    expect(configurationLogs).not.toContain("test-google-client-id");
    expect(configurationLogs).not.toContain("test-google-client-secret");
    expect(configurationLogs).not.toContain("callback-config-secret");
  });

  it("autentica un usuario existente sin registrar perfil, email ni tokens", async () => {
    const user = {
      id: "existing-user-safe-id",
      email: sensitiveEmail,
      name: sensitiveDisplayName,
      googleId: sensitiveProfileId,
      role: "AGENT",
    };
    mocks.findFirst.mockResolvedValue(user);
    const done = vi.fn();

    await mocks.strategyVerify(accessToken, refreshToken, profile(), done);

    expect(done).toHaveBeenCalledWith(null, user);
    const logs = serializeLogs();
    expect(logs).toContain("existing-user-safe-id");
    expect(logs).toContain("existing_user");
    expect(logs).not.toContain(sensitiveEmail);
    expect(logs).not.toContain(sensitiveProfileId);
    expect(logs).not.toContain(sensitiveDisplayName);
    expect(logs).not.toContain(accessToken);
    expect(logs).not.toContain(refreshToken);
  });

  it("rechaza una cuenta existente desactivada con código estable", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "disabled-user-id",
      email: sensitiveEmail,
      name: sensitiveDisplayName,
      googleId: sensitiveProfileId,
      role: "AGENT",
      isActive: false,
      deletedAt: null,
    });
    const done = vi.fn();

    await mocks.strategyVerify(accessToken, refreshToken, profile(), done);

    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0][0]).toMatchObject({
      message: "account_disabled",
      code: "account_disabled",
    });
    expect(done.mock.calls[0][1]).toBe(false);
  });

  it("autoprovisiona una cuenta nueva del dominio sin registrar datos sensibles", async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.createUser.mockResolvedValue({
      id: "provisioned-user-safe-id",
      email: sensitiveEmail,
      name: sensitiveDisplayName,
      googleId: sensitiveProfileId,
      role: "USER",
      isActive: true,
      deletedAt: null,
    });
    const done = vi.fn();

    await mocks.strategyVerify(accessToken, refreshToken, profile(), done);

    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0][0]).toBeNull();
    expect(done.mock.calls[0][1]).toMatchObject({
      id: "provisioned-user-safe-id",
      role: "USER",
    });
    expect(mocks.createUser).toHaveBeenCalledOnce();
    const logs = serializeLogs();
    expect(logs).toContain("user_provisioned");
    expect(logs).toContain("provisioned-user-safe-id");
    expect(logs).not.toContain(sensitiveEmail);
    expect(logs).not.toContain(sensitiveProfileId);
    expect(logs).not.toContain(sensitiveDisplayName);
    expect(logs).not.toContain(accessToken);
    expect(logs).not.toContain(refreshToken);
  });

  it("rechaza un email reciclado ya vinculado a otro Google ID", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "provisioned-it-user",
      email: sensitiveEmail,
      googleId: "different-google-subject",
      role: "ADMIN",
      isActive: true,
      deletedAt: null,
    });
    const done = vi.fn();

    await mocks.strategyVerify(accessToken, refreshToken, profile(), done);

    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0][0]).toMatchObject({
      code: "it_access_required",
    });
    expect(done.mock.calls[0][1]).toBe(false);
    expect(serializeLogs()).toContain("identity_mismatch");
  });

  it("rechaza otro dominio sin registrar el email intentado", async () => {
    const externalEmail = "external.person@example.net";
    const done = vi.fn();

    await mocks.strategyVerify(
      accessToken,
      refreshToken,
      profile(externalEmail),
      done,
    );

    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
    const logs = serializeLogs();
    expect(logs).toContain("domain_not_allowed");
    expect(logs).not.toContain(externalEmail);
    expect(logs).not.toContain(accessToken);
    expect(logs).not.toContain(refreshToken);
  });

  it("no filtra datos incluidos en un error interno", async () => {
    const sensitiveError = `database failure for ${sensitiveEmail} using ${accessToken}`;
    mocks.findFirst.mockRejectedValue(new Error(sensitiveError));
    const done = vi.fn();

    await mocks.strategyVerify(accessToken, refreshToken, profile(), done);

    expect(done).toHaveBeenCalledOnce();
    const logs = serializeLogs();
    expect(logs).toContain("Error");
    expect(logs).not.toContain(sensitiveError);
    expect(logs).not.toContain(sensitiveEmail);
    expect(logs).not.toContain(accessToken);
    expect(logs).not.toContain(refreshToken);
  });
});
