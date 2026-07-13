import { beforeEach, describe, expect, it, vi } from "vitest";

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

import type { PrismaClient } from "@prisma/client";
import type { DeepMockProxy } from "vitest-mock-extended";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();

const assetId = "cmh000aaaaaaaaaaaaaaaaaaa";
const maintenanceId = "cmh333aaaaaaaaaaaaaaaaaaa";
const performerId = "cmh444aaaaaaaaaaaaaaaaaaa";
const supplierId = "cmh555aaaaaaaaaaaaaaaaaaa";
const ticketId = "cmh666aaaaaaaaaaaaaaaaaaa";
const assignmentId = "cmh777aaaaaaaaaaaaaaaaaaa";
const version = new Date("2026-07-12T12:00:00.000Z");
const nextVersion = new Date("2026-07-12T12:01:00.000Z");

const auth = (role: "USER" | "AGENT" | "ADMIN") => ({
  Authorization: `Bearer ${signAccessToken({ role })}`,
});

const makeAsset = (overrides: Record<string, any> = {}) => ({
  id: assetId,
  assetTag: "NB-0001",
  type: "NOTEBOOK",
  status: "IN_STOCK",
  brand: "Lenovo",
  model: "ThinkPad T14",
  serialNumber: "SER-001",
  assignedPersonId: null,
  assignedDepartmentId: null,
  assignedPerson: null,
  assignedDepartment: null,
  ...overrides,
});

const makeMaintenance = (overrides: Record<string, any> = {}) => ({
  id: maintenanceId,
  assetId,
  asset: makeAsset(),
  type: "PREVENTIVE",
  status: "SCHEDULED",
  scheduledAt: new Date("2026-07-20T13:00:00.000Z"),
  performedAt: null,
  description: "Limpieza y control térmico",
  performedById: null,
  performedBy: null,
  supplierId: null,
  supplier: null,
  costAmount: null,
  currency: "ARS",
  parts: null,
  ticketId: null,
  ticket: null,
  createdById: "user-1",
  createdBy: { id: "user-1", name: "IT Agent" },
  createdAt: new Date("2026-07-12T11:00:00.000Z"),
  updatedAt: version,
  ...overrides,
});

const completedPayload = {
  assetId,
  type: "CORRECTIVE",
  status: "COMPLETED",
  performedAt: "2026-07-12T15:30:00.000Z",
  description: "Cambio de batería",
  performedById: performerId,
  costAmount: 125000.5,
  currency: "ARS",
  parts: [{ name: "Batería", quantity: 1, unitCost: "120000.50" }],
};

