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

// Lo pedido por acopio y comercio el 1-oct-2026: el camión rechazado (con
// nota obligatoria, quién y cuándo) y los filtros por campo de la ficha
// ("Tipo de ingreso": camión o muestra del cliente) y por rechazados, en la
// lista y en la grilla. Además, las dos reglas nuevas del catálogo que lo
// sostienen: valor inicial y "ofrecer como filtro".

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const BASE = "/api/glutenlab/samples";

const qc = signAccessToken({ role: "USER", id: "u-qc" });
const viewer = signAccessToken({ role: "USER", id: "u-v" });
const conNivel = (level: "VIEWER" | "QC" | "MANAGEMENT") =>
  prismaMock.moduleGrant.findFirst.mockResolvedValue({ level } as any);

const ahora = new Date();
const muestra = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  accession: "A-0002-4",
  site: "ACOPIO",
  seq: 2,
  kindId: "lsk_recepcion",
  sampledAt: ahora,
  displayName: "Acopio · Los Álamos",
  fields: { empresa: "Los Álamos", tipo_ingreso: "Camión" },
  notes: null,
  rejectedAt: null,
  rejectedReason: null,
  rejectedById: null,
  createdById: "u",
  deletedAt: null,
  createdAt: ahora,
  updatedAt: ahora,
  kind: { id: "lsk_recepcion", code: "RECEPCION", name: "Recepción de grano" },
  createdBy: { id: "u", name: "Operario" },
  rejectedBy: null,
  ...over,
});

describe("POST / DELETE /samples/:id/reject — camión rechazado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.labSampleFieldDef.findMany.mockResolvedValue([]);
  });

  it("marcar el rechazo exige QC", async () => {
    conNivel("VIEWER");
    const res = await request(app).post(`${BASE}/s1/reject`).set(auth(viewer)).send({ reason: "Olor fuerte" });
    expect(res.status).toBe(403);
    expect(prismaMock.labSample.update).not.toHaveBeenCalled();
  });

  it("la nota es obligatoria y tiene que decir algo", async () => {
    conNivel("QC");
    const sinNota = await request(app).post(`${BASE}/s1/reject`).set(auth(qc)).send({});
    expect(sinNota.status).toBe(400);
    const corta = await request(app).post(`${BASE}/s1/reject`).set(auth(qc)).send({ reason: "  x " });
    expect(corta.status).toBe(400);
    expect(prismaMock.labSample.update).not.toHaveBeenCalled();
  });

  it("QC marca el rechazo con el motivo, quién y cuándo, y la respuesta trae la ficha con el rechazo", async () => {
    conNivel("QC");
    prismaMock.labSample.findFirst.mockResolvedValue({ id: "s1" } as any);
    prismaMock.labSample.update.mockResolvedValue(
      muestra({
        rejectedAt: ahora,
        rejectedReason: "Olor fuerte y brotado",
        rejectedById: "u-qc",
        rejectedBy: { id: "u-qc", name: "Ana" },
      }) as any,
    );

    const res = await request(app)
      .post(`${BASE}/s1/reject`)
      .set(auth(qc))
      .send({ reason: "  Olor fuerte y brotado  " });

    expect(res.status).toBe(200);
    expect(prismaMock.labSample.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1", deletedAt: null } }),
    );
    const call = prismaMock.labSample.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "s1" });
    expect(call.data).toEqual({
      rejectedAt: expect.any(Date),
      rejectedReason: "Olor fuerte y brotado",
      rejectedById: "u-qc",
    });
    expect(res.body.data).toMatchObject({
      accession: "A-0002-4",
      rejectedReason: "Olor fuerte y brotado",
      rejectedBy: { name: "Ana" },
      conditions: [],
    });
  });

  it("una muestra inexistente (o borrada) es 404 y no se toca nada", async () => {
    conNivel("QC");
    prismaMock.labSample.findFirst.mockResolvedValue(null);
    const res = await request(app).post(`${BASE}/nope/reject`).set(auth(qc)).send({ reason: "Olor fuerte" });
    expect(res.status).toBe(404);
    expect(prismaMock.labSample.update).not.toHaveBeenCalled();
  });

  it("quitar el rechazo limpia motivo, quién y cuándo (QC)", async () => {
    conNivel("QC");
    prismaMock.labSample.findFirst.mockResolvedValue({ id: "s1" } as any);
    prismaMock.labSample.update.mockResolvedValue(muestra() as any);

    const res = await request(app).delete(`${BASE}/s1/reject`).set(auth(qc));

    expect(res.status).toBe(200);
    expect(prismaMock.labSample.update.mock.calls[0][0].data).toEqual({
      rejectedAt: null,
      rejectedReason: null,
      rejectedById: null,
    });
    expect(res.body.data.rejectedAt).toBeNull();
  });

  it("un VIEWER tampoco puede quitarlo", async () => {
    conNivel("VIEWER");
    const res = await request(app).delete(`${BASE}/s1/reject`).set(auth(viewer));
    expect(res.status).toBe(403);
  });
});

