import { vi, describe, it, beforeEach, expect } from "vitest";

vi.mock("../src/lib/database", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { prisma: mockDeep() };
});

import { prisma } from "../src/lib/database";
import LabService from "../src/services/lab.service";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { PrismaClient } from "@prisma/client";

// La ingesta enlaza cada medición a su muestra registrada leyendo la accesión
// de lo que el operario tipeó (sampleRef). Se prueba la regla y el costo: una
// sola consulta de muestras por lote, y nunca un enlace adivinado.

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

const medicion = (sourceId: string, sampleRef: string | null) => ({
  sourceId,
  sampleRef,
  analyzedAt: "2026-09-07T13:00:00.000Z",
  params: [{ code: "Falling Number", value: 320 }],
});

describe("LabService.ingestBatch: enlace a muestras", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.labParameterRange.findMany.mockResolvedValue([]);
    // La transacción interactiva se ejecuta contra el mismo mock.
    (prismaMock.$transaction as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock),
    );
    prismaMock.labMeasurement.findUnique.mockResolvedValue(null);
    prismaMock.labMeasurement.create.mockImplementation(
      async ({ data }: any) => ({ id: `m-${data.sourceId}`, ...data }) as any,
    );
    prismaMock.labParameter.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.labParameter.createMany.mockResolvedValue({ count: 1 });
  });

  it("resuelve las accesiones del lote en UNA consulta y enlaza solo las válidas que existen", async () => {
    prismaMock.labSample.findMany.mockResolvedValue([{ id: "s-12", accession: "M-0012-4" }] as any);

    const r = await LabService.ingestBatch("FN", [
      medicion("1", "M-0012-4"), // exacta
      medicion("2", "m00124 3/0"), // tipeo tolerante, con texto al lado
      medicion("3", "Tapera"), // sin accesión
      medicion("4", "M-0012-5"), // dígito verificador incorrecto: no se adivina
      medicion("5", "A-0001-5"), // válida pero no registrada
      medicion("6", null),
    ]);

    expect(prismaMock.labSample.findMany).toHaveBeenCalledTimes(1);
    const where = prismaMock.labSample.findMany.mock.calls[0][0]?.where as any;
    expect([...where.accession.in].sort()).toEqual(["A-0001-5", "M-0012-4"]);
    expect(where.deletedAt).toBeNull();

    const creados = prismaMock.labMeasurement.create.mock.calls.map((c) => (c[0] as any).data);
    const sampleIdDe = (sourceId: string) => creados.find((d) => d.sourceId === sourceId)?.sampleId;
    expect(sampleIdDe("1")).toBe("s-12");
    expect(sampleIdDe("2")).toBe("s-12");
    expect(sampleIdDe("3")).toBeNull();
    expect(sampleIdDe("4")).toBeNull();
    expect(sampleIdDe("5")).toBeNull();
    expect(sampleIdDe("6")).toBeNull();

    // El sampleRef crudo se conserva siempre, enlace o no.
    expect(creados.find((d) => d.sourceId === "2")?.sampleRef).toBe("m00124 3/0");

    expect(r.inserted).toBe(6);
    expect(r.linked).toBe(2);
    expect(r.failed).toBe(0);
  });

  it("si ningún sampleRef tiene forma de accesión, no consulta muestras", async () => {
    await LabService.ingestBatch("SDMATIC", [medicion("1", "TAPERA 02/09/26"), medicion("2", null)]);

    expect(prismaMock.labSample.findMany).not.toHaveBeenCalled();
    const creados = prismaMock.labMeasurement.create.mock.calls.map((c) => (c[0] as any).data);
    expect(creados.every((d) => d.sampleId === null)).toBe(true);
  });

  it("al re-empujar una medición recalcula el enlace (un sampleRef corregido mueve o suelta el enlace)", async () => {
    prismaMock.labMeasurement.findUnique.mockResolvedValue({ id: "m-1" } as any);
    prismaMock.labMeasurement.update.mockImplementation(async ({ data }: any) => ({ id: "m-1", ...data }) as any);
    prismaMock.labSample.findMany.mockResolvedValue([]); // la accesión tipeada ya no existe

    const r = await LabService.ingestBatch("FN", [medicion("1", "M-0012-4")]);

    const data = (prismaMock.labMeasurement.update.mock.calls[0][0] as any).data;
    expect(data.sampleId).toBeNull();
    expect(r.updated).toBe(1);
    expect(r.linked).toBe(0);
  });
});
