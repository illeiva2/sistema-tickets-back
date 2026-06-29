import { vi, describe, it, beforeEach, expect } from "vitest";

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
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import { signAccessToken, makeUser, makeAdmin } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("GET /api/users — listar usuarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("solo ADMIN puede listar", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app).get("/api/users").set(auth(token));
    expect(res.status).toBe(403);
  });

  it("ADMIN obtiene la lista filtrada a activos por default", async () => {
    prismaMock.user.findMany.mockResolvedValueOnce([
      makeUser({ id: "u-1" }),
      makeUser({ id: "u-2" }),
    ] as any);

    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    const res = await request(app).get("/api/users").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true },
      }),
    );
  });

  it("?includeInactive=true devuelve también desactivados", async () => {
    prismaMock.user.findMany.mockResolvedValueOnce([] as any);

    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    await request(app)
      .get("/api/users?includeInactive=true")
      .set(auth(token));

    const call = prismaMock.user.findMany.mock.calls[0][0] as any;
    expect(call.where).toBeUndefined();
  });
});

describe("DELETE /api/users/:id — soft delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ADMIN desactiva (no borra) un usuario activo", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({ id: "u-1", isActive: true }) as any,
    );
    prismaMock.user.update.mockResolvedValueOnce(
      makeUser({ id: "u-1", isActive: false, deletedAt: new Date() }) as any,
    );

    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    const res = await request(app)
      .delete("/api/users/u-1")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u-1" },
        data: expect.objectContaining({
          isActive: false,
          deletedAt: expect.any(Date),
        }),
      }),
    );
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });

  it("rechaza desactivar la propia cuenta", async () => {
    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    const res = await request(app)
      .delete("/api/users/admin-1")
      .set(auth(token));
    expect(res.status).toBe(400);
  });

  it("rechaza si el usuario ya estaba inactivo", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({ id: "u-1", isActive: false }) as any,
    );

    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    const res = await request(app)
      .delete("/api/users/u-1")
      .set(auth(token));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("USER_ALREADY_INACTIVE");
  });

  it("USER no puede desactivar a nadie", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .delete("/api/users/u-1")
      .set(auth(token));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/users/:id/restore — reactivar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ADMIN reactiva un usuario inactivo", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({ id: "u-1", isActive: false }) as any,
    );
    prismaMock.user.update.mockResolvedValueOnce(
      makeUser({ id: "u-1", isActive: true, deletedAt: null }) as any,
    );

    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    const res = await request(app)
      .post("/api/users/u-1/restore")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isActive: true,
          deletedAt: null,
        }),
      }),
    );
  });

  it("rechaza si ya estaba activo", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(
      makeUser({ id: "u-1", isActive: true }) as any,
    );

    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    const res = await request(app)
      .post("/api/users/u-1/restore")
      .set(auth(token));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("USER_ALREADY_ACTIVE");
  });

  it("USER no puede reactivar", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/users/u-1/restore")
      .set(auth(token));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/users/agents — staff asignable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("incluye AGENT y ADMIN (no solo agentes)", async () => {
    prismaMock.user.findMany.mockResolvedValueOnce([
      { id: "agent-1", name: "Agente", email: "a@x.com", role: "AGENT" },
      { id: "admin-1", name: "Admin", email: "ad@x.com", role: "ADMIN" },
    ] as any);

    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    const res = await request(app).get("/api/users/agents").set(auth(token));

    expect(res.status).toBe(200);
    const call = prismaMock.user.findMany.mock.calls[0][0] as any;
    expect(call.where.role).toEqual({ in: ["AGENT", "ADMIN"] });
    expect(call.where.isActive).toBe(true);
    // El select ahora incluye role (lo usa el editor de proyectos).
    expect(call.select.role).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  it("requiere autenticación", async () => {
    const res = await request(app).get("/api/users/agents");
    expect(res.status).toBe(401);
  });
});

void makeAdmin;
