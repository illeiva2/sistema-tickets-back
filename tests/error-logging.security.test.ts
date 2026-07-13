import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/lib/logger", () => ({
  logger: {
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import { ApiError, errorHandler, notFoundHandler } from "../src/lib/errors";

const response = () => {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
};

const requestWithSecretQuery = () =>
  ({
    headers: { "x-request-id": "security-log-test" },
    method: "GET",
    path: "/api/auth/google/callback",
    url: "/api/auth/google/callback?code=google-secret&state=state-secret",
  }) as Request;

describe("redacción de query strings en logs de errores", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registra sólo el path al manejar un ApiError", () => {
    errorHandler(
      new ApiError("AUTH_FAILED", "Autenticación fallida", 400),
      requestWithSecretQuery(),
      response(),
      vi.fn() as NextFunction,
    );

    const logs = JSON.stringify(mocks.warn.mock.calls);
    expect(logs).toContain("/api/auth/google/callback");
    expect(logs).not.toContain("google-secret");
    expect(logs).not.toContain("state-secret");
  });

  it("no registra la query tampoco en 404", () => {
    notFoundHandler(requestWithSecretQuery(), response());

    const logs = JSON.stringify(mocks.warn.mock.calls);
    expect(logs).toContain("/api/auth/google/callback");
    expect(logs).not.toContain("google-secret");
    expect(logs).not.toContain("state-secret");
  });
});
