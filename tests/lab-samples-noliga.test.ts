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

// "No liga": el Glutomatic no formó gluten y el operario guardó la prueba con
// todo en 0. Es un dato de calidad que hasta ahora se anotaba a mano en notas;
// acá se prueba que la lista, la grilla y la ficha lo señalan, y que una muestra
// sin Glutomatic NO se marca (todavía no tiene ese análisis, no es lo mismo).
// También las sugerencias de valores ya cargados para un campo.

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const BASE = "/api/glutenlab/samples";
const viewer = signAccessToken({ role: "USER", id: "u-v" });
const conModulo = () => prismaMock.moduleGrant.findFirst.mockResolvedValue({ level: "VIEWER" } as any);

const ahora = new Date();
const muestra = (id: string, seq: number) => ({
  id,
  accession: `A-${String(seq).padStart(4, "0")}-0`,
  site: "ACOPIO",
  seq,
  kindId: "lsk_recepcion",
  sampledAt: ahora,
  displayName: `Acopio · ${seq}`,
  fields: {},
  notes: null,
  createdById: "u",
  deletedAt: null,
  createdAt: ahora,
  updatedAt: ahora,
  kind: { id: "lsk_recepcion", code: "RECEPCION", name: "Recepción de grano" },
  createdBy: { id: "u", name: "Operario" },
});

/** Mediciones Glutomatic tal como las devuelve la consulta de "no liga" (solo el parámetro gluten húmedo). */
const glutomatic = [
  { sampleId: "s-liga", params: [{ value: 24.5 }] },
  { sampleId: "s-noliga", params: [{ value: 0 }] },
  // Dos pruebas: una en 0 y otra que sí ligó → liga.
  { sampleId: "s-repetida", params: [{ value: 0 }] },
  { sampleId: "s-repetida", params: [{ value: 22.1 }] },
  // Guardada sin parámetros: tampoco ligó.
  { sampleId: "s-vacia", params: [] },
];

describe("GET /samples — no liga", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conModulo();
    prismaMock.labSampleFieldDef.findMany.mockResolvedValue([]);
    prismaMock.labMeasurement.groupBy.mockResolvedValue([] as any);
    prismaMock.labMeasurement.findMany.mockResolvedValue(glutomatic as any);
  });

  it("marca no liga solo a las muestras cuyo Glutomatic quedó en 0 (o vacío) y no ligó en ninguna prueba", async () => {
    prismaMock.labSample.findMany.mockResolvedValue([
      muestra("s-liga", 1),
      muestra("s-noliga", 2),
      muestra("s-repetida", 3),
      muestra("s-vacia", 4),
      muestra("s-sin-glutomatic", 5),
    ] as any);
    prismaMock.labSample.count.mockResolvedValue(5);

    const res = await request(app).get(BASE).set(auth(viewer));

    expect(res.status).toBe(200);
    const porId = Object.fromEntries(res.body.data.items.map((s: any) => [s.id, s.noLiga]));
    expect(porId).toEqual({
      "s-liga": false,
      "s-noliga": true,
      "s-repetida": false,
      "s-vacia": true,
      "s-sin-glutomatic": false,
    });
    // Solo mira Glutomatic de las muestras de la página, y solo el parámetro que decide.
    expect(prismaMock.labMeasurement.findMany.mock.calls[0][0]).toMatchObject({
      where: { source: "GLUTOMATIC", deletedAt: null, sampleId: { in: ["s-liga", "s-noliga", "s-repetida", "s-vacia", "s-sin-glutomatic"] } },
      select: { params: { where: { code: "Gluten húmedo" } } },
    });
  });

  it("la grilla lleva la misma marca", async () => {
    prismaMock.labSample.findMany.mockResolvedValue([muestra("s-noliga", 2), muestra("s-liga", 1)] as any);
    prismaMock.labSample.count.mockResolvedValue(2);

    const res = await request(app).get(`${BASE}/grid`).set(auth(viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((s: any) => [s.id, s.noLiga])).toEqual([
      ["s-noliga", true],
      ["s-liga", false],
    ]);
  });

  it("la ficha también", async () => {
    prismaMock.labSample.findFirst.mockResolvedValue(muestra("s-noliga", 2) as any);
    prismaMock.labInstrument.findMany.mockResolvedValue([]);

    const res = await request(app).get(`${BASE}/A-0002-4`).set(auth(viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.noLiga).toBe(true);
  });
});

describe("GET /samples/suggest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conModulo();
  });

  it("devuelve los valores ya cargados del campo, filtrando por tipo si se pide", async () => {
    // "empresa" además consulta la lista del ERP; acá vacía, para probar solo el historial.
    prismaMock.labProductor.findMany.mockResolvedValue([] as any);
    prismaMock.$queryRaw.mockResolvedValue([
      { valor: "VIETTO", n: 43n },
      { valor: "ORESTE FERNANDEZ", n: 31n },
    ] as any);

    const res = await request(app).get(`${BASE}/suggest`).query({ key: "empresa", kindId: "lsk_recepcion" }).set(auth(viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.values).toEqual(["VIETTO", "ORESTE FERNANDEZ"]);
    expect(res.body.data.items).toEqual([{ value: "VIETTO" }, { value: "ORESTE FERNANDEZ" }]);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("una clave que no es un campo válido no consulta nada", async () => {
    const res = await request(app).get(`${BASE}/suggest`).query({ key: "fields->>'x'; drop" }).set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ values: [] });
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("sin acceso al módulo es 403", async () => {
    prismaMock.moduleGrant.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`${BASE}/suggest`).query({ key: "empresa" }).set(auth(viewer));
    expect(res.status).toBe(403);
  });
});
