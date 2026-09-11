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
import { ANALYSIS_COLUMNS } from "../src/lib/labAnalysisColumns";

// La grilla de consulta por HTTP: la puerta del módulo, el tope de filas con su
// aviso de truncado, y el pivote de los análisis a un valor por columna.

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const URL = "/api/glutenlab/samples/grid";

const ahora = new Date();
const muestra = (id: string, seq: number) => ({
  id,
  accession: `A-${String(seq).padStart(4, "0")}-0`,
  site: "ACOPIO",
  seq,
  kindId: "lsk_recepcion",
  sampledAt: ahora,
  displayName: `Acopio · Empresa ${seq}`,
  fields: { empresa: `Empresa ${seq}`, patente: "AB123CD" },
  notes: null,
  createdById: "u",
  deletedAt: null,
  createdAt: ahora,
  updatedAt: ahora,
  kind: { id: "lsk_recepcion", code: "RECEPCION", name: "Recepción de grano" },
  createdBy: { id: "u", name: "Operario" },
});

const viewer = signAccessToken({ role: "USER", id: "u-com" });
const conNivel = (level: "VIEWER" | "QC" | "MANAGEMENT") =>
  prismaMock.moduleGrant.findFirst.mockResolvedValue({ level } as any);

describe("GET /api/glutenlab/samples/grid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.labSampleFieldDef.findMany.mockResolvedValue([]);
  });

  it("sin acceso al módulo es 403", async () => {
    prismaMock.moduleGrant.findFirst.mockResolvedValue(null);
    const res = await request(app).get(URL).set(auth(viewer));
    expect(res.status).toBe(403);
    expect(prismaMock.labSample.findMany).not.toHaveBeenCalled();
  });

  it("un VIEWER consulta: pivotea los análisis a un valor por columna y marca lo dudoso", async () => {
    conNivel("VIEWER");
    prismaMock.labSample.findMany.mockResolvedValue([muestra("s1", 1), muestra("s2", 2)] as any);
    prismaMock.labSample.count.mockResolvedValue(2);
    prismaMock.labMeasurement.findMany.mockResolvedValue([
      {
        sampleId: "s1",
        source: "NIR",
        params: [
          { code: "Proteína DryBasis", value: 12.0, isImplausible: false, unit: "%" },
          { code: "Humedad AsIs", value: 13.1, isImplausible: false, unit: "%" },
        ],
      },
      {
        sampleId: "s1",
        source: "NIR",
        params: [{ code: "Proteína DryBasis", value: 12.4, isImplausible: false, unit: "%" }],
      },
      {
        sampleId: "s1",
        source: "FN",
        params: [{ code: "Falling Number", value: 60, isImplausible: true, unit: "s" }],
      },
      {
        sampleId: "s2",
        source: "SDMATIC",
        params: [{ code: "Parámetro nuevo", value: 7.5, isImplausible: false, unit: "u" }],
      },
    ] as any);

    const res = await request(app).get(URL).query({ from: "2026-09-01", to: "2026-09-11" }).set(auth(viewer));

    expect(res.status).toBe(200);
    const { items, total, truncated, limit, columns } = res.body.data;
    expect(total).toBe(2);
    expect(truncated).toBe(false);
    expect(limit).toBe(500);
    expect(items).toHaveLength(2);

    const s1 = items[0];
    expect(s1.accession).toBe("A-0001-0");
    expect(s1.fields).toEqual({ empresa: "Empresa 1", patente: "AB123CD" });
    expect(s1.values["NIR|Proteína DryBasis"]).toBe(12.2);
    expect(s1.values["NIR|Humedad AsIs"]).toBe(13.1);
    expect(s1.values["FN|Falling Number"]).toBe(60);
    expect(s1.implausible).toEqual(["FN|Falling Number"]);
    expect(s1.analyses).toEqual({ NIR: 2, FN: 1 });
    expect(s1.conditions).toEqual([]);

    // El catálogo entero primero; el código desconocido al final, con su unidad.
    expect(columns.slice(0, ANALYSIS_COLUMNS.length).map((c: any) => c.key)).toEqual(
      ANALYSIS_COLUMNS.map((c) => c.key),
    );
    expect(columns[columns.length - 1]).toMatchObject({
      key: "SDMATIC|Parámetro nuevo",
      label: "Parámetro nuevo",
      unit: "u",
    });

    // Pide una fila más que el tope para detectar truncado, y solo mediciones de las muestras traídas.
    expect(prismaMock.labSample.findMany.mock.calls[0][0]).toMatchObject({ take: 501 });
    expect(prismaMock.labMeasurement.findMany.mock.calls[0][0]).toMatchObject({
      where: { sampleId: { in: ["s1", "s2"] }, deletedAt: null },
    });
  });

  it("con más muestras que el tope, recorta y avisa truncado", async () => {
    conNivel("VIEWER");
    prismaMock.labSample.findMany.mockResolvedValue([muestra("s1", 1), muestra("s2", 2)] as any);
    prismaMock.labSample.count.mockResolvedValue(40);
    prismaMock.labMeasurement.findMany.mockResolvedValue([]);

    const res = await request(app).get(URL).query({ limit: 1 }).set(auth(viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.truncated).toBe(true);
    expect(res.body.data.total).toBe(40);
    expect(res.body.data.limit).toBe(1);
    expect(prismaMock.labSample.findMany.mock.calls[0][0]).toMatchObject({ take: 2 });
    // Las mediciones se piden solo para la fila que quedó.
    expect(prismaMock.labMeasurement.findMany.mock.calls[0][0]).toMatchObject({
      where: { sampleId: { in: ["s1"] } },
    });
  });

  it("el tope pedido se acota al máximo del servidor", async () => {
    conNivel("VIEWER");
    prismaMock.labSample.findMany.mockResolvedValue([]);
    prismaMock.labSample.count.mockResolvedValue(0);

    const res = await request(app).get(URL).query({ limit: 999999 }).set(auth(viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(1000);
    expect(res.body.data.items).toEqual([]);
    expect(prismaMock.labMeasurement.findMany).not.toHaveBeenCalled();
  });

  it("una accesión con dígito verificador incorrecto busca igual y avisa", async () => {
    conNivel("VIEWER");
    prismaMock.labSample.findMany.mockResolvedValue([]);
    prismaMock.labSample.count.mockResolvedValue(0);

    const res = await request(app).get(URL).query({ q: "M-0012-9" }).set(auth(viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.warning).toMatch(/dígito verificador/);
  });
});
