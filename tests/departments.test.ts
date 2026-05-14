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
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const makeDept = (overrides: Partial<any> = {}) => ({
  id: "d-1",
  name: "Logística",
  slug: "logistica",
  color: "#3B82F6",
  icon: "📦",
  createdAt: new Date(),
  updatedAt: new Date(),
  _count: { users: 3 },
  ...overrides,
});

describe("GET /api/departments — listar sectores", () => {
  beforeEach(() => vi.clearAllMocks());

  it("USER puede leer la lista (necesaria para selects/badges)", async () => {
    prismaMock.department.findMany.mockResolvedValueOnce([
      makeDept(),
    ] as any);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app).get("/api/departments").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("Logística");
  });

  it("Requiere autenticación", async () => {
    const res = await request(app).get("/api/departments");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/departments — crear sector", () => {
  beforeEach(() => vi.clearAllMocks());

  it("USER no puede crear", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/departments")
      .set(auth(token))
      .send({ name: "Comercial" });
    expect(res.status).toBe(403);
  });

  it("AGENT tampoco", async () => {
    const token = signAccessToken({ role: "AGENT" });
    const res = await request(app)
      .post("/api/departments")
      .set(auth(token))
      .send({ name: "Comercial" });
    expect(res.status).toBe(403);
  });

  it("ADMIN crea con name + color + icon", async () => {
    prismaMock.department.findUnique.mockResolvedValueOnce(null);
    prismaMock.department.findFirst.mockResolvedValueOnce(null);
    prismaMock.department.create.mockResolvedValueOnce(makeDept() as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .post("/api/departments")
      .set(auth(token))
      .send({ name: "Logística", color: "#3B82F6", icon: "📦" });

    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe("logistica");
  });

  it("Rechaza nombre duplicado (case-insensitive)", async () => {
    prismaMock.department.findUnique.mockResolvedValueOnce(null);
    prismaMock.department.findFirst.mockResolvedValueOnce({
      id: "d-1",
    } as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .post("/api/departments")
      .set(auth(token))
      .send({ name: "LOGÍSTICA" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DEPARTMENT_DUPLICATE");
  });

  it("Rechaza color hex inválido", async () => {
    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .post("/api/departments")
      .set(auth(token))
      .send({ name: "Comercial", color: "no-hex" });

    expect(res.status).toBe(400);
  });

  it("Acepta name sin color ni icon", async () => {
    prismaMock.department.findUnique.mockResolvedValueOnce(null);
    prismaMock.department.findFirst.mockResolvedValueOnce(null);
    prismaMock.department.create.mockResolvedValueOnce(
      makeDept({ color: null, icon: null }) as any,
    );

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .post("/api/departments")
      .set(auth(token))
      .send({ name: "Otro" });

    expect(res.status).toBe(201);
  });
});

describe("PATCH /api/departments/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ADMIN puede actualizar nombre y regenera slug", async () => {
    const existing = makeDept();
    prismaMock.department.findUnique
      .mockResolvedValueOnce(existing as any) // primero, existe
      .mockResolvedValueOnce(null); // unique slug check
    prismaMock.department.findFirst.mockResolvedValueOnce(null); // no duplicate
    prismaMock.department.update.mockResolvedValueOnce({
      ...existing,
      name: "Logística y Distribución",
      slug: "logistica-y-distribucion",
    } as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .patch("/api/departments/d-1")
      .set(auth(token))
      .send({ name: "Logística y Distribución" });

    expect(res.status).toBe(200);
    expect(res.body.data.slug).toBe("logistica-y-distribucion");
  });

  it("USER no puede actualizar", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .patch("/api/departments/d-1")
      .set(auth(token))
      .send({ name: "X" });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/departments/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ADMIN elimina sector existente", async () => {
    prismaMock.department.findUnique.mockResolvedValueOnce(makeDept() as any);
    prismaMock.department.delete.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .delete("/api/departments/d-1")
      .set(auth(token));

    expect(res.status).toBe(200);
  });

  it("404 si no existe", async () => {
    prismaMock.department.findUnique.mockResolvedValueOnce(null);
    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .delete("/api/departments/missing")
      .set(auth(token));
    expect(res.status).toBe(404);
  });

  it("USER no puede eliminar", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .delete("/api/departments/d-1")
      .set(auth(token));
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/users/:id — asignar departmentId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ADMIN puede asignar sector a un user", async () => {
    prismaMock.department.findUnique.mockResolvedValueOnce({
      id: "cmhdept0000000000000000aa",
    } as any);
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "u-1",
      email: "x@x.com",
    } as any);
    prismaMock.user.update.mockResolvedValueOnce({
      id: "u-1",
      name: "Juan",
      email: "x@x.com",
      role: "USER",
      department: {
        id: "cmhdept0000000000000000aa",
        name: "Logística",
        color: null,
        icon: null,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .patch("/api/users/u-1")
      .set(auth(token))
      .send({ departmentId: "cmhdept0000000000000000aa" });

    expect(res.status).toBe(200);
    expect(res.body.data.department.name).toBe("Logística");
  });

  it("USER no puede cambiar su propio sector", async () => {
    const token = signAccessToken({ id: "u-1", role: "USER" });
    const res = await request(app)
      .patch("/api/users/u-1")
      .set(auth(token))
      .send({ departmentId: "cmhdept0000000000000000aa" });

    expect(res.status).toBe(403);
  });

  it("ADMIN puede quitar sector (departmentId: null)", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "u-1",
      email: "x@x.com",
    } as any);
    prismaMock.user.update.mockResolvedValueOnce({
      id: "u-1",
      name: "Juan",
      email: "x@x.com",
      role: "USER",
      department: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .patch("/api/users/u-1")
      .set(auth(token))
      .send({ departmentId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.department).toBeNull();
  });

  it("404 si el departmentId no existe", async () => {
    prismaMock.department.findUnique.mockResolvedValueOnce(null);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .patch("/api/users/u-1")
      .set(auth(token))
      .send({ departmentId: "cmhfake000000000000000000" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("DEPARTMENT_NOT_FOUND");
  });
});
