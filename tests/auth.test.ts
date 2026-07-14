import { vi, describe, it, beforeEach, expect } from "vitest";

// Mocks ANTES de los imports. vi.mock se hoistea automáticamente.
vi.mock("../src/lib/database", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { prisma: mockDeep() };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: "test" }),
      verify: vi.fn().mockResolvedValue(true),
    }),
  },
}));

import request from "supertest";
import bcrypt from "bcryptjs";
import { createHash } from "crypto";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import { signRefreshToken, signAccessToken, makeUser } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("login OK con credenciales válidas", async () => {
    const password = "testpass123";
    const passwordHash = await bcrypt.hash(password, 8);
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({ passwordHash }) as any,
    );

    const res = await request(app).post("/api/auth/login").send({
      email: "user@test.local",
      password,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.user.email).toBe("user@test.local");
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it("rechaza login con email inexistente", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);

    const res = await request(app).post("/api/auth/login").send({
      email: "nope@test.local",
      password: "any",
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rechaza login con contraseña incorrecta", async () => {
    const passwordHash = await bcrypt.hash("realpass", 8);
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({ passwordHash }) as any,
    );

    const res = await request(app).post("/api/auth/login").send({
      email: "user@test.local",
      password: "wrongpass",
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rechaza login si la cuenta está desactivada (soft delete)", async () => {
    const passwordHash = await bcrypt.hash("anypass", 8);
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({ passwordHash, isActive: false }) as any,
    );

    const res = await request(app).post("/api/auth/login").send({
      email: "user@test.local",
      password: "anypass",
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_DISABLED");
  });

  it("rechaza usuario Google que no configuró password local", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({
        googleId: "google-id",
        mustChangePassword: true,
        passwordHash: "",
      }) as any,
    );

    const res = await request(app).post("/api/auth/login").send({
      email: "user@test.local",
      password: "x",
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("GOOGLE_OAUTH_USER");
  });

  it("valida payload: email inválido devuelve 400", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: "no-es-un-email",
      password: "x",
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/register", () => {
  it("no expone el registro OAuth legacy", async () => {
    const res = await request(app).post("/api/auth/register").send({
      name: "New User",
      email: "new.user@grf.com.ar",
      role: "ADMIN",
      googleAccessToken: "google-access-token",
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/google/exchange", () => {
  const code = "B".repeat(43);
  const codeHash = createHash("sha256").update(code).digest("hex");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("consume el hash atómicamente y entrega JWTs en JSON", async () => {
    const user = makeUser({ id: "oauth-user-1", role: "AGENT" });
    prismaMock.oAuthExchangeCode.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.oAuthExchangeCode.findUnique.mockResolvedValueOnce({
      id: "exchange-code-1",
      codeHash,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: new Date(),
      createdAt: new Date(),
      user,
    } as any);

    const res = await request(app)
      .post("/api/auth/google/exchange")
      .send({ code });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.user.id).toBe("oauth-user-1");
    expect(prismaMock.oAuthExchangeCode.updateMany).toHaveBeenCalledWith({
      where: {
        codeHash,
        consumedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("rechaza código desconocido, vencido o ya consumido", async () => {
    prismaMock.oAuthExchangeCode.updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await request(app)
      .post("/api/auth/google/exchange")
      .send({ code });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_OAUTH_CODE");
    expect(prismaMock.oAuthExchangeCode.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 sin token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("devuelve el usuario autenticado", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({ id: "user-1", email: "user@test.local" }) as any,
    );

    const token = signAccessToken({ id: "user-1", email: "user@test.local" });
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe("user@test.local");
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });
});

describe("POST /api/auth/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emite nuevo access token con refresh válido", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({ id: "user-1" }) as any,
    );

    const refreshToken = signRefreshToken("user-1");
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it("rechaza refresh si el usuario está desactivado", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({ id: "user-1", isActive: false }) as any,
    );

    const refreshToken = signRefreshToken("user-1");
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_DISABLED");
  });

  it("rechaza refresh si el token es inválido", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "garbage" });

    expect(res.status).toBe(401);
  });
});