describe("API de mantenimientos IT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => {
      if (typeof work === "function") return work(prismaMock);
      return Promise.all(work);
    });
  });

  it("requiere autenticación y restringe todo el módulo a AGENT/ADMIN", async () => {
    const unauthenticated = await request(app).get("/api/it/maintenances");
    expect(unauthenticated.status).toBe(401);

    const forbidden = await request(app)
      .get("/api/it/maintenances/lookups")
      .set(auth("USER"));
    expect(forbidden.status).toBe(403);
  });

  it("lista con filtros, rango inclusivo, preview y monto string", async () => {
    prismaMock.maintenance.findMany.mockResolvedValueOnce([
      makeMaintenance({
        description: "x".repeat(300),
        costAmount: "1500.50",
        parts: [{ name: "Pasta", quantity: 1 }],
      }),
    ] as any);
    prismaMock.maintenance.count.mockResolvedValueOnce(1);

    const query =
      `?q=think&type=PREVENTIVE&status=SCHEDULED&assetId=${assetId}` +
      `&supplierId=${supplierId}&scheduledFrom=2026-07-01` +
      "&scheduledTo=2026-07-31&page=2&pageSize=10";
    const response = await request(app)
      .get(`/api/it/maintenances${query}`)
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    expect(response.body.data.pagination).toEqual({
      page: 2,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });
    expect(response.body.data.items[0].description).toHaveLength(240);
    expect(response.body.data.items[0].costAmount).toBe("1500.50");
    expect(response.body.data.items[0].parts).toBeUndefined();

    const call = prismaMock.maintenance.findMany.mock.calls[0][0] as any;
    expect(call.where).toEqual(
      expect.objectContaining({
        type: "PREVENTIVE",
        status: "SCHEDULED",
        assetId,
        supplierId,
        scheduledAt: {
          gte: new Date("2026-07-01T00:00:00.000Z"),
          lte: new Date("2026-07-31T23:59:59.999Z"),
        },
      }),
    );
    expect(call.skip).toBe(10);
    expect(call.take).toBe(10);
    expect(call.orderBy).toEqual([
      { scheduledAt: "asc" },
      { createdAt: "desc" },
    ]);
    expect(call.select.parts).toBeUndefined();
  });

  it("publica lookups mínimos y la ruta estática no cae en /:id", async () => {
    prismaMock.supplier.findMany.mockResolvedValueOnce([
      { id: supplierId, name: "Servicio Norte" },
    ] as any);
    prismaMock.user.findMany.mockResolvedValueOnce([
      { id: performerId, name: "Soporte IT" },
    ] as any);
    prismaMock.ticket.findMany.mockResolvedValueOnce([
      {
        id: ticketId,
        ticketNumber: 42,
        title: "Notebook no inicia",
        status: "OPEN",
        assetId,
      },
    ] as any);

    const response = await request(app)
      .get("/api/it/maintenances/lookups")
      .set(auth("ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      suppliers: [{ id: supplierId, name: "Servicio Norte" }],
      performers: [{ id: performerId, name: "Soporte IT" }],
      tickets: [
        {
          id: ticketId,
          ticketNumber: 42,
          title: "Notebook no inicia",
          status: "OPEN",
          assetId,
        },
      ],
    });
    const performerSelect = (prismaMock.user.findMany.mock.calls[0][0] as any)
      .select;
    expect(performerSelect).toEqual({ id: true, name: true });
  });

  it("devuelve detalle seguro en el envelope acordado", async () => {
    prismaMock.maintenance.findUnique.mockResolvedValueOnce(
      makeMaintenance({
        costAmount: "990.00",
        parts: [{ name: "Pasta térmica", quantity: 1, unitCost: "990.00" }],
        ticket: {
          id: ticketId,
          ticketNumber: 9,
          title: "Temperatura alta",
          status: "OPEN",
          assetId,
        },
      }) as any,
    );

    const response = await request(app)
      .get(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    expect(response.body.data.maintenance.costAmount).toBe("990.00");
    expect(response.body.data.maintenance.parts).toEqual([
      { name: "Pasta térmica", quantity: 1, unitCost: "990.00" },
    ]);
    const select = (prismaMock.maintenance.findUnique.mock.calls[0][0] as any)
      .select;
    expect(select.asset.select.secretsRef).toBeUndefined();
    expect(select.createdBy.select).toEqual({ id: true, name: true });
    expect(select.ticket.select.assetId).toBe(true);
  });

  it.each([
    [
      "fecha calendario imposible",
      {
        assetId,
        type: "PREVENTIVE",
        status: "SCHEDULED",
        scheduledAt: "2026-02-30T12:00:00.000Z",
        description: "Control",
      },
    ],
    [
      "fecha civil sin offset",
      {
        assetId,
        type: "PREVENTIVE",
        status: "SCHEDULED",
        scheduledAt: "2026-07-20",
        description: "Control",
      },
    ],
    [
      "completed sin responsable",
      {
        assetId,
        type: "CORRECTIVE",
        status: "COMPLETED",
        performedAt: "2026-07-20T12:00:00.000Z",
        description: "Control",
      },
    ],
    [
      "performedAt fuera de completed",
      {
        assetId,
        type: "CORRECTIVE",
        status: "IN_PROGRESS",
        performedAt: "2026-07-20T12:00:00.000Z",
        description: "Control",
      },
    ],
    [
      "parts con claves extra",
      {
        assetId,
        type: "PREVENTIVE",
        status: "SCHEDULED",
        scheduledAt: "2026-07-20T12:00:00.000Z",
        description: "Control",
        parts: [{ name: "Disco", quantity: 1, password: "no" }],
      },
    ],
    [
      "unitCost con más de dos decimales",
      {
        assetId,
        type: "PREVENTIVE",
        status: "SCHEDULED",
        scheduledAt: "2026-07-20T12:00:00.000Z",
        description: "Control",
        parts: [{ name: "Disco", quantity: 1, unitCost: "1.234" }],
      },
    ],
  ])("rechaza %s", async (_label, payload) => {
    const response = await request(app)
      .post("/api/it/maintenances")
      .set(auth("AGENT"))
      .send(payload);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.maintenance.create).not.toHaveBeenCalled();
  });

  it("crea un programado de forma atómica con auditoría redactada", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.maintenance.create.mockImplementationOnce(async (args: any) =>
      makeMaintenance({ ...args.data, asset: makeAsset() }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const response = await request(app)
      .post("/api/it/maintenances")
      .set(auth("AGENT"))
      .send({
        assetId,
        type: "PREVENTIVE",
        status: "SCHEDULED",
        scheduledAt: "2026-07-20T13:00:00.000Z",
        description: "  Limpieza completa  ",
        parts: [{ name: "Pasta térmica", quantity: 1, unitCost: "1500.25" }],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.maintenance.description).toBe("Limpieza completa");
    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
    const auditMeta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data
      .meta;
    expect(JSON.stringify(auditMeta)).not.toContain("Limpieza completa");
    expect(JSON.stringify(auditMeta)).not.toContain("Pasta térmica");
    expect(auditMeta.description).toEqual({ stored: true, redacted: true });
  });

  it("valida referencias activas y evita vincular tickets de otro activo", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.user.findFirst.mockResolvedValueOnce(null);

    const missingPerformer = await request(app)
      .post("/api/it/maintenances")
      .set(auth("AGENT"))
      .send(completedPayload);
    expect(missingPerformer.status).toBe(404);
    expect(missingPerformer.body.error.code).toBe(
      "MAINTENANCE_PERFORMER_NOT_FOUND",
    );

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.ticket.findUnique.mockResolvedValueOnce({
      id: ticketId,
      assetId: "cmhabcaaaaaaaaaaaaaaaaaaa",
    } as any);

    const mismatch = await request(app)
      .post("/api/it/maintenances")
      .set(auth("AGENT"))
      .send({
        assetId,
        type: "PREVENTIVE",
        status: "SCHEDULED",
        scheduledAt: "2026-07-20T13:00:00.000Z",
        description: "Control",
        ticketId,
      });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe(
      "MAINTENANCE_TICKET_ASSET_MISMATCH",
    );
  });

  it("permite cargar histórico COMPLETED sobre un activo retirado", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({ status: "RETIRED" }) as any,
    );
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: performerId } as any);
    prismaMock.maintenance.create.mockImplementationOnce(async (args: any) =>
      makeMaintenance({
        ...args.data,
        status: "COMPLETED",
        performedBy: { id: performerId, name: "Soporte IT" },
      }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const response = await request(app)
      .post("/api/it/maintenances")
      .set(auth("ADMIN"))
      .send(completedPayload);

    expect(response.status).toBe(201);
    expect(response.body.data.maintenance.status).toBe("COMPLETED");
    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
  });

  it("rechaza mantenimiento activo sobre activo retirado o perdido", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({ status: "LOST" }) as any,
    );

    const response = await request(app)
      .post("/api/it/maintenances")
      .set(auth("AGENT"))
      .send({
        assetId,
        type: "CORRECTIVE",
        status: "IN_PROGRESS",
        description: "Diagnóstico",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ASSET_NOT_MAINTAINABLE");
    expect(prismaMock.maintenance.create).not.toHaveBeenCalled();
  });

  it("inicia mantenimiento, marca IN_REPAIR y audita ambos recursos", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({
        status: "ASSIGNED",
        assignedPersonId: "cmh888aaaaaaaaaaaaaaaaaaa",
      }) as any,
    );
    prismaMock.maintenance.findFirst.mockResolvedValueOnce(null);
    prismaMock.maintenance.create.mockImplementationOnce(async (args: any) =>
      makeMaintenance({ ...args.data, status: "IN_PROGRESS" }) as any,
    );
    prismaMock.asset.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const response = await request(app)
      .post("/api/it/maintenances")
      .set(auth("AGENT"))
      .send({
        assetId,
        type: "CORRECTIVE",
        status: "IN_PROGRESS",
        description: "Diagnóstico en banco",
      });

    expect(response.status).toBe(201);
    expect(prismaMock.asset.updateMany).toHaveBeenCalledWith({
      where: { id: assetId, isActive: true, status: "ASSIGNED" },
      data: { status: "IN_REPAIR" },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(2);
    expect(
      prismaMock.auditLog.create.mock.calls.map((call: any) => call[0].data.entity),
    ).toEqual(["asset", "maintenance"]);
  });

  it("impide dos IN_PROGRESS y no toma un activo ya IN_REPAIR", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.maintenance.findFirst.mockResolvedValueOnce({
      id: "cmh999aaaaaaaaaaaaaaaaaaa",
    } as any);

    const duplicate = await request(app)
      .post("/api/it/maintenances")
      .set(auth("AGENT"))
      .send({
        assetId,
        type: "CORRECTIVE",
        status: "IN_PROGRESS",
        description: "Segundo trabajo",
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("ASSET_MAINTENANCE_IN_PROGRESS");

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({ status: "IN_REPAIR" }) as any,
    );
    prismaMock.maintenance.findFirst.mockResolvedValueOnce(null);
    prismaMock.maintenance.create.mockResolvedValueOnce(
      makeMaintenance({ status: "IN_PROGRESS" }) as any,
    );

    const unmanaged = await request(app)
      .post("/api/it/maintenances")
      .set(auth("AGENT"))
      .send({
        assetId,
        type: "CORRECTIVE",
        status: "IN_PROGRESS",
        description: "Tomar reparación manual",
      });
    expect(unmanaged.status).toBe(409);
    expect(unmanaged.body.error.code).toBe("ASSET_ALREADY_IN_REPAIR");
    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
  });

  it("detecta conflicto de versión con el código estable acordado", async () => {
    prismaMock.maintenance.findUnique.mockResolvedValueOnce(
      makeMaintenance({ updatedAt: nextVersion }) as any,
    );

    const response = await request(app)
      .patch(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        description: "Cambio",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("MAINTENANCE_VERSION_CONFLICT");
    expect(prismaMock.maintenance.updateMany).not.toHaveBeenCalled();
  });

  it("mantiene el CAS también si la versión cambia entre lectura y escritura", async () => {
    prismaMock.maintenance.findUnique.mockResolvedValueOnce(
      makeMaintenance() as any,
    );
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.maintenance.updateMany.mockResolvedValueOnce({ count: 0 });

    const response = await request(app)
      .patch(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        description: "Cambio concurrente",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("MAINTENANCE_VERSION_CONFLICT");
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("mantiene assetId inmutable, pero repetir el mismo valor puede ser no-op", async () => {
    prismaMock.maintenance.findUnique.mockResolvedValueOnce(
      makeMaintenance() as any,
    );

    const changed = await request(app)
      .patch(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        assetId: "cmhabcaaaaaaaaaaaaaaaaaaa",
      });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("MAINTENANCE_ASSET_IMMUTABLE");

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
    prismaMock.maintenance.findUnique
      .mockResolvedValueOnce(makeMaintenance() as any)
      .mockResolvedValueOnce(makeMaintenance() as any);
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);

    const same = await request(app)
      .patch(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        assetId,
      });
    expect(same.status).toBe(200);
    expect(prismaMock.maintenance.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("pasa SCHEDULED a IN_PROGRESS con CAS y estado de activo", async () => {
    const current = makeMaintenance();
    const updated = makeMaintenance({ status: "IN_PROGRESS", updatedAt: nextVersion });
    prismaMock.maintenance.findUnique
      .mockResolvedValueOnce(current as any)
      .mockResolvedValueOnce(updated as any);
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.maintenance.findFirst.mockResolvedValueOnce(null);
    prismaMock.asset.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.maintenance.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const response = await request(app)
      .patch(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "IN_PROGRESS",
      });

    expect(response.status).toBe(200);
    expect(prismaMock.maintenance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: maintenanceId, updatedAt: version },
        data: { status: "IN_PROGRESS" },
      }),
    );
    expect(prismaMock.asset.updateMany).toHaveBeenCalled();
  });

  it("completa y restaura ASSIGNED desde la asignación vigente", async () => {
    const current = makeMaintenance({
      status: "IN_PROGRESS",
      scheduledAt: null,
      performedById: performerId,
    });
    const updated = makeMaintenance({
      status: "COMPLETED",
      scheduledAt: null,
      performedAt: new Date("2026-07-12T15:30:00.000Z"),
      performedById: performerId,
      updatedAt: nextVersion,
    });
    prismaMock.maintenance.findUnique
      .mockResolvedValueOnce(current as any)
      .mockResolvedValueOnce(updated as any);
    prismaMock.asset.findFirst
      .mockResolvedValueOnce(makeAsset({ status: "IN_REPAIR" }) as any)
      .mockResolvedValueOnce(makeAsset({ status: "IN_REPAIR" }) as any);
    prismaMock.assetAssignment.findFirst.mockResolvedValueOnce({
      id: assignmentId,
      personId: "cmh888aaaaaaaaaaaaaaaaaaa",
      departmentId: null,
    } as any);
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: performerId } as any);
    prismaMock.asset.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.maintenance.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const response = await request(app)
      .patch(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "COMPLETED",
        performedAt: "2026-07-12T15:30:00.000Z",
      });

    expect(response.status).toBe(200);
    expect(prismaMock.asset.updateMany).toHaveBeenCalledWith({
      where: { id: assetId, isActive: true, status: "IN_REPAIR" },
      data: {
        status: "ASSIGNED",
        assignedPersonId: "cmh888aaaaaaaaaaaaaaaaaaa",
        assignedDepartmentId: null,
      },
    });
  });

  it("cancela y restaura IN_STOCK cuando ya no existe asignación", async () => {
    const current = makeMaintenance({
      status: "IN_PROGRESS",
      scheduledAt: null,
    });
    const updated = makeMaintenance({
      status: "CANCELLED",
      scheduledAt: null,
      updatedAt: nextVersion,
    });
    prismaMock.maintenance.findUnique
      .mockResolvedValueOnce(current as any)
      .mockResolvedValueOnce(updated as any);
    prismaMock.asset.findFirst
      .mockResolvedValueOnce(makeAsset({ status: "IN_REPAIR" }) as any)
      .mockResolvedValueOnce(makeAsset({ status: "IN_REPAIR" }) as any);
    prismaMock.assetAssignment.findFirst.mockResolvedValueOnce(null);
    prismaMock.asset.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.maintenance.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const response = await request(app)
      .patch(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "CANCELLED",
      });

    expect(response.status).toBe(200);
    expect(prismaMock.asset.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "IN_STOCK",
          assignedPersonId: null,
          assignedDepartmentId: null,
        },
      }),
    );
  });

  it("no pisa RETIRED/LOST al cerrar y no permite reabrir terminales", async () => {
    const inProgress = makeMaintenance({
      status: "IN_PROGRESS",
      scheduledAt: null,
    });
    prismaMock.maintenance.findUnique.mockResolvedValueOnce(inProgress as any);
    prismaMock.asset.findFirst
      .mockResolvedValueOnce(makeAsset({ status: "LOST" }) as any)
      .mockResolvedValueOnce(makeAsset({ status: "LOST" }) as any);

    const stateConflict = await request(app)
      .patch(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "CANCELLED",
      });
    expect(stateConflict.status).toBe(409);
    expect(stateConflict.body.error.code).toBe(
      "ASSET_MAINTENANCE_STATE_CONFLICT",
    );
    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
    prismaMock.maintenance.findUnique.mockResolvedValueOnce(
      makeMaintenance({
        status: "COMPLETED",
        scheduledAt: null,
        performedAt: new Date("2026-07-12T15:00:00.000Z"),
        performedById: performerId,
      }) as any,
    );

    const reopen = await request(app)
      .patch(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "IN_PROGRESS",
        performedAt: null,
      });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe(
      "MAINTENANCE_STATUS_TRANSITION_INVALID",
    );
  });

  it("no restaura el activo si hay otro mantenimiento IN_PROGRESS inconsistente", async () => {
    prismaMock.maintenance.findUnique.mockResolvedValueOnce(
      makeMaintenance({ status: "IN_PROGRESS", scheduledAt: null }) as any,
    );
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({ status: "IN_REPAIR" }) as any,
    );
    prismaMock.maintenance.findFirst.mockResolvedValueOnce({
      id: "cmh999aaaaaaaaaaaaaaaaaaa",
    } as any);

    const response = await request(app)
      .patch(`/api/it/maintenances/${maintenanceId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "CANCELLED",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ASSET_MAINTENANCE_IN_PROGRESS");
    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.maintenance.updateMany).not.toHaveBeenCalled();
  });

  it("bloquea cambios directos y devoluciones de activos en mantenimiento", async () => {
    const manualRepair = await request(app)
      .post("/api/it/assets")
      .set(auth("AGENT"))
      .send({
        type: "NOTEBOOK",
        status: "IN_REPAIR",
        brand: "Lenovo",
        model: "T14",
      });
    expect(manualRepair.status).toBe(400);
    expect(manualRepair.body.error.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.asset.create).not.toHaveBeenCalled();

    prismaMock.asset.findFirst.mockResolvedValueOnce({
      ...makeAsset({ status: "IN_STOCK" }),
      specs: null,
      notes: null,
      secretsRef: null,
      location: null,
      warrantyUntil: null,
      purchaseItemId: null,
      retiredAt: null,
      retirementReason: null,
      updatedAt: version,
    } as any);
    const enterRepair = await request(app)
      .patch(`/api/it/assets/${assetId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "IN_REPAIR",
      });
    expect(enterRepair.status).toBe(400);
    expect(enterRepair.body.error.code).toBe("ASSET_STATUS_MANAGED");

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );

    const repairAsset = {
      ...makeAsset({ status: "IN_REPAIR" }),
      specs: null,
      notes: null,
      secretsRef: null,
      location: null,
      warrantyUntil: null,
      purchaseItemId: null,
      retiredAt: null,
      retirementReason: null,
      updatedAt: version,
    };
    prismaMock.asset.findFirst.mockResolvedValueOnce(repairAsset as any);
    prismaMock.maintenance.findFirst.mockResolvedValueOnce({ id: maintenanceId } as any);

    const statusChange = await request(app)
      .patch(`/api/it/assets/${assetId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "LOST",
      });
    expect(statusChange.status).toBe(409);
    expect(statusChange.body.error.code).toBe("ASSET_MAINTENANCE_IN_PROGRESS");

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
    prismaMock.asset.findFirst.mockResolvedValueOnce(repairAsset as any);
    prismaMock.maintenance.findFirst.mockResolvedValueOnce({ id: maintenanceId } as any);

    const returned = await request(app)
      .post(`/api/it/assets/${assetId}/return`)
      .set(auth("AGENT"))
      .send({ returnNote: "Intento" });
    expect(returned.status).toBe(409);
    expect(returned.body.error.code).toBe("ASSET_MAINTENANCE_IN_PROGRESS");
    expect(prismaMock.assetAssignment.updateMany).not.toHaveBeenCalled();
  });
});
