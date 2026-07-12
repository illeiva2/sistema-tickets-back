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
  secretsRef: null,
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
  updatedAt: new Date(),
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
    expect(prismaMock.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: assetId, isActive: true },
        include: expect.objectContaining({
          assignedPerson: expect.any(Object),
          assignedDepartment: expect.any(Object),
          createdBy: expect.any(Object),
          assignments: expect.objectContaining({
            orderBy: { startAt: "desc" },
          }),
        }),
      }),
    );
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
        notes: "dato-que-no-debe-ir-al-audit",
      });

    expect(response.status).toBe(201);
    expect(response.body.data.assetTag).toBe("NB-0003");
    expect(prismaMock.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetTag: "NB-0003",
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
    expect(JSON.stringify(auditMeta)).not.toContain(
      "dato-que-no-debe-ir-al-audit",
    );
    expect(JSON.stringify(auditMeta)).not.toContain("Core i7");
  });

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
    prismaMock.asset.update.mockResolvedValueOnce(
      makeAsset({
        status: "ASSIGNED",
        assignedPersonId: personId,
        brand: "Lenovo actualizado",
      }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .patch("/api/it/assets/" + assetId)
      .set(auth("AGENT"))
      .send({
        assetTag: "NB-0001",
        status: "ASSIGNED",
        brand: "Lenovo actualizado",
      });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("ASSIGNED");
    expect(prismaMock.assetAssignment.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assetTag: undefined }),
      }),
    );
  });

  it("impide pasar a ASSIGNED por PATCH", async () => {
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);

    const response = await request(app)
      .patch("/api/it/assets/" + assetId)
      .set(auth("ADMIN"))
      .send({ status: "ASSIGNED" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("ASSET_STATUS_MANAGED");
    expect(prismaMock.asset.update).not.toHaveBeenCalled();
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
