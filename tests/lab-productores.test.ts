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
import LabProductoresService, { datasetNombre, normalizarFila, urlDwh } from "../src/services/lab.productores.service";

// Empresas de granos del ERP: el job las trae del DWH y el formulario las
// sugiere en "Empresa". Acá se prueba la normalización del dataset (todo llega
// como texto), que el sync nunca borra ni aplica una caída sospechosa, y que
// las sugerencias mezclan la lista con lo cargado a mano.

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const viewer = signAccessToken({ role: "USER", id: "u-v" });
const conModulo = () => prismaMock.moduleGrant.findFirst.mockResolvedValue({ level: "VIEWER" } as any);

const fila = (over: Record<string, unknown> = {}) => ({
  organizacion_id: "101",
  cuit: " 30712345678 ",
  codigo: "30712345678",
  nombre: "LOS ALAMOS SA",
  razon_social: "LOS ALAMOS SOCIEDAD ANONIMA",
  activo: "1",
  es_proveedor: "1",
  es_cliente: "0",
  tag_compras: "1",
  tag_ventas: "0",
  localidad: "MORTEROS",
  provincia: "CORDOBA",
  localidad_afip: "6415",
  base: "GRF",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LAB_PRODUCTORES_DATASET;
});

describe("normalizarFila", () => {
  it("convierte el texto del DWH a tipos y recorta espacios", () => {
    expect(normalizarFila(fila())).toEqual({
      id: 101,
      cuit: "30712345678",
      codigo: "30712345678",
      nombre: "LOS ALAMOS SA",
      razonSocial: "LOS ALAMOS SOCIEDAD ANONIMA",
      activo: true,
      esProveedor: true,
      esCliente: false,
      tagCompras: true,
      tagVentas: false,
      localidad: "MORTEROS",
      provincia: "CORDOBA",
      localidadAfip: "6415",
      base: "GRF",
    });
  });

  it("acepta los nombres sin guion bajo de otros datasets y booleanos 'true'", () => {
    const p = normalizarFila({ organizacionid: "7", nombre: "X", razonsocial: "X SA", activo: "true", esproveedor: "TRUE" });
    expect(p).toMatchObject({ id: 7, razonSocial: "X SA", activo: true, esProveedor: true, esCliente: false });
  });

  it("descarta filas sin id o sin nombre, y usa la razón social si falta el nombre", () => {
    expect(normalizarFila(fila({ organizacion_id: "" }))).toBeNull();
    expect(normalizarFila(fila({ organizacion_id: "abc" }))).toBeNull();
    expect(normalizarFila(fila({ nombre: "", razon_social: "" }))).toBeNull();
    expect(normalizarFila(fila({ nombre: null }))?.nombre).toBe("LOS ALAMOS SOCIEDAD ANONIMA");
  });
});

describe("datasetNombre", () => {
  it("usa el nombre por defecto y acepta uno por env, pero solo identificadores simples", () => {
    expect(datasetNombre()).toBe("grf_lab_productores_granos");
    process.env.LAB_PRODUCTORES_DATASET = " GRF_Empresas_Granos ";
    expect(datasetNombre()).toBe("grf_empresas_granos");
    process.env.LAB_PRODUCTORES_DATASET = 'grf"; drop table x; --';
    expect(() => datasetNombre()).toThrow(/inválido/);
  });
});

describe("urlDwh", () => {
  it("deja la URL lista para Prisma: cifrada sin validar la CA, sin parámetros de libpq y con pocas conexiones", () => {
    const u = new URL(
      urlDwh("postgresql://grfuser:cl%40ve@grf.dw.finneg.com:5432/finnegansbi?sslmode=require&uselibpqcompat=true"),
    );
    expect(u.username).toBe("grfuser");
    expect(u.password).toBe("cl%40ve");
    expect(u.hostname).toBe("grf.dw.finneg.com");
    expect(u.port).toBe("5432");
    expect(u.pathname).toBe("/finnegansbi");
    expect(u.searchParams.get("sslmode")).toBe("require");
    expect(u.searchParams.get("sslaccept")).toBe("accept_invalid_certs");
    expect(u.searchParams.get("connection_limit")).toBe("2");
    expect(u.searchParams.has("uselibpqcompat")).toBe(false);
  });

  it("tolera comillas y espacios pegados al copiar el secret", () => {
    const u = new URL(urlDwh(' "postgres://u:p@host/db" '));
    expect(u.hostname).toBe("host");
    expect(u.protocol).toBe("postgres:");
  });

  it("si falta o no es una URL de Postgres, explica el formato sin repetir el valor", () => {
    expect(() => urlDwh(undefined)).toThrow(/no está definida/);
    expect(() => urlDwh("   ")).toThrow(/no está definida/);
    for (const malo of [
      "grf.dw.finneg.com",
      "Host=grf.dw.finneg.com;Database=finnegansbi;User=grfuser;Password=x",
      "https://grf.dw.finneg.com/finnegansbi",
      "postgresql:///finnegansbi",
    ]) {
      expect(() => urlDwh(malo)).toThrow(/Formato: postgresql:\/\/usuario:clave@host/);
      expect(() => urlDwh(malo)).not.toThrow(/Password=x/);
    }
  });
});

