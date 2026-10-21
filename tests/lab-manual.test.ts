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
import {
  cenizasBaseSeca,
  humedadEstufa,
  normalizarDecimal,
  parametrosManual,
} from "../src/lib/labManual";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import { signAccessToken } from "./helpers";

// Análisis cargados a mano (termobalanza, estufa, colorímetro, PMG): quedan
// como una medición más con origen MANUAL, con quién la cargó, y solo esas se
// corrigen o dan de baja.

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const BASE = "/api/glutenlab";
const qc = signAccessToken({ role: "USER", id: "u-qc" });
const conNivel = (level: "VIEWER" | "QC" | "MANAGEMENT") =>
  prismaMock.moduleGrant.findFirst.mockResolvedValue({ level } as any);

beforeEach(() => vi.clearAllMocks());

// Renglón "000" de la hoja del 20/10 de la planilla del laboratorio (R.GCA
// Análisis Fisico-quimicos): humedad 15,30 % y ceniza básica 0,538 %.
const HUMEDAD_000 = { capsula: "I", vacia: "14,3716", muestra: "5,0006", final: "18,6071" };
const CENIZAS_000 = { capsula: "D", vacia: "34,3719", muestra: "5,0004", final: "34,3947" };

describe("cuentas de la planilla (labManual)", () => {
  it("normaliza lo tipeado sin perder los ceros del final", () => {
    expect(normalizarDecimal("14,30")).toBe("14.30");
    expect(normalizarDecimal(" 5,0000 ")).toBe("5.0000");
    expect(normalizarDecimal(",5")).toBe("0.5");
    expect(normalizarDecimal("-,46")).toBe("-0.46");
    expect(normalizarDecimal("14.")).toBe("14");
    expect(normalizarDecimal("+3")).toBe("3");
    expect(normalizarDecimal(14.3)).toBe("14.3");
    expect(normalizarDecimal("")).toBeNull();
    expect(normalizarDecimal(null)).toBeNull();
    expect(normalizarDecimal("1.234,5")).toBeUndefined();
    expect(normalizarDecimal("14,3 %")).toBeUndefined();
  });

  it("humedad en estufa y cenizas en base seca dan lo mismo que la planilla", () => {
    const n = (c: typeof HUMEDAD_000) => ({
      ...c,
      vacia: normalizarDecimal(c.vacia)!,
      muestra: normalizarDecimal(c.muestra)!,
      final: normalizarDecimal(c.final)!,
    });
    const humedad = humedadEstufa(n(HUMEDAD_000));
    expect(humedad).toBeCloseTo(15.3, 2);
    expect(cenizasBaseSeca(n(CENIZAS_000), humedad)).toBeCloseTo(0.538, 3);
    // Semita C4 del mismo día, con 3 g en la mufla: 13,79 % y 4,342 %.
    const semita = humedadEstufa({ vacia: "14.3191", muestra: "5.0004", final: "18.6301" });
    expect(semita).toBeCloseTo(13.79, 2);
    expect(cenizasBaseSeca({ vacia: "37.5312", muestra: "3.0002", final: "37.6435" }, semita)).toBeCloseTo(4.342, 3);
  });

  it("sin el peso final (o sin humedad) todavía no hay resultado", () => {
    expect(humedadEstufa({ capsula: "I", vacia: "14.3716", muestra: "5.0006" })).toBeNull();
    expect(cenizasBaseSeca({ vacia: "34.3719", muestra: "5.0004", final: "34.3947" }, null)).toBeNull();
    expect(
      parametrosManual({ v: 1, values: { "Color L": "89.52" }, humedad: { capsula: "I", vacia: "14.3716" } }),
    ).toEqual([{ code: "Color L", value: 89.52 }]);
  });

  it("las cenizas usan la humedad de la estufa; si no hubo estufa, la cargada en cenizas", () => {
    const conEstufa = parametrosManual({
      v: 1,
      values: {},
      humedad: { vacia: "14.3716", muestra: "5.0006", final: "18.6071" },
      cenizas: { vacia: "34.3719", muestra: "5.0004", final: "34.3947", humedad: "10" },
    });
    expect(conEstufa).toEqual([
      { code: "Humedad estufa", value: 15.3002 },
      { code: "Cenizas estufa", value: 0.5383 },
    ]);
    const sinEstufa = parametrosManual({
      v: 1,
      values: {},
      cenizas: { vacia: "34.3719", muestra: "5.0004", final: "34.3947", humedad: "15.30" },
    });
    expect(sinEstufa).toEqual([{ code: "Cenizas estufa", value: 0.5383 }]);
  });
});

