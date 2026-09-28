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
import LabReportService, { COLUMNAS, PRODUCTOS, TURNOS } from "../src/services/lab.report.service";

// El reporte diario en el formato de la planilla M.M.LC.P.02: un renglón por
// muestra interna registrada, la grilla fija de 15 productos por turno con sus
// huecos, y al final de cada turno lo que se midió sin registrar la muestra.

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const viewer = signAccessToken({ role: "USER", id: "u-v" });
const conModulo = () => prismaMock.moduleGrant.findFirst.mockResolvedValue({ level: "VIEWER" } as any);

const param = (code: string, value: number, unit: string | null = null, isImplausible = false) => ({
  code,
  value,
  unit,
  isImplausible,
});

const muestra = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  accession: "M-0010-4",
  sampledAt: new Date("2026-09-28T21:50:00-03:00"),
  displayName: "Molino · 3/0",
  fields: { turno: "3° Tarde (15:00–21:00)", producto: "3/0" },
  measurements: [
    { source: "NIR", params: [param("Humedad AsIs", 14.2, "%"), param("Proteína DryBasis", 11.3, "%")] },
    { source: "GLUTOMATIC", params: [param("Gluten húmedo", 0, "%"), param("Índice de gluten", 0)] },
    { source: "MANUAL", params: [param("Color L", 91.3), param("Humedad termobalanza", 14.5, "%")] },
  ],
  ...over,
});

const filasDe = (turno: string, rows: any[]) => rows.filter((r) => r.turno === turno);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.labSample.findMany.mockResolvedValue([] as any);
  prismaMock.labMeasurement.findMany.mockResolvedValue([] as any);
});