describe("GET /samples y /samples/grid — filtros por campo de la ficha y por rechazo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conNivel("VIEWER");
    prismaMock.labSample.findMany.mockResolvedValue([]);
    prismaMock.labSample.count.mockResolvedValue(0);
    prismaMock.labMeasurement.groupBy.mockResolvedValue([] as any);
    prismaMock.labMeasurement.findMany.mockResolvedValue([]);
  });

  it("f.<clave>=<valor> filtra por igualdad sobre el JSON de la ficha; una clave mal formada se ignora", async () => {
    const res = await request(app)
      .get(BASE)
      .query({ "f.tipo_ingreso": "Muestra del cliente", "f.Bad-Key": "x", "f.vacio": "  " })
      .set(auth(viewer));

    expect(res.status).toBe(200);
    const where = prismaMock.labSample.findMany.mock.calls[0][0]?.where;
    expect(where).toMatchObject({
      deletedAt: null,
      AND: [{ fields: { path: ["tipo_ingreso"], equals: "Muestra del cliente" } }],
    });
    expect(where?.rejectedAt).toBeUndefined();
  });

  it("rejected=true trae solo los rechazados; rejected=false, solo los no rechazados; sin el parámetro, todos", async () => {
    await request(app).get(BASE).query({ rejected: "true" }).set(auth(viewer));
    expect(prismaMock.labSample.findMany.mock.calls[0][0]?.where).toMatchObject({ rejectedAt: { not: null } });

    await request(app).get(`${BASE}/grid`).query({ rejected: "false" }).set(auth(viewer));
    expect(prismaMock.labSample.findMany.mock.calls[1][0]?.where).toMatchObject({ rejectedAt: null });

    await request(app).get(BASE).set(auth(viewer));
    expect(prismaMock.labSample.findMany.mock.calls[2][0]?.where?.rejectedAt).toBeUndefined();
  });

  it("la grilla acepta el mismo filtro por campo y devuelve el rechazo en cada fila", async () => {
    prismaMock.labSample.findMany.mockResolvedValue([
      muestra({ rejectedAt: ahora, rejectedReason: "Fusarium", rejectedBy: { id: "u-qc", name: "Ana" } }),
    ] as any);
    prismaMock.labSample.count.mockResolvedValue(1);
    prismaMock.labSampleFieldDef.findMany.mockResolvedValue([]);

    const res = await request(app).get(`${BASE}/grid`).query({ "f.tipo_ingreso": "Camión" }).set(auth(viewer));

    expect(res.status).toBe(200);
    expect(prismaMock.labSample.findMany.mock.calls[0][0]?.where).toMatchObject({
      AND: [{ fields: { path: ["tipo_ingreso"], equals: "Camión" } }],
    });
    expect(res.body.data.items[0]).toMatchObject({
      accession: "A-0002-4",
      rejectedReason: "Fusarium",
      rejectedBy: { name: "Ana" },
    });
  });
});

describe("catálogo — valor inicial y filtro de un campo", () => {
  const management = signAccessToken({ role: "USER", id: "u-m" });

  beforeEach(() => {
    vi.clearAllMocks();
    conNivel("MANAGEMENT");
    prismaMock.labSampleKind.findUnique.mockResolvedValue({ id: "lsk_recepcion" } as any);
    prismaMock.labSampleFieldDef.create.mockImplementation(async (args: any) => ({ id: "f-nuevo", ...args.data }));
  });

  it("el valor inicial de una lista tiene que ser una de sus opciones", async () => {
    const res = await request(app)
      .post(`${BASE}/kinds/lsk_recepcion/fields`)
      .set(auth(management))
      .send({
        key: "tipo_ingreso",
        type: "SELECT",
        label: "Tipo de ingreso",
        options: ["Camión", "Muestra del cliente"],
        defaultValue: "Tolva",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("valor inicial");
    expect(prismaMock.labSampleFieldDef.create).not.toHaveBeenCalled();
  });

  it("guarda el valor inicial y el filtro de una lista", async () => {
    const res = await request(app)
      .post(`${BASE}/kinds/lsk_recepcion/fields`)
      .set(auth(management))
      .send({
        key: "tipo_ingreso",
        type: "SELECT",
        label: "Tipo de ingreso",
        options: ["Camión", "Muestra del cliente"],
        defaultValue: " Camión ",
        filterable: true,
      });

    expect(res.status).toBe(201);
    expect(prismaMock.labSampleFieldDef.create.mock.calls[0][0].data).toMatchObject({
      defaultValue: "Camión",
      filterable: true,
    });
  });

  it("el filtro solo aplica a listas: en un texto queda apagado aunque lo pidan", async () => {
    const res = await request(app)
      .post(`${BASE}/kinds/lsk_recepcion/fields`)
      .set(auth(management))
      .send({ key: "chofer", type: "TEXT", label: "Chofer", filterable: true, defaultValue: "" });

    expect(res.status).toBe(201);
    expect(prismaMock.labSampleFieldDef.create.mock.calls[0][0].data).toMatchObject({
      defaultValue: null,
      filterable: false,
    });
  });

  it("al editar, cambiar las opciones no puede dejar el valor inicial vigente afuera", async () => {
    prismaMock.labSampleFieldDef.findUnique.mockResolvedValue({
      id: "f-tipo",
      kindId: "lsk_recepcion",
      key: "tipo_ingreso",
      type: "SELECT",
      options: ["Camión", "Muestra del cliente"],
      defaultValue: "Camión",
    } as any);

    const res = await request(app)
      .patch(`${BASE}/fields/f-tipo`)
      .set(auth(management))
      .send({ label: "Tipo de ingreso", options: ["Tolva", "Muestra del cliente"] });

    expect(res.status).toBe(400);
    expect(prismaMock.labSampleFieldDef.update).not.toHaveBeenCalled();
  });
});