describe("POST /samples/:id/manual", () => {
  it("QC carga un análisis manual: medición MANUAL enlazada, con unidades del catálogo y sin los valores vacíos", async () => {
    conNivel("QC");
    prismaMock.labSample.findFirst.mockResolvedValue({ id: "s1", accession: "M-0010-4" } as any);
    prismaMock.labMeasurement.create.mockResolvedValue({ id: "m1", source: "MANUAL", params: [] } as any);
    const res = await request(app)
      .post(`${BASE}/samples/s1/manual`)
      .set(auth(qc))
      .send({
        analyzedAt: "2026-09-28T13:00:00-03:00",
        values: { "Humedad termobalanza": 14.3, "Color L": 91.2, "Peso de mil granos": null },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe("m1");
    const data = prismaMock.labMeasurement.create.mock.calls[0][0].data as any;
    expect(data).toMatchObject({
      source: "MANUAL",
      sampleId: "s1",
      sampleRef: "M-0010-4",
      createdById: "u-qc",
      params: {
        create: [
          { code: "Humedad termobalanza", value: 14.3, unit: "%" },
          { code: "Color L", value: 91.2, unit: null },
        ],
      },
    });
    expect(typeof data.sourceId).toBe("string");
    expect(data.analyzedAt.toISOString()).toBe("2026-09-28T16:00:00.000Z");
  });

  it("rechaza un código desconocido, un valor fuera de rango y un cuerpo sin ningún valor", async () => {
    conNivel("QC");
    const casos = [
      { values: { "Humedad NIR": 14 } },
      { values: { "Color L": 150 } },
      { values: { "Color L": null, "Color a": null } },
    ];
    for (const body of casos) {
      const res = await request(app).post(`${BASE}/samples/s1/manual`).set(auth(qc)).send(body);
      expect(res.status).toBe(400);
    }
    expect(prismaMock.labMeasurement.create).not.toHaveBeenCalled();
  });

  it("guarda lo tipeado tal cual (cápsulas y decimales) y calcula humedad y cenizas como la planilla", async () => {
    conNivel("QC");
    prismaMock.labSample.findFirst.mockResolvedValue({ id: "s1", accession: "M-0010-4" } as any);
    prismaMock.labMeasurement.create.mockResolvedValue({ id: "m1", source: "MANUAL", params: [] } as any);
    const res = await request(app)
      .post(`${BASE}/samples/s1/manual`)
      .set(auth(qc))
      .send({
        values: { "Color L": "89,50", "Color a": "", "Humedad termobalanza": null },
        humedad: HUMEDAD_000,
        cenizas: { ...CENIZAS_000, humedad: "" },
      });
    expect(res.status).toBe(201);
    const data = prismaMock.labMeasurement.create.mock.calls[0][0].data as any;
    expect(data.manualInput).toEqual({
      v: 1,
      values: { "Color L": "89.50" },
      humedad: { capsula: "I", vacia: "14.3716", muestra: "5.0006", final: "18.6071" },
      cenizas: { capsula: "D", vacia: "34.3719", muestra: "5.0004", final: "34.3947" },
    });
    expect(data.params.create).toEqual([
      { code: "Color L", value: 89.5, unit: null },
      { code: "Humedad estufa", value: 15.3002, unit: "%" },
      { code: "Cenizas estufa", value: 0.5383, unit: "%" },
    ]);
  });

  it("se guarda a medio cargar: la cápsula y los pesos de la balanza, sin el final todavía", async () => {
    conNivel("QC");
    prismaMock.labSample.findFirst.mockResolvedValue({ id: "s1", accession: "M-0010-4" } as any);
    prismaMock.labMeasurement.create.mockResolvedValue({ id: "m1", source: "MANUAL", params: [] } as any);
    const res = await request(app)
      .post(`${BASE}/samples/s1/manual`)
      .set(auth(qc))
      .send({ cenizas: { capsula: "101", vacia: "35,9626", muestra: "5,0010", final: "" } });
    expect(res.status).toBe(201);
    const data = prismaMock.labMeasurement.create.mock.calls[0][0].data as any;
    expect(data.manualInput).toEqual({
      v: 1,
      values: {},
      cenizas: { capsula: "101", vacia: "35.9626", muestra: "5.0010" },
    });
    expect(data.params.create).toEqual([]);
  });

  it("rechaza pesos que dan una humedad imposible, y un peso que no es número, en su campo", async () => {
    conNivel("QC");
    const imposible = await request(app)
      .post(`${BASE}/samples/s1/manual`)
      .set(auth(qc))
      .send({ humedad: { vacia: "14,3716", muestra: "5,0006", final: "28,6071" } });
    expect(imposible.status).toBe(400);
    expect(imposible.body.error.details).toEqual([
      { field: "body.humedad.final", message: "La humedad da -184,68 %: revisá los pesos" },
    ]);
    const texto = await request(app)
      .post(`${BASE}/samples/s1/manual`)
      .set(auth(qc))
      .send({ cenizas: { capsula: "D", vacia: "34,37g" } });
    expect(texto.status).toBe(400);
    expect(texto.body.error.details[0].field).toBe("body.cenizas.vacia");
    expect(prismaMock.labMeasurement.create).not.toHaveBeenCalled();
  });

  it("si la muestra ya tiene un análisis manual no crea otro: 409 con el id para abrirlo", async () => {
    conNivel("QC");
    prismaMock.labSample.findFirst.mockResolvedValue({ id: "s1", accession: "M-0010-4" } as any);
    prismaMock.labMeasurement.findFirst.mockResolvedValue({ id: "m-viejo" } as any);
    const res = await request(app)
      .post(`${BASE}/samples/s1/manual`)
      .set(auth(qc))
      .send({ values: { "Color L": "90" } });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ id: "m-viejo" });
    expect(prismaMock.labMeasurement.findFirst.mock.calls[0][0]?.where).toEqual({
      sampleId: "s1",
      source: "MANUAL",
      deletedAt: null,
    });
    expect(prismaMock.labMeasurement.create).not.toHaveBeenCalled();
  });

  it("un VIEWER no carga (403) y una muestra inexistente es 404", async () => {
    conNivel("VIEWER");
    const denegado = await request(app)
      .post(`${BASE}/samples/s1/manual`)
      .set(auth(qc))
      .send({ values: { "Color L": 90 } });
    expect(denegado.status).toBe(403);

    conNivel("QC");
    prismaMock.labSample.findFirst.mockResolvedValue(null);
    const faltante = await request(app)
      .post(`${BASE}/samples/nope/manual`)
      .set(auth(qc))
      .send({ values: { "Color L": 90 } });
    expect(faltante.status).toBe(404);
  });
});

