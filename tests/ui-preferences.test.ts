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

// Preferencias de interfaz del propio usuario: lectura con defaults, guardado de
// una vista sin pisar las demás, y vuelta a la vista sugerida.

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const BASE = "/api/me/ui-preferences";

const usuario = signAccessToken({ role: "USER", id: "u-1" });
const config = {
  columns: ["accession", "sampledAt", "f:empresa", "a:NIR|Proteína DryBasis"],
  sort: [{ id: "sampledAt", desc: true }],
};

describe("GET /api/me/ui-preferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sin token es 401", async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
  });

  it("sin fila devuelve los defaults y no crea nada", async () => {
    prismaMock.userUiPreference.findUnique.mockResolvedValue(null);

    const res = await request(app).get(BASE).set(auth(usuario));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ theme: "quiet-pro", darkMode: null, savedViews: {} });
    expect(prismaMock.userUiPreference.findUnique.mock.calls[0][0]).toMatchObject({
      where: { userId: "u-1" },
    });
    expect(prismaMock.userUiPreference.upsert).not.toHaveBeenCalled();
  });

  it("con fila devuelve lo guardado", async () => {
    prismaMock.userUiPreference.findUnique.mockResolvedValue({
      theme: "workshop",
      darkMode: true,
      savedViews: { "lab.analysis-grid": config },
    } as any);

    const res = await request(app).get(BASE).set(auth(usuario));

    expect(res.body.data).toEqual({
      theme: "workshop",
      darkMode: true,
      savedViews: { "lab.analysis-grid": config },
    });
  });
});

describe("PUT /api/me/ui-preferences/views/:viewKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("guarda la vista sin pisar las otras claves guardadas", async () => {
    prismaMock.userUiPreference.findUnique.mockResolvedValue({
      savedViews: { "otra.vista": { columns: ["x"] } },
    } as any);
    prismaMock.userUiPreference.upsert.mockResolvedValue({} as any);

    const res = await request(app)
      .put(`${BASE}/views/lab.analysis-grid`)
      .set(auth(usuario))
      .send({ config });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ viewKey: "lab.analysis-grid", config });
    const args = prismaMock.userUiPreference.upsert.mock.calls[0][0] as any;
    expect(args.where).toEqual({ userId: "u-1" });
    expect(args.create.savedViews).toEqual({
      "otra.vista": { columns: ["x"] },
      "lab.analysis-grid": config,
    });
    expect(args.update.savedViews).toEqual(args.create.savedViews);
  });

  it("rechaza una configuración con claves desconocidas o sin columnas (400)", async () => {
    const sinColumnas = await request(app)
      .put(`${BASE}/views/lab.analysis-grid`)
      .set(auth(usuario))
      .send({ config: { columns: [] } });
    expect(sinColumnas.status).toBe(400);

    const conBasura = await request(app)
      .put(`${BASE}/views/lab.analysis-grid`)
      .set(auth(usuario))
      .send({ config: { columns: ["a"], blob: "x".repeat(10) } });
    expect(conBasura.status).toBe(400);
    expect(prismaMock.userUiPreference.upsert).not.toHaveBeenCalled();
  });

  it("rechaza una clave de vista inválida (400)", async () => {
    const res = await request(app)
      .put(`${BASE}/views/Lab Grid!`)
      .set(auth(usuario))
      .send({ config });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/me/ui-preferences/views/:viewKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("borra solo la clave pedida", async () => {
    prismaMock.userUiPreference.findUnique.mockResolvedValue({
      savedViews: { "lab.analysis-grid": config, "otra.vista": { columns: ["x"] } },
    } as any);
    prismaMock.userUiPreference.update.mockResolvedValue({} as any);

    const res = await request(app).delete(`${BASE}/views/lab.analysis-grid`).set(auth(usuario));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ viewKey: "lab.analysis-grid", deleted: true });
    expect(prismaMock.userUiPreference.update.mock.calls[0][0]).toMatchObject({
      where: { userId: "u-1" },
      data: { savedViews: { "otra.vista": { columns: ["x"] } } },
    });
  });

  it("si no había nada guardado para esa vista, no escribe", async () => {
    prismaMock.userUiPreference.findUnique.mockResolvedValue(null);

    const res = await request(app).delete(`${BASE}/views/lab.analysis-grid`).set(auth(usuario));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ viewKey: "lab.analysis-grid", deleted: false });
    expect(prismaMock.userUiPreference.update).not.toHaveBeenCalled();
  });
});
