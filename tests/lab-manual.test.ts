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