describe("PATCH y DELETE /measurements/manual/:id", () => {
  it("reemplaza los valores de un análisis manual", async () => {
    conNivel("QC");
    prismaMock.labMeasurement.findFirst.mockResolvedValue({ id: "m1", source: "MANUAL" } as any);
    prismaMock.$transaction.mockResolvedValue([{ count: 2 }, { id: "m1", source: "MANUAL", params: [] }] as any);
    const res = await request(app)
      .patch(`${BASE}/measurements/manual/m1`)
      .set(auth(qc))
      .send({ values: { "Cenizas estufa": 0.62 } });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("m1");
    expect(prismaMock.labParameter.deleteMany).toHaveBeenCalledWith({ where: { measurementId: "m1" } });
    expect(prismaMock.labMeasurement.update.mock.calls[0][0]).toMatchObject({
      where: { id: "m1" },
      data: { params: { create: [{ code: "Cenizas estufa", value: 0.62, unit: "%" }] } },
    });
  });

  it("al completar el peso final, la cuenta reemplaza a un resultado tipeado con el formulario anterior", async () => {
    conNivel("QC");
    prismaMock.labMeasurement.findFirst.mockResolvedValue({ id: "m1", source: "MANUAL" } as any);
    prismaMock.$transaction.mockResolvedValue([{ count: 1 }, { id: "m1", source: "MANUAL", params: [] }] as any);
    const res = await request(app)
      .patch(`${BASE}/measurements/manual/m1`)
      .set(auth(qc))
      .send({
        values: { "Cenizas estufa": "0,669", "Cenizas cápsula": "101" },
        cenizas: { ...CENIZAS_000, humedad: "15,30" },
      });
    expect(res.status).toBe(200);
    const data = prismaMock.labMeasurement.update.mock.calls[0][0].data as any;
    expect(data.manualInput).toEqual({
      v: 1,
      values: { "Cenizas cápsula": "101" },
      cenizas: { capsula: "D", vacia: "34.3719", muestra: "5.0004", final: "34.3947", humedad: "15.30" },
    });
    expect(data.params.create).toEqual([
      { code: "Cenizas cápsula", value: 101, unit: null },
      { code: "Cenizas estufa", value: 0.5383, unit: "%" },
    ]);
  });

  it("una medición de un equipo no se edita ni se borra por acá", async () => {
    conNivel("QC");
    prismaMock.labMeasurement.findFirst.mockResolvedValue({ id: "m2", source: "NIR" } as any);
    const edicion = await request(app)
      .patch(`${BASE}/measurements/manual/m2`)
      .set(auth(qc))
      .send({ values: { "Color L": 90 } });
    expect(edicion.status).toBe(400);
    const baja = await request(app).delete(`${BASE}/measurements/manual/m2`).set(auth(qc));
    expect(baja.status).toBe(400);
    expect(prismaMock.labMeasurement.update).not.toHaveBeenCalled();
  });

  it("la baja es lógica: queda con deletedAt", async () => {
    conNivel("QC");
    prismaMock.labMeasurement.findFirst.mockResolvedValue({ id: "m1", source: "MANUAL" } as any);
    prismaMock.labMeasurement.update.mockResolvedValue({} as any);
    const res = await request(app).delete(`${BASE}/measurements/manual/m1`).set(auth(qc));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: "m1" });
    const llamada = prismaMock.labMeasurement.update.mock.calls[0][0] as any;
    expect(llamada.where).toEqual({ id: "m1" });
    expect(llamada.data.deletedAt).toBeInstanceOf(Date);
  });
});
