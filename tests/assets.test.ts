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
import type { PrismaClient } from "@prisma/client";
import type { DeepMockProxy } from "vitest-mock-extended";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const assetId = "cmh000aaaaaaaaaaaaaaaaaaa";
const personId = "cmh111aaaaaaaaaaaaaaaaaaa";
const assignmentId = "cmh222aaaaaaaaaaaaaaaaaaa";
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
  specs: { ramGb: 16 },
  notes: null,
  location: "Depósito IT",
  warrantyUntil: null,
  assignedPersonId: null,
  assignedDepartmentId: null,
  purchaseItemId: null,
  retiredAt: null,
  retirementReason: null,
  isActive: true,
  deletedAt: null,
  createdById: "user-1",
  createdAt: new Date(),
  updatedAt: version,
  assignedPerson: null,
  assignedDepartment: null,
  createdBy: {
    id: "user-1",
    name: "IT Agent",
    email: "agent@test.local",
  },
  assignments: [],
  ...overrides,
});

describe("API de inventario IT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => {
      if (typeof work === "function") return work(prismaMock);
      return Promise.all(work);
    });
  });

  it("requiere autenticación y rechaza USER", async () => {
    const unauthenticated = await request(app).get("/api/it/assets");
    expect(unauthenticated.status).toBe(401);

    const forbidden = await request(app)
      .get("/api/it/assets")
      .set(auth("USER"));
    expect(forbidden.status).toBe(403);
  });

  it("valida filtros y devuelve el contrato items + pagination", async () => {
    prismaMock.asset.findMany.mockResolvedValueOnce([makeAsset()] as any);
    prismaMock.asset.count.mockResolvedValueOnce(1);

    const response = await request(app)
      .get(
        "/api/it/assets?q=think&type=NOTEBOOK&status=IN_STOCK&page=2&pageSize=10",
      )
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].secretsRef).toBeUndefined();
    expect(response.body.data.pagination).toEqual({
      page: 2,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });
    expect(prismaMock.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          type: "NOTEBOOK",
          status: "IN_STOCK",
        }),
        skip: 10,
        take: 10,
      }),
    );
    const listSelect = (prismaMock.asset.findMany.mock.calls[0][0] as any)
      .select;
    expect(listSelect.secretsRef).toBeUndefined();

    const invalid = await request(app)
      .get("/api/it/assets?type=INVALID")
      .set(auth("AGENT"));
    expect(invalid.status).toBe(400);
  });

  it("devuelve el detalle activo con el historial solicitado a Prisma", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({
        assignments: [
          {
            id: assignmentId,
            startAt: new Date(),
            endAt: null,
          },
        ],
      }) as any,
    );

    const response = await request(app)
      .get("/api/it/assets/" + assetId)
      .set(auth("ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.assignments).toHaveLength(1);
    expect(response.body.data.secretsRef).toBeUndefined();
    expect(prismaMock.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: assetId, isActive: true },
        select: expect.objectContaining({
          assignedPerson: expect.any(Object),
          assignedDepartment: expect.any(Object),
          createdBy: expect.any(Object),
          assignments: expect.objectContaining({
            orderBy: { startAt: "desc" },
          }),
        }),
      }),
    );
    const detailSelect = (prismaMock.asset.findFirst.mock.calls[0][0] as any)
      .select;
    expect(detailSelect.secretsRef).toBeUndefined();
  });

  it.each([
    { seguridad: { contraseña: "no-guardar" } },
    { acceso: [{ pass: "no-guardar" }] },
    { telefonia: { phone_number: "+5493415550000" } },
    { sim: { ICCID: "8954" } },
    { firmware: { PIN: "1234" } },
  ])("rechaza claves sensibles anidadas en specs: %j", async (specs) => {
    const response = await request(app)
      .post("/api/it/assets")
      .set(auth("AGENT"))
      .send({
        type: "NOTEBOOK",
        brand: "Lenovo",
        model: "T14",
        specs,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.asset.create).not.toHaveBeenCalled();
  });

  it("crea con tag correlativo, fecha YYYY-MM-DD UTC y audit sanitizado", async () => {
    prismaMock.asset.findMany.mockResolvedValueOnce([
      { assetTag: "NB-0002" },
    ] as any);
    prismaMock.asset.create.mockImplementationOnce(async (args: any) =>
      makeAsset({
        ...args.data,
        assetTag: args.data.assetTag,
        warrantyUntil: args.data.warrantyUntil,
      }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/it/assets")
      .set(auth("AGENT"))
      .send({
        type: "NOTEBOOK",
        brand: "Lenovo",
        model: "T14",
        warrantyUntil: "2027-08-31",
        specs: { cpu: "Core i7", ramGb: 16 },
        notes: "   ",
      });

    expect(response.status).toBe(201);
    expect(response.body.data.assetTag).toBe("NB-0003");
    expect(prismaMock.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetTag: "NB-0003",
          notes: null,
          warrantyUntil: new Date("2027-08-31T00:00:00.000Z"),
        }),
      }),
    );
    const auditMeta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data
      .meta;
    expect(auditMeta.assetTagGenerated).toBe(true);
    expect(auditMeta.fields).toEqual(
      expect.arrayContaining(["assetTag", "notes", "specs", "warrantyUntil"]),
    );
    expect(JSON.stringify(auditMeta)).not.toContain("Core i7");
  });

  it.each(["assetTag", "secretsRef", "purchaseItemId"])(
    "impide que AGENT defina el campo administrativo %s al crear",
    async (field) => {
      const values: Record<string, string> = {
        assetTag: "NB-9000",
        secretsRef: "vault:item:123",
        purchaseItemId: "cmh333aaaaaaaaaaaaaaaaaaa",
      };
      const response = await request(app)
        .post("/api/it/assets")
        .set(auth("AGENT"))
        .send({
          type: "NOTEBOOK",
          brand: "Lenovo",
          model: "T14",
          [field]: values[field],
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
      expect(prismaMock.asset.create).not.toHaveBeenCalled();
    },
  );

  it("exige persona y/o sector para asignar", async () => {
    const response = await request(app)
      .post("/api/it/assets/" + assetId + "/assign")
      .set(auth("AGENT"))
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("asigna de forma transaccional y registra audit sin la nota", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({
        assignedPersonId: null,
        assignedDepartmentId: null,
      }) as any,
    );
    prismaMock.assetAssignment.findFirst.mockResolvedValueOnce(null);
    prismaMock.person.findFirst.mockResolvedValueOnce({ id: personId } as any);
    prismaMock.assetAssignment.create.mockResolvedValueOnce({
      id: assignmentId,
    } as any);
    prismaMock.asset.update.mockResolvedValueOnce(
      makeAsset({
        status: "ASSIGNED",
        assignedPersonId: personId,
      }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/it/assets/" + assetId + "/assign")
      .set(auth("AGENT"))
      .send({
        personId,
        note: "observación privada de entrega",
      });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("ASSIGNED");
    expect(prismaMock.assetAssignment.create).toHaveBeenCalled();
    expect(prismaMock.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "ASSIGNED",
          assignedPersonId: personId,
        }),
      }),
    );
    const auditMeta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data
      .meta;
    expect(auditMeta.assignmentId).toBe(assignmentId);
    expect(JSON.stringify(auditMeta)).not.toContain(
      "observación privada de entrega",
    );
  });

  it("permite conservar status ASSIGNED al editar la ficha", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({
        status: "ASSIGNED",
        assignedPersonId: personId,
      }) as any,
    );
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({
        status: "ASSIGNED",
        assignedPersonId: personId,
        brand: "Lenovo actualizado",
        updatedAt: nextVersion,
      }) as any,
    );
    prismaMock.asset.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .patch("/api/it/assets/" + assetId)
      .set(auth("AGENT"))
      .send({
        assetTag: "NB-0001",
        status: "ASSIGNED",
        brand: "Lenovo actualizado",
        expectedUpdatedAt: version.toISOString(),
      });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("ASSIGNED");
    expect(prismaMock.assetAssignment.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.asset.updateMany).toHaveBeenCalledWith(
      {
        data: { brand: "Lenovo actualizado" },
        where: {
          id: assetId,
          isActive: true,
          updatedAt: version,
        },
      },
    );
    const auditMeta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data
      .meta;
    expect(auditMeta).toEqual({
      fields: ["brand"],
      changes: {
        brand: { from: "Lenovo", to: "Lenovo actualizado" },
      },
    });
  });

  it("devuelve el recurso sin escribir ni auditar cuando el PATCH es un no-op", async () => {
    const unchanged = makeAsset({
      status: "ASSIGNED",
      assignedPersonId: personId,
      specs: { ramGb: 16, cpu: "Core i7" },
      notes: "Equipo de desarrollo",
      warrantyUntil: new Date("2027-08-31T00:00:00.000Z"),
    });
    prismaMock.asset.findFirst
      .mockResolvedValueOnce(unchanged as any)
      .mockResolvedValueOnce(unchanged as any);

    const response = await request(app)
      .patch("/api/it/assets/" + assetId)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        assetTag: "nb-0001",
        status: "ASSIGNED",
        brand: " Lenovo ",
        specs: { cpu: "Core i7", ramGb: 16 },
        notes: " Equipo de desarrollo ",
        warrantyUntil: "2027-08-31",
      });

    expect(response.status).toBe(200);
    expect(response.body.data.assetTag).toBe("NB-0001");
    expect(response.body.data.secretsRef).toBeUndefined();
    expect(prismaMock.assetAssignment.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    const safeSelect = (prismaMock.asset.findFirst.mock.calls[1][0] as any)
      .select;
    expect(safeSelect.secretsRef).toBeUndefined();
  });

  it("no regenera retiredAt al reenviar el mismo estado RETIRED", async () => {
    const retiredAt = new Date("2026-06-01T09:00:00.000Z");
    const unchanged = makeAsset({ status: "RETIRED", retiredAt });
    prismaMock.asset.findFirst
      .mockResolvedValueOnce(unchanged as any)
      .mockResolvedValueOnce(unchanged as any);

    const response = await request(app)
      .patch("/api/it/assets/" + assetId)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "RETIRED",
      });

    expect(response.status).toBe(200);
    expect(response.body.data.retiredAt).toBe(retiredAt.toISOString());
    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("mantiene el conflicto de versión aunque los valores enviados sean iguales", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({ updatedAt: nextVersion }) as any,
    );

    const response = await request(app)
      .patch("/api/it/assets/" + assetId)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        assetTag: "NB-0001",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ASSET_VERSION_CONFLICT");
    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    ["assetTag", "NB-9000"],
    ["secretsRef", "vault:item:123"],
    ["purchaseItemId", "cmh333aaaaaaaaaaaaaaaaaaa"],
  ])(
    "impide que AGENT modifique el campo administrativo %s",
    async (field, value) => {
      prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);

      const response = await request(app)
        .patch("/api/it/assets/" + assetId)
        .set(auth("AGENT"))
        .send({
          expectedUpdatedAt: version.toISOString(),
          [field]: value,
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
      expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
    },
  );

  it("devuelve conflicto si expectedUpdatedAt quedó desactualizado", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({ updatedAt: nextVersion }) as any,
    );

    const response = await request(app)
      .patch("/api/it/assets/" + assetId)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        brand: "Dell",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ASSET_VERSION_CONFLICT");
    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
  });

  it("detecta una carrera entre lectura y escritura con la precondición SQL", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.asset.updateMany.mockResolvedValueOnce({ count: 0 } as any);

    const response = await request(app)
      .patch("/api/it/assets/" + assetId)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        brand: "Dell",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ASSET_VERSION_CONFLICT");
    expect(prismaMock.asset.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: assetId,
          isActive: true,
          updatedAt: version,
        },
      }),
    );
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("audita sólo cambios reales, con IDs y marcadores sensibles redactados", async () => {
    prismaMock.asset.findFirst
      .mockResolvedValueOnce(makeAsset() as any)
      .mockResolvedValueOnce(
        makeAsset({
          brand: "Dell",
          updatedAt: nextVersion,
        }) as any,
      );
    prismaMock.asset.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .patch("/api/it/assets/" + assetId)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        brand: "Dell",
        model: "ThinkPad T14",
        notes: "nota confidencial",
        specs: { cpu: "Ryzen secreto" },
        secretsRef: "vault:item:123",
        purchaseItemId: "cmh333aaaaaaaaaaaaaaaaaaa",
      });

    expect(response.status).toBe(200);
    const auditMeta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data
      .meta;
    expect(auditMeta).toEqual({
      fields: ["brand", "specs", "notes", "secretsRef", "purchaseItemId"],
      changes: {
        brand: { from: "Lenovo", to: "Dell" },
        specs: { changed: true, redacted: true },
        notes: { changed: true, redacted: true },
        secretsRef: { changed: true, redacted: true },
        purchaseItemId: {
          from: null,
          to: "cmh333aaaaaaaaaaaaaaaaaaa",
        },
      },
    });
    const serialized = JSON.stringify(auditMeta);
    expect(serialized).not.toContain("nota confidencial");
    expect(serialized).not.toContain("Ryzen secreto");
    expect(serialized).not.toContain("vault:item:123");
    expect(serialized).toContain("cmh333aaaaaaaaaaaaaaaaaaa");
    expect(serialized).not.toContain("model");
    expect(serialized).not.toContain("expectedUpdatedAt");
  });

  it("impide pasar a ASSIGNED por PATCH", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);

    const response = await request(app)
      .patch("/api/it/assets/" + assetId)
      .set(auth("ADMIN"))
      .send({
        status: "ASSIGNED",
        expectedUpdatedAt: version.toISOString(),
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("ASSET_STATUS_MANAGED");
    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
  });

  it("devuelve el activo, cierra el historial y audita sin returnNote", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(
      makeAsset({
        status: "ASSIGNED",
        assignedPersonId: personId,
      }) as any,
    );
    prismaMock.assetAssignment.findFirst.mockResolvedValueOnce({
      id: assignmentId,
      personId,
      departmentId: null,
    } as any);
    prismaMock.assetAssignment.updateMany.mockResolvedValueOnce({
      count: 1,
    } as any);
    prismaMock.asset.update.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/it/assets/" + assetId + "/return")
      .set(auth("ADMIN"))
      .send({ returnNote: "detalle privado de la devolución" });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("IN_STOCK");
    expect(prismaMock.assetAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: assignmentId, endAt: null },
        data: expect.objectContaining({
          endAt: expect.any(Date),
          returnNote: "detalle privado de la devolución",
        }),
      }),
    );
    const auditMeta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data
      .meta;
    expect(auditMeta.fields).toContain("returnNote");
    expect(JSON.stringify(auditMeta)).not.toContain(
      "detalle privado de la devolución",
    );
  });
});