describe("sincronizar", () => {
  beforeEach(() => {
    prismaMock.labProductorSync.create.mockResolvedValue({ id: "run-1" } as any);
    prismaMock.labProductorSync.update.mockResolvedValue({} as any);
    prismaMock.$transaction.mockResolvedValue([] as any);
    prismaMock.labProductor.updateMany.mockResolvedValue({ count: 2 } as any);
  });

  it("hace upsert de cada empresa, da de baja lógica lo que no vino y cierra la corrida en OK", async () => {
    prismaMock.labProductor.count.mockResolvedValue(3 as any);
    const r = await LabProductoresService.sincronizar(async () => [
      fila(),
      fila({ organizacion_id: "102", nombre: "EL TRIGAL" }),
      fila({ organizacion_id: "102", nombre: "EL TRIGAL (dup)" }),
      fila({ organizacion_id: "" }),
    ]);
    expect(r).toMatchObject({ runId: "run-1", status: "OK", total: 2, upserted: 2, removed: 2 });
    // Dos empresas distintas: la repetida pisa a la anterior, la sin id se descarta.
    expect(prismaMock.labProductor.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.labProductor.upsert.mock.calls[1][0]).toMatchObject({
      where: { id: 102 },
      update: { nombre: "EL TRIGAL (dup)", deletedAt: null },
    });
    const baja = prismaMock.labProductor.updateMany.mock.calls[0][0];
    expect(baja.where).toMatchObject({ deletedAt: null, id: { notIn: [101, 102] } });
    expect((baja.data as any).deletedAt).toBeInstanceOf(Date);
    expect(prismaMock.labProductorSync.update.mock.calls[0][0]).toMatchObject({
      where: { id: "run-1" },
      data: { status: "OK", total: 2, upserted: 2, removed: 2 },
    });
  });

  it("con el dataset vacío no toca nada y deja la corrida en ERROR", async () => {
    prismaMock.labProductor.count.mockResolvedValue(300 as any);
    const r = await LabProductoresService.sincronizar(async () => []);
    expect(r.status).toBe("ERROR");
    expect(r.error).toMatch(/vacío/);
    expect(prismaMock.labProductor.upsert).not.toHaveBeenCalled();
    expect(prismaMock.labProductor.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.labProductorSync.update.mock.calls[0][0].data).toMatchObject({ status: "ERROR" });
  });

  it("si el dataset tiene otras columnas, el error las nombra para poder corregirlo sin entrar al DWH", async () => {
    prismaMock.labProductor.count.mockResolvedValue(0 as any);
    const r = await LabProductoresService.sincronizar(async () => [
      { Nombre: "LOS ALAMOS SA", Codigo: "30712345678", Activo: "1", Tag: "GRANOS" },
    ]);
    expect(r.status).toBe("ERROR");
    expect(r.error).toBe(
      "Ninguna de las 1 filas del dataset tiene id y nombre reconocibles; columnas recibidas: Nombre, Codigo, Activo, Tag",
    );
    expect(prismaMock.labProductor.upsert).not.toHaveBeenCalled();
  });

  it("una caída brusca respecto de la lista vigente tampoco se aplica", async () => {
    prismaMock.labProductor.count.mockResolvedValue(300 as any);
    const r = await LabProductoresService.sincronizar(async () => [fila(), fila({ organizacion_id: "102" })]);
    expect(r.status).toBe("ERROR");
    expect(r.error).toMatch(/caída sospechosa/);
    expect(prismaMock.labProductor.upsert).not.toHaveBeenCalled();
  });

  it("la primera carga (lista vacía) sí se aplica aunque sea chica", async () => {
    prismaMock.labProductor.count.mockResolvedValue(0 as any);
    prismaMock.labProductor.updateMany.mockResolvedValue({ count: 0 } as any);
    const r = await LabProductoresService.sincronizar(async () => [fila()]);
    expect(r).toMatchObject({ status: "OK", total: 1, removed: 0 });
  });

  it("si la lectura del DWH falla, la corrida queda en ERROR con el mensaje", async () => {
    const r = await LabProductoresService.sincronizar(async () => {
      throw new Error("timeout DWH");
    });
    expect(r).toMatchObject({ status: "ERROR", error: "timeout DWH" });
  });
});

