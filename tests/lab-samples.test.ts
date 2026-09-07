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

// Registro de muestras, de punta a punta por HTTP: la puerta del módulo con
// nivel, la validación del sobre, la validación de la ficha contra el catálogo,
// la asignación de accesión y el armado del nombre. Prisma mockeado: acá se
// prueba el cableado y las reglas, no la base.

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const BASE = "/api/glutenlab/samples";

const ahora = new Date();
const campo = (overrides: Record<string, unknown>) => ({
  id: "f",
  kindId: "lsk_interna",
  required: false,
  options: null,
  inName: false,
  namePrefix: null,
  placeholder: null,
  sortOrder: 0,
  isActive: true,
  createdAt: ahora,
  updatedAt: ahora,
  ...overrides,
});

const KIND = {
  id: "lsk_interna",
  code: "INTERNA",
  name: "Muestra interna de proceso",
  description: null,
  defaultSite: "MOLINO",
  sortOrder: 1,
  isActive: true,
  createdAt: ahora,
  updatedAt: ahora,
  fields: [
    campo({
      id: "f-turno",
      key: "turno",
      label: "Turno",
      type: "SELECT",
      required: true,
      options: ["1° Noche", "2° Mañana", "3° Tarde"],
      sortOrder: 1,
    }),
    campo({
      id: "f-producto",
      key: "producto",
      label: "Producto",
      type: "SELECT",
      required: true,
      options: ["3/0", "4/0", "Tapera"],
      inName: true,
      sortOrder: 2,
    }),
    campo({
      id: "f-lote",
      key: "lote",
      label: "Lote",
      type: "TEXT",
      inName: true,
      namePrefix: "Lote ",
      sortOrder: 3,
    }),
  ],
};

const conNivel = (level: "VIEWER" | "QC" | "MANAGEMENT") =>
  prismaMock.moduleGrant.findFirst.mockResolvedValue({ level } as any);

const usuario = signAccessToken({ role: "USER", id: "u-op" });

describe("POST /api/glutenlab/samples", () => {
  beforeEach(() => vi.clearAllMocks());

  it("un VIEWER del módulo no puede registrar muestras (403) y no quema correlativo", async () => {
    conNivel("VIEWER");

    const res = await request(app)
      .post(BASE)
      .set(auth(usuario))
      .send({ kindId: "lsk_interna", site: "MOLINO", fields: {} });

    expect(res.status).toBe(403);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.labSample.create).not.toHaveBeenCalled();
  });

  it("sin acceso al módulo es 403 aunque el cuerpo sea válido", async () => {
    prismaMock.moduleGrant.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(BASE)
      .set(auth(usuario))
      .send({ kindId: "lsk_interna", site: "MOLINO", fields: {} });

    expect(res.status).toBe(403);
  });

  it("QC registra: asigna la accesión con dígito verificador y arma el nombre", async () => {
    conNivel("QC");
    prismaMock.labSampleKind.findFirst.mockResolvedValue(KIND as any);
    prismaMock.$queryRaw.mockResolvedValue([{ seq: 12n }] as any);
    prismaMock.labSample.create.mockImplementation(
      async ({ data }: any) =>
        ({
          id: "s-1",
          ...data,
          kind: { id: KIND.id, code: KIND.code, name: KIND.name },
          createdBy: { id: "u-op", name: "Operario" },
        }) as any,
    );

    const res = await request(app)
      .post(BASE)
      .set(auth(usuario))
      .send({
        kindId: "lsk_interna",
        site: "MOLINO",
        // 13:30Z = 10:30 en planta.
        sampledAt: "2026-09-07T13:30:00.000Z",
        fields: { turno: "2° Mañana", producto: "3/0", lote: " 4521 " },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.accession).toBe("M-0012-4");
    expect(res.body.data.displayName).toBe("Molino · 3/0 · Lote 4521 · 07/09 10:30");

    const data = prismaMock.labSample.create.mock.calls[0][0].data as any;
    expect(data.seq).toBe(12);
    expect(data.site).toBe("MOLINO");
    expect(data.createdById).toBe("u-op");
    // El texto se recorta y solo entran las keys definidas.
    expect(data.fields).toEqual({ turno: "2° Mañana", producto: "3/0", lote: "4521" });
  });

  it("ADMIN entra sin concesión explícita", async () => {
    prismaMock.labSampleKind.findFirst.mockResolvedValue(KIND as any);
    prismaMock.$queryRaw.mockResolvedValue([{ seq: 1 }] as any);
    prismaMock.labSample.create.mockImplementation(async ({ data }: any) => ({ id: "s", ...data }) as any);

    const res = await request(app)
      .post(BASE)
      .set(auth(signAccessToken({ role: "ADMIN", id: "adm" })))
      .send({ kindId: "lsk_interna", site: "ACOPIO", fields: { turno: "1° Noche", producto: "Tapera" } });

    expect(res.status).toBe(201);
    expect(prismaMock.moduleGrant.findFirst).not.toHaveBeenCalled();
    expect(res.body.data.accession).toMatch(/^A-0001-\d$/);
  });

  it("una ficha inválida es 400 con el detalle por campo, y no quema correlativo", async () => {
    conNivel("QC");
    prismaMock.labSampleKind.findFirst.mockResolvedValue(KIND as any);

    const res = await request(app)
      .post(BASE)
      .set(auth(usuario))
      .send({
        kindId: "lsk_interna",
        site: "MOLINO",
        fields: { turno: "Mañana", silo: "S2" }, // opción inválida, falta producto, key desconocida
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const campos = (res.body.error.details as { field: string }[]).map((d) => d.field).sort();
    expect(campos).toEqual(["fields.producto", "fields.silo", "fields.turno"]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.labSample.create).not.toHaveBeenCalled();
  });

  it("un tipo de muestra inexistente es 404 y no quema correlativo", async () => {
    conNivel("QC");
    prismaMock.labSampleKind.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(BASE)
      .set(auth(usuario))
      .send({ kindId: "no-existe", site: "MOLINO", fields: {} });

    expect(res.status).toBe(404);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("rechaza un sitio que no es MOLINO ni ACOPIO antes de tocar la base", async () => {
    conNivel("QC");

    const res = await request(app)
      .post(BASE)
      .set(auth(usuario))
      .send({ kindId: "lsk_interna", site: "DEPOSITO", fields: {} });

    expect(res.status).toBe(400);
    expect(prismaMock.labSampleKind.findFirst).not.toHaveBeenCalled();
  });
});

describe("GET /api/glutenlab/samples/:accession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("un dígito verificador que no cierra es 400 (error de tipeo), no 404", async () => {
    conNivel("VIEWER");

    const res = await request(app).get(`${BASE}/M-0012-5`).set(auth(usuario));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_ACCESSION");
    expect(prismaMock.labSample.findFirst).not.toHaveBeenCalled();
  });

  it("tolera el tipeo y busca la forma canónica", async () => {
    conNivel("VIEWER");
    prismaMock.labSample.findFirst.mockResolvedValue({ id: "s-1", accession: "M-0012-4" } as any);

    const res = await request(app).get(`${BASE}/m00124`).set(auth(usuario));

    expect(res.status).toBe(200);
    const where = prismaMock.labSample.findFirst.mock.calls[0][0]?.where as any;
    expect(where.accession).toBe("M-0012-4");
    expect(where.deletedAt).toBeNull();
  });

  it("404 si la accesión es válida pero no está registrada", async () => {
    conNivel("VIEWER");
    prismaMock.labSample.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`${BASE}/M-0012-4`).set(auth(usuario));

    expect(res.status).toBe(404);
  });

  it("las rutas literales no caen en :accession", async () => {
    conNivel("VIEWER");
    prismaMock.labSampleKind.findMany.mockResolvedValue([KIND] as any);

    const res = await request(app).get(`${BASE}/kinds`).set(auth(usuario));

    expect(res.status).toBe(200);
    expect(res.body.data[0].code).toBe("INTERNA");
    expect(prismaMock.labSample.findFirst).not.toHaveBeenCalled();
  });
});

