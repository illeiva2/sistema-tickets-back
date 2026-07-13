import { createHash } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  createExchangeCode: vi.fn(),
  consumeExchangeCode: vi.fn(),
  findExchangeCode: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("passport", () => ({
  default: { authenticate: mocks.authenticate },
}));

vi.mock("../src/lib/database", () => ({
  prisma: {
    oAuthExchangeCode: {
      create: mocks.createExchangeCode,
      updateMany: mocks.consumeExchangeCode,
      findUnique: mocks.findExchangeCode,
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

import {
  OAuthController,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_MS,
} from "../src/controllers/oauth.controller";

const originalFrontendUrl = process.env.FRONTEND_URL;

const makeResponse = () => {
  const response = {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    redirect: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
    status: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
    redirect: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
};

const initiate = () => {
  let authenticateOptions: Record<string, unknown> | undefined;
  mocks.authenticate.mockImplementation(
    (_strategy: string, options: Record<string, unknown>) => {
      authenticateOptions = options;
      return vi.fn();
    },
  );

  const response = makeResponse();
  const next = vi.fn();
  OAuthController.initiateGoogleAuth(
    { headers: {} } as Request,
    response,
    next as NextFunction,
  );

  expect(next).not.toHaveBeenCalled();
  expect(mocks.authenticate).toHaveBeenCalledOnce();
  expect(response.cookie).toHaveBeenCalledOnce();

  return {
    state: String(authenticateOptions?.state),
    signedCookie: String(response.cookie.mock.calls[0][1]),
    cookieOptions: response.cookie.mock.calls[0][2] as Record<string, unknown>,
  };
};

const callbackRequest = (state: unknown, cookieHeader?: string) =>
  ({
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      "x-request-id": "oauth-security-request",
    },
    query: { state },
  }) as unknown as Request;

const serializedLogs = () =>
  JSON.stringify([
    ...mocks.info.mock.calls,
    ...mocks.warn.mock.calls,
    ...mocks.error.mock.calls,
  ]);

const exchange = async (code: string) => {
  const response = makeResponse();
  const next = vi.fn();
  const handler = OAuthController.exchangeGoogleCode.at(-1) as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<unknown>;

  await handler(
    { body: { code }, headers: {} } as Request,
    response,
    next as NextFunction,
  );
  return { response, next };
};

describe("límites de seguridad OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = "https://tickets-preview.example.vercel.app";
    mocks.createExchangeCode.mockResolvedValue({ id: "exchange-record" });
  });

  afterEach(() => {
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  });

  it("inicia Google con nonce firmado en cookie restringida al callback", () => {
    const { state, signedCookie, cookieOptions } = initiate();
    const cookieParts = signedCookie.split(".");

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieParts).toHaveLength(2);
    expect(cookieParts[0]).toBe(state);
    expect(cookieParts[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signedCookie).not.toBe(state);
    expect(cookieOptions).toEqual(
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        maxAge: OAUTH_STATE_MAX_AGE_MS,
        path: "/api/auth/google/callback",
      }),
    );
  });

  it("rechaza state y cookie iguales si el atacante no puede firmarlos", () => {
    const attackerState = "A".repeat(43);
    mocks.authenticate.mockReset();
    const response = makeResponse();
    const next = vi.fn();

    OAuthController.googleCallback(
      callbackRequest(attackerState, `${OAUTH_STATE_COOKIE}=${attackerState}`),
      response,
      next,
    );

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(response.clearCookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      expect.objectContaining({ path: "/api/auth/google/callback" }),
    );
    const redirectUrl = new URL(response.redirect.mock.calls[0][0]);
    expect(redirectUrl.searchParams.get("error")).toBe("oauth_state_invalid");
    expect([...redirectUrl.searchParams.keys()]).toEqual(["error"]);
    expect(serializedLogs()).not.toContain(attackerState);
  });

  it("rechaza callback sin cookie antes de invocar Passport y limpia state", () => {
    const state = "M".repeat(43);
    const response = makeResponse();
    const next = vi.fn();

    OAuthController.googleCallback(
      callbackRequest(state),
      response,
      next,
    );

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(response.clearCookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      expect.objectContaining({ path: "/api/auth/google/callback" }),
    );
    const redirectUrl = new URL(response.redirect.mock.calls[0][0]);
    expect(redirectUrl.searchParams.get("error")).toBe("oauth_state_invalid");
  });

  it("rechaza firma alterada, cookie duplicada y state multivalor", () => {
    const { state, signedCookie } = initiate();
    const last = signedCookie.at(-1);
    const tampered = `${signedCookie.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    const cases: Array<{ state: unknown; cookie: string }> = [
      {
        state,
        cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(tampered)}`,
      },
      {
        state,
        cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(signedCookie)}; ${OAUTH_STATE_COOKIE}=${encodeURIComponent(signedCookie)}`,
      },
      {
        state: [state, state],
        cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(signedCookie)}`,
      },
    ];

    for (const testCase of cases) {
      mocks.authenticate.mockReset();
      const response = makeResponse();
      const next = vi.fn();

      OAuthController.googleCallback(
        callbackRequest(testCase.state, testCase.cookie),
        response,
        next,
      );

      expect(mocks.authenticate).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      const redirectUrl = new URL(response.redirect.mock.calls[0][0]);
      expect(redirectUrl.searchParams.get("error")).toBe(
        "oauth_state_invalid",
      );
    }
  });

  it("con state válido redirige solo con código opaco hasheado y no filtra secretos", async () => {
    const { state, signedCookie } = initiate();
    const sensitiveEmail = "sensitive.oauth.user@grf.com.ar";
    const user = {
      id: "oauth-user-id",
      email: sensitiveEmail,
      name: "Sensitive OAuth User",
      role: "AGENT",
      isActive: true,
      deletedAt: null,
    };

    mocks.authenticate.mockReset();
    mocks.authenticate.mockImplementation(
      (
        _strategy: string,
        _options: unknown,
        callback: (error: unknown, authenticatedUser: unknown) => unknown,
      ) =>
        (_req: Request, _res: Response, _next: NextFunction) =>
          callback(null, user),
    );

    const response = makeResponse();
    const next = vi.fn();
    OAuthController.googleCallback(
      callbackRequest(
        state,
        `other=value; ${OAUTH_STATE_COOKIE}=${encodeURIComponent(signedCookie)}`,
      ),
      response,
      next,
    );

    await vi.waitFor(() => expect(response.redirect).toHaveBeenCalledOnce());
    expect(next).not.toHaveBeenCalled();
    expect(response.clearCookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/api/auth/google/callback",
      }),
    );

    const redirectUrl = new URL(response.redirect.mock.calls[0][0]);
    const exchangeCode = redirectUrl.searchParams.get("code");
    expect([...redirectUrl.searchParams.keys()]).toEqual(["code"]);
    expect(exchangeCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redirectUrl.toString()).not.toContain("accessToken");
    expect(redirectUrl.toString()).not.toContain("refreshToken");
    expect(redirectUrl.toString()).not.toContain("user=");
    expect(redirectUrl.toString()).not.toContain(sensitiveEmail);

    const persisted = mocks.createExchangeCode.mock.calls[0][0].data;
    expect(persisted.codeHash).toBe(
      createHash("sha256").update(exchangeCode!, "utf8").digest("hex"),
    );
    expect(JSON.stringify(persisted)).not.toContain(exchangeCode!);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(response.setHeader).toHaveBeenCalledWith("Pragma", "no-cache");

    const logs = serializedLogs();
    expect(logs).not.toContain(state);
    expect(logs).not.toContain(signedCookie);
    expect(logs).not.toContain(exchangeCode!);
    expect(logs).not.toContain(sensitiveEmail);
  });

  it("consume el exchange code una sola vez y rechaza el replay", async () => {
    const code = "R".repeat(43);
    const user = {
      id: "oauth-replay-user",
      email: "oauth.replay@grf.com.ar",
      name: "OAuth Replay",
      role: "USER",
      isActive: true,
      deletedAt: null,
      mustChangePassword: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    let consumed = false;
    mocks.consumeExchangeCode.mockImplementation(async () => {
      if (consumed) return { count: 0 };
      consumed = true;
      return { count: 1 };
    });
    mocks.findExchangeCode.mockResolvedValue({ user });

    const first = await exchange(code);
    expect(first.next).not.toHaveBeenCalled();
    expect(first.response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
        }),
      }),
    );
    expect(mocks.consumeExchangeCode).toHaveBeenCalledWith({
      where: {
        codeHash: createHash("sha256").update(code).digest("hex"),
        consumedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { consumedAt: expect.any(Date) },
    });

    const replay = await exchange(code);
    expect(replay.response.json).not.toHaveBeenCalled();
    const replayError = replay.next.mock.calls[0][0] as {
      code: string;
      statusCode: number;
    };
    expect(replayError.code).toBe("INVALID_OAUTH_CODE");
    expect(replayError.statusCode).toBe(400);
    expect(mocks.findExchangeCode).toHaveBeenCalledOnce();
  });

  it("rechaza código expirado sin buscar usuario ni emitir JWTs", async () => {
    const expiredCode = "E".repeat(43);
    mocks.consumeExchangeCode.mockResolvedValue({ count: 0 });

    const { response, next } = await exchange(expiredCode);

    expect(response.json).not.toHaveBeenCalled();
    expect(mocks.findExchangeCode).not.toHaveBeenCalled();
    const error = next.mock.calls[0][0] as {
      code: string;
      statusCode: number;
    };
    expect(error.code).toBe("INVALID_OAUTH_CODE");
    expect(error.statusCode).toBe(400);
    expect(serializedLogs()).not.toContain(expiredCode);
  });

  it("consume el código pero no entrega JWTs si la cuenta quedó inactiva", async () => {
    const code = "I".repeat(43);
    mocks.consumeExchangeCode.mockResolvedValue({ count: 1 });
    mocks.findExchangeCode.mockResolvedValue({
      user: {
        id: "inactive-oauth-user",
        email: "inactive@grf.com.ar",
        name: "Inactive",
        role: "USER",
        isActive: false,
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
        mustChangePassword: false,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    const { response, next } = await exchange(code);

    expect(response.json).not.toHaveBeenCalled();
    const error = next.mock.calls[0][0] as {
      code: string;
      statusCode: number;
    };
    expect(error.code).toBe("ACCOUNT_DISABLED");
    expect(error.statusCode).toBe(403);
  });
});