describe("LabReportService.diario", () => {
  it("el día va de 22:00 a 22:00 de planta y la grilla vacía tiene los 15 productos por turno", async () => {
    const r = await LabReportService.diario("2026-09-28");
    expect(r.from.toISOString()).toBe("2026-09-28T01:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-09-29T01:00:00.000Z");
    expect(r.rows).toHaveLength(45);
    expect(r.rows.map((x) => x.producto).slice(0, 15)).toEqual([...PRODUCTOS]);
    expect(r.rows.every((x) => x.sample === null && x.measurements === 0 && !x.sinMuestra)).toBe(true);
    expect(r.totalSamples).toBe(0);
    // Solo muestras internas de ese día, con sus análisis vivos.
    expect(prismaMock.labSample.findMany.mock.calls[0][0]).toMatchObject({
      where: { deletedAt: null, kind: { code: "INTERNA" }, sampledAt: { gte: r.from, lt: r.to } },
    });
    // Y las mediciones sueltas del mismo rango.
    expect(prismaMock.labMeasurement.findMany.mock.calls[0][0]).toMatchObject({
      where: { deletedAt: null, sampleId: null, analyzedAt: { gte: r.from, lt: r.to } },
    });
  });

  it("una muestra registrada ocupa su lugar en la planilla con hora, valores por clave y no liga", async () => {
    prismaMock.labSample.findMany.mockResolvedValue([muestra()] as any);
    const r = await LabReportService.diario("2026-09-28");
    const tarde = filasDe(TURNOS[2], r.rows);
    // El turno lo dice la ficha (tarde), aunque las 21:50 ya sean casi noche; ocupa la 5.ª fila.
    expect(tarde[4]).toMatchObject({
      producto: "3/0",
      hora: "21:50",
      lote: null,
      sinMuestra: false,
      measurements: 3,
      noLiga: true,
      sample: { accession: "M-0010-4" },
      values: {
        "NIR|Humedad AsIs": 14.2,
        "NIR|Proteína DryBasis": 11.3,
        "GLUTOMATIC|Gluten húmedo": 0,
        "MANUAL|Color L": 91.3,
        "MANUAL|Humedad termobalanza": 14.5,
      },
    });
    expect(r.rows).toHaveLength(45);
    expect(r.totalSamples).toBe(1);
    expect(r.totalMeasurements).toBe(3);
  });

  it("dos muestras del mismo producto son dos renglones, no un promedio", async () => {
    prismaMock.labSample.findMany.mockResolvedValue([
      muestra({ id: "a", accession: "M-0010-4", sampledAt: new Date("2026-09-28T13:05:00-03:00") }),
      muestra({
        id: "b",
        accession: "M-0011-2",
        sampledAt: new Date("2026-09-28T21:40:00-03:00"),
        measurements: [{ source: "NIR", params: [param("Humedad AsIs", 15.0, "%")] }],
      }),
    ] as any);
    const r = await LabReportService.diario("2026-09-28");
    const tarde = filasDe(TURNOS[2], r.rows);
    expect(tarde).toHaveLength(16);
    expect(tarde[4]).toMatchObject({ producto: "3/0", hora: "13:05", values: { "NIR|Humedad AsIs": 14.2 } });
    expect(tarde[5]).toMatchObject({ producto: "3/0", hora: "21:40", values: { "NIR|Humedad AsIs": 15.0 } });
    expect(tarde[6].producto).toBe("4/0");
  });

  it("sin turno en la ficha lo decide la hora; lote, silo o acoplado van en la columna Lote; lo que no está en la planilla va después", async () => {
    prismaMock.labSample.findMany.mockResolvedValue([
      muestra({
        id: "a",
        accession: "M-0012-0",
        sampledAt: new Date("2026-09-28T09:10:00-03:00"),
        fields: { producto: "3/0 Embolse", lote: "123A" },
        measurements: [],
      }),
      muestra({
        id: "b",
        accession: "M-0013-9",
        sampledAt: new Date("2026-09-28T02:30:00-03:00"),
        fields: { producto: "Trigo Sucio", origen_trigo: "Silo", silo: "7" },
        measurements: [],
      }),
      muestra({
        id: "c",
        accession: "M-0014-7",
        sampledAt: new Date("2026-09-28T09:20:00-03:00"),
        fields: { turno: "2° Mañana (07:00–14:00)", producto: "Prueba" },
        measurements: [],
      }),
    ] as any);
    const r = await LabReportService.diario("2026-09-28");
    const manana = filasDe(TURNOS[1], r.rows);
    expect(manana).toHaveLength(16);
    expect(manana[12]).toMatchObject({ producto: "3/0 Embolse", lote: "123A", hora: "09:10" });
    expect(manana[15]).toMatchObject({ producto: "Prueba", orden: 150, sample: { accession: "M-0014-7" } });
    const noche = filasDe(TURNOS[0], r.rows);
    expect(noche[0]).toMatchObject({ producto: "Trigo Sucio", lote: "Silo 7", hora: "02:30" });
  });

  it("las mediciones sin muestra registrada van al final del turno, con el producto que dice el equipo", async () => {
    prismaMock.labMeasurement.findMany.mockResolvedValue([
      {
        source: "NIR",
        analyzedAt: new Date("2026-09-28T13:05:00-03:00"),
        productCode: "Harina 000",
        sampleRef: "prueba tarde",
        params: [param("Humedad AsIs", 13.9, "%")],
      },
      {
        source: "NIR",
        analyzedAt: new Date("2026-09-28T13:40:00-03:00"),
        productCode: "Harina 000",
        sampleRef: null,
        params: [param("Humedad AsIs", 14.1, "%")],
      },
    ] as any);
    const r = await LabReportService.diario("2026-09-28");
    const manana = filasDe(TURNOS[1], r.rows);
    expect(manana).toHaveLength(16);
    expect(manana[15]).toMatchObject({
      producto: "3/0",
      sinMuestra: true,
      sample: null,
      hora: "13:05",
      measurements: 2,
      orden: 204,
      values: { "NIR|Humedad AsIs": 14 },
    });
    expect(r.totalMeasurements).toBe(2);
  });

  it("las columnas siguen la planilla: grupos, secciones y cuáles se cargan a mano", () => {
    expect(COLUMNAS.map((c) => c.group).filter((g, i, a) => a.indexOf(g) === i)).toEqual([
      "% Humedad",
      "% Cenizas",
      "% Proteínas",
      "PH",
      "Colorímetro",
      "PMG",
      "Falling Number",
      "Gluten",
      "Almidón",
      "Alveogramas",
    ]);
    expect(COLUMNAS.filter((c) => c.manual).map((c) => c.code)).toEqual([
      "Humedad termobalanza",
      "Cenizas cápsula",
      "Cenizas estufa",
      "Cenizas cápsula ensayo",
      "Color L",
      "Color a",
      "Color b",
      "Peso de mil granos",
    ]);
    expect(COLUMNAS.filter((c) => c.section === "reo").map((c) => c.label)).toEqual(["W", "P", "L", "P/L", "Ie"]);
    expect(new Set(COLUMNAS.map((c) => c.key)).size).toBe(COLUMNAS.length);
  });
});

describe("GET /api/glutenlab/samples/daily-report", () => {
  it("devuelve la grilla con sus columnas agrupadas", async () => {
    conModulo();
    const res = await request(app).get("/api/glutenlab/samples/daily-report?date=2026-09-28").set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe("2026-09-28");
    expect(res.body.data.rows).toHaveLength(45);
    expect(res.body.data.columns[0]).toMatchObject({ key: "MANUAL|Humedad termobalanza", group: "% Humedad", manual: true });
    expect(res.body.data.turnos).toEqual([...TURNOS]);
  });

  it("sin acceso al módulo es 403", async () => {
    prismaMock.moduleGrant.findFirst.mockResolvedValue(null);
    const res = await request(app).get("/api/glutenlab/samples/daily-report").set(auth(viewer));
    expect(res.status).toBe(403);
  });
});