describe("GET /api/glutenlab/samples (lista)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.labSample.findMany.mockResolvedValue([]);
    prismaMock.labSample.count.mockResolvedValue(0);
  });

  it("una accesión válida busca exacto por su forma canónica", async () => {
    conNivel("VIEWER");

    const res = await request(app).get(BASE).query({ q: "m-12-4" }).set(auth(usuario));

    expect(res.status).toBe(200);
    const where = prismaMock.labSample.findMany.mock.calls[0][0]?.where as any;
    expect(where.accession).toBe("M-0012-4");
    expect(res.body.data.warning).toBeUndefined();
  });

  it("con forma de accesión pero dígito incorrecto busca por texto y avisa", async () => {
    conNivel("VIEWER");

    const res = await request(app).get(BASE).query({ q: "M-0012-5" }).set(auth(usuario));

    expect(res.status).toBe(200);
    const where = prismaMock.labSample.findMany.mock.calls[0][0]?.where as any;
    expect(where.accession).toBeUndefined();
    expect(where.OR).toHaveLength(2);
    expect(res.body.data.warning).toMatch(/dígito verificador/);
  });

  it("el texto libre busca en el nombre y las fechas de planta acotan la toma", async () => {
    conNivel("VIEWER");

    const res = await request(app)
      .get(BASE)
      .query({ q: "Tapera", from: "2026-09-01", to: "2026-09-07", site: "MOLINO" })
      .set(auth(usuario));

    expect(res.status).toBe(200);
    const where = prismaMock.labSample.findMany.mock.calls[0][0]?.where as any;
    expect(where.site).toBe("MOLINO");
    expect(where.OR[1].displayName).toEqual({ contains: "Tapera", mode: "insensitive" });
    // 00:00 del 1/9 en planta (UTC-3) = 03:00Z; 23:59:59.999 del 7/9 = 02:59:59.999Z del 8/9.
    expect((where.sampledAt.gte as Date).toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect((where.sampledAt.lte as Date).toISOString()).toBe("2026-09-08T02:59:59.999Z");
  });
});