describe("GET /samples/suggest: empresa y procedencia salen solo del ERP", () => {
  it("empresa propone únicamente la lista del ERP, con CUIT y localidad, sin lo cargado a mano", async () => {
    conModulo();
    prismaMock.labProductor.findMany.mockResolvedValue([
      { nombre: "EL TRIGAL SRL", cuit: "30700000001", localidad: "SAN FRANCISCO", provincia: "CORDOBA" },
      { nombre: "LOS ALAMOS SA", cuit: "30712345678", localidad: null, provincia: null },
    ] as any);
    const res = await request(app).get("/api/glutenlab/samples/suggest?key=empresa").set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      { value: "EL TRIGAL SRL", label: "30700000001 · SAN FRANCISCO, CORDOBA" },
      { value: "LOS ALAMOS SA", label: "30712345678" },
    ]);
    expect(res.body.data.values).toEqual(["EL TRIGAL SRL", "LOS ALAMOS SA"]);
    expect(prismaMock.labProductor.findMany.mock.calls[0][0]).toMatchObject({
      where: { deletedAt: null, activo: true },
    });
    // El historial ni se consulta.
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("procedencia propone las localidades de esas empresas, sin repetir y con la provincia de etiqueta", async () => {
    conModulo();
    prismaMock.labProductor.findMany.mockResolvedValue([
      { localidad: "MORTEROS", provincia: "CORDOBA" },
      { localidad: "SAN FRANCISCO", provincia: "CORDOBA" },
      { localidad: "SAN FRANCISCO", provincia: null },
    ] as any);
    const res = await request(app).get("/api/glutenlab/samples/suggest?key=procedencia").set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      { value: "MORTEROS", label: "CORDOBA" },
      { value: "SAN FRANCISCO", label: "CORDOBA" },
      { value: "SAN FRANCISCO", label: "" },
    ]);
    expect(prismaMock.labProductor.findMany.mock.calls[0][0]).toMatchObject({
      where: { deletedAt: null, activo: true, localidad: { not: null } },
      distinct: ["localidad", "provincia"],
    });
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("si la lista del ERP todavía está vacía, cae al historial para no dejar el campo mudo", async () => {
    conModulo();
    prismaMock.labProductor.findMany.mockResolvedValue([] as any);
    prismaMock.$queryRaw.mockResolvedValue([{ valor: "Los Alamos SA", n: 5n }] as any);
    const res = await request(app).get("/api/glutenlab/samples/suggest?key=empresa").set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ values: ["Los Alamos SA"], items: [{ value: "Los Alamos SA" }] });
  });

  it("otros campos no consultan la lista del ERP", async () => {
    conModulo();
    prismaMock.$queryRaw.mockResolvedValue([{ valor: "Juan", n: 1n }] as any);
    const res = await request(app).get("/api/glutenlab/samples/suggest?key=chofer").set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ values: ["Juan"], items: [{ value: "Juan" }] });
    expect(prismaMock.labProductor.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /productores/status", () => {
  it("informa cantidades, última corrida y si la lista está desactualizada", async () => {
    conModulo();
    const hace3dias = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    prismaMock.labProductor.count.mockResolvedValueOnce(363 as any).mockResolvedValueOnce(360 as any);
    prismaMock.labProductorSync.findFirst
      .mockResolvedValueOnce({ id: "r2", startedAt: new Date(), finishedAt: new Date(), status: "ERROR", total: null, error: "timeout DWH" } as any)
      .mockResolvedValueOnce({ id: "r1", startedAt: hace3dias, finishedAt: hace3dias, status: "OK", total: 363, error: null } as any);
    const res = await request(app).get("/api/glutenlab/productores/status").set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      total: 363,
      activos: 360,
      dataset: "grf_lab_productores_granos",
      ultimaCorrida: { status: "ERROR", error: "timeout DWH" },
      desactualizado: true,
    });
    expect(res.body.data.ultimaOk).toBe(hace3dias.toISOString());
  });

  it("sin módulo no se ve", async () => {
    prismaMock.moduleGrant.findFirst.mockResolvedValue(null);
    const res = await request(app).get("/api/glutenlab/productores/status").set(auth(viewer));
    expect(res.status).toBe(403);
  });
});
