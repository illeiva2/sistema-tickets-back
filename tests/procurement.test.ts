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

import { Prisma, type PrismaClient } from "@prisma/client";
import type { DeepMockProxy } from "vitest-mock-extended";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const supplierId = "cmh555aaaaaaaaaaaaaaaaaaa";
const purchaseId = "cmh888aaaaaaaaaaaaaaaaaaa";
const itemId = "cmh999aaaaaaaaaaaaaaaaaaa";
const version = new Date("2026-07-12T12:00:00.000Z");
const nextVersion = new Date("2026-07-12T12:01:00.000Z");

const auth = (
  role: "USER" | "AGENT" | "ADMIN",
  id = "user-1",
) => ({
  Authorization: `Bearer ${signAccessToken({ role, id })}`,
});

const makeSupplier = (overrides: Record<string, any> = {}) => ({
  id: supplierId,
  name: "Tecnología Sur",
  cuit: "30712345678",
  contactName: "Contacto laboral",
  email: "ventas@tecnologiasur.test",
  phone: "+54 11 5555-0000",
  website: "https://tecnologiasur.test",
  address: "Dirección comercial",
  categories: ["hardware"],
  notes: "Condición comercial privada",
  isActive: true,
  deletedAt: null,
  createdAt: new Date("2026-07-01T10:00:00.000Z"),
  updatedAt: version,
  purchases: [],
  ...overrides,
});

const makePurchase = (overrides: Record<string, any> = {}) => ({
  id: purchaseId,
  purchaseNumber: 42,
  status: "REQUESTED",
  supplierId,
  supplier: {
    id: supplierId,
    name: "Tecnología Sur",
    categories: ["hardware"],
    isActive: true,
  },
  currency: "ARS",
  totalAmount: new Prisma.Decimal("250000.50"),
  exchangeRate: null,
  justification: "Renovación por fin de vida útil",
  invoiceNumber: null,
  notes: "Información interna",
  requestedById: "user-1",
  requestedBy: { id: "user-1", name: "IT Agent" },
  authorizedById: null,
  authorizedBy: null,
  authorizedAt: null,
  orderedAt: null,
  receivedAt: null,
  createdAt: new Date("2026-07-12T11:00:00.000Z"),
  updatedAt: version,
  items: [
    {
      id: itemId,
      description: "Notebook empresarial",
      quantity: 2,
      unitPrice: new Prisma.Decimal("125000.25"),
      createdAt: new Date(),
      updatedAt: new Date(),
      assets: [],
      _count: { assets: 0 },
    },
  ],
  ...overrides,
});

describe("API de proveedores IT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
  });

  it("requiere AGENT/ADMIN y valida filtros estrictos", async () => {
    expect((await request(app).get("/api/it/suppliers")).status).toBe(401);
    expect(
      (await request(app).get("/api/it/suppliers").set(auth("USER"))).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/it/suppliers?unknown=true")
          .set(auth("AGENT"))
      ).status,
    ).toBe(400);
  });

  it("lista datos minimizados, filtros y conteo de compras abiertas", async () => {
    prismaMock.supplier.findMany.mockResolvedValueOnce([
      {
        id: supplierId,
        name: "Tecnología Sur",
        cuit: "30712345678",
        contactName: "Contacto laboral",
        email: "ventas@tecnologiasur.test",
        phone: "+54 11 5555-0000",
        categories: ["hardware"],
        isActive: true,
        createdAt: new Date(),
        updatedAt: version,
        _count: { purchases: 2 },
      },
    ] as any);
    prismaMock.supplier.count.mockResolvedValueOnce(1);
    prismaMock.purchase.groupBy.mockResolvedValueOnce([
      { supplierId, _count: { _all: 2 } },
    ] as any);

    const response = await request(app)
      .get("/api/it/suppliers?q=tec&category=hardware&isActive=true&pageSize=10")
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    expect(response.body.data.items[0].activePurchasesCount).toBe(2);
    expect(response.body.data.items[0].notes).toBeUndefined();
    expect(response.body.data.items[0].email).toBe("ventas@tecnologiasur.test");
    expect(prismaMock.supplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    );
  });

  it("crea atómicamente, normaliza CUIT/email y no audita contacto ni notas", async () => {
    prismaMock.supplier.findFirst.mockResolvedValueOnce(null);
    prismaMock.supplier.create.mockResolvedValueOnce(makeSupplier() as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/it/suppliers")
      .set(auth("AGENT"))
      .send({
        name: "Tecnología Sur",
        cuit: "30-71234567-8",
        contactName: "Contacto laboral",
        email: "VENTAS@TECNOLOGIASUR.TEST",
        phone: "+54 11 5555-0000",
        website: "https://tecnologiasur.test",
        address: "Dirección comercial",
        categories: ["hardware", "hardware"],
        notes: "Condición comercial privada",
      });

    expect(response.status).toBe(201);
    expect(prismaMock.supplier.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cuit: "30712345678",
          email: "ventas@tecnologiasur.test",
          categories: ["hardware"],
        }),
      }),
    );
    const audit = (prismaMock.auditLog.create.mock.calls[0][0] as any).data.meta;
    expect(JSON.stringify(audit)).not.toContain("Contacto laboral");
    expect(JSON.stringify(audit)).not.toContain("Condición comercial privada");
  });

  it("detecta nombre duplicado sin distinguir mayúsculas", async () => {
    prismaMock.supplier.findFirst.mockResolvedValueOnce({ id: "other" } as any);
    const response = await request(app)
      .post("/api/it/suppliers")
      .set(auth("AGENT"))
      .send({ name: "TECNOLOGÍA SUR", categories: [] });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("SUPPLIER_NAME_EXISTS");
    expect(prismaMock.supplier.create).not.toHaveBeenCalled();
  });

  it("bloquea desactivación con compras abiertas", async () => {
    prismaMock.supplier.findFirst.mockResolvedValueOnce(makeSupplier() as any);
    prismaMock.purchase.count.mockResolvedValueOnce(2);
    const response = await request(app)
      .patch(`/api/it/suppliers/${supplierId}`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString(), isActive: false });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("SUPPLIER_HAS_OPEN_PURCHASES");
    expect(prismaMock.supplier.updateMany).not.toHaveBeenCalled();
  });

  it("protege la edición concurrente y redacta campos sensibles", async () => {
    prismaMock.supplier.findFirst
      .mockResolvedValueOnce(makeSupplier() as any)
      .mockResolvedValueOnce(
        makeSupplier({ contactName: "Nuevo contacto", updatedAt: nextVersion }) as any,
      );
    prismaMock.supplier.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .patch(`/api/it/suppliers/${supplierId}`)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        contactName: "Nuevo contacto",
      });

    expect(response.status).toBe(200);
    const audit = (prismaMock.auditLog.create.mock.calls[0][0] as any).data.meta;
    expect(audit.changes.contactName).toEqual({ changed: true, redacted: true });
    expect(JSON.stringify(audit)).not.toContain("Nuevo contacto");
  });
});

describe("API de compras IT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
  });

  it("declara lookups antes de :id y restringe el módulo", async () => {
    prismaMock.supplier.findMany.mockResolvedValueOnce([] as any);
    const lookup = await request(app)
      .get("/api/it/purchases/lookups")
      .set(auth("AGENT"));
    expect(lookup.status).toBe(200);
    expect(lookup.body.data).toEqual({ suppliers: [] });
    expect(
      (await request(app).get("/api/it/purchases").set(auth("USER"))).status,
    ).toBe(403);
  });

  it("lista costos como strings y expone linkedAssetsCount, no _count", async () => {
    prismaMock.purchase.findMany.mockResolvedValueOnce([makePurchase()] as any);
    prismaMock.purchase.count.mockResolvedValueOnce(1);
    const response = await request(app)
      .get("/api/it/purchases?status=REQUESTED&currency=ARS")
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    const purchase = response.body.data.items[0];
    expect(purchase.totalAmount).toBe("250000.5");
    expect(purchase.items[0].unitPrice).toBe("125000.25");
    expect(purchase.items[0].linkedAssetsCount).toBe(0);
    expect(purchase.items[0]._count).toBeUndefined();
    expect(purchase.justification).toBe("Renovación por fin de vida útil");
    expect(purchase.notes).toBeUndefined();
  });

  it("trata una búsqueda numérica enorme como texto sin desbordar purchaseNumber", async () => {
    prismaMock.purchase.findMany.mockResolvedValueOnce([] as any);
    prismaMock.purchase.count.mockResolvedValueOnce(0);
    const q = "9".repeat(200);
    const response = await request(app)
      .get(`/api/it/purchases?q=${q}`)
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    const where = (prismaMock.purchase.findMany.mock.calls[0][0] as any).where;
    expect(where.OR).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ purchaseNumber: expect.anything() })]),
    );
  });

  it("crea REQUESTED, recalcula Decimal y audita sin textos ni ítems", async () => {
    prismaMock.supplier.findFirst.mockResolvedValueOnce({ id: supplierId } as any);
    prismaMock.purchase.create.mockResolvedValueOnce(
      makePurchase({ totalAmount: new Prisma.Decimal("250000.50") }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    const response = await request(app)
      .post("/api/it/purchases")
      .set(auth("AGENT"))
      .send({
        supplierId,
        currency: "ARS",
        justification: "Renovación por fin de vida útil",
        notes: "Información interna",
        items: [
          { description: "Notebook", quantity: 2, unitPrice: "125000.25" },
        ],
      });

    expect(response.status).toBe(201);
    const data = (prismaMock.purchase.create.mock.calls[0][0] as any).data;
    expect(data.status).toBeUndefined();
    expect(data.totalAmount.toString()).toBe("250000.5");
    const audit = (prismaMock.auditLog.create.mock.calls[0][0] as any).data.meta;
    expect(audit.totalAmount).toBe("250000.5");
    expect(JSON.stringify(audit)).not.toContain("Renovación");
    expect(JSON.stringify(audit)).not.toContain("Notebook");
  });

  it("rechaza compra vacía, payload extra y total fuera de Decimal(14,2)", async () => {
    const empty = await request(app)
      .post("/api/it/purchases")
      .set(auth("AGENT"))
      .send({ currency: "ARS", justification: "Necesaria", items: [] });
    expect(empty.status).toBe(400);

    const extra = await request(app)
      .post("/api/it/purchases")
      .set(auth("AGENT"))
      .send({
        currency: "ARS",
        justification: "Necesaria",
        items: [{ description: "Equipo", quantity: 1, unitPrice: "10.00" }],
        status: "APPROVED",
      });
    expect(extra.status).toBe(400);

    const tooLarge = await request(app)
      .post("/api/it/purchases")
      .set(auth("AGENT"))
      .send({
        currency: "ARS",
        justification: "Necesaria",
        items: [
          { description: "Equipo", quantity: 2, unitPrice: "999999999999.99" },
        ],
      });
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error.code).toBe("PURCHASE_TOTAL_TOO_LARGE");
  });

  it("sólo el solicitante puede editar REQUESTED", async () => {
    prismaMock.purchase.findUnique.mockResolvedValueOnce(makePurchase() as any);
    const response = await request(app)
      .patch(`/api/it/purchases/${purchaseId}`)
      .set(auth("ADMIN", "admin-1"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        invoiceNumber: "A-0001",
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PURCHASE_REQUESTER_EDIT_REQUIRED");
    expect(prismaMock.purchase.updateMany).not.toHaveBeenCalled();
  });

  it("después de aprobar bloquea términos pero permite corregir factura", async () => {
    prismaMock.purchase.findUnique.mockResolvedValueOnce(
      makePurchase({ status: "APPROVED" }) as any,
    );
    const blocked = await request(app)
      .patch(`/api/it/purchases/${purchaseId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        currency: "USD",
      });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("PURCHASE_FIELDS_LOCKED");

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => work(prismaMock));
    prismaMock.purchase.findUnique
      .mockResolvedValueOnce(makePurchase({ status: "APPROVED" }) as any)
      .mockResolvedValueOnce(
        makePurchase({ status: "APPROVED", invoiceNumber: "A-0001" }) as any,
      );
    prismaMock.purchase.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    const corrected = await request(app)
      .patch(`/api/it/purchases/${purchaseId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        invoiceNumber: "A-0001",
      });
    expect(corrected.status).toBe(200);
  });

  it("aprueba sólo ADMIN activo, distinto del solicitante, con proveedor e ítems consistentes", async () => {
    prismaMock.purchase.findUnique
      .mockResolvedValueOnce(makePurchase() as any)
      .mockResolvedValueOnce(makePurchase({ status: "APPROVED" }) as any);
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: "admin-1" } as any);
    prismaMock.supplier.findFirst.mockResolvedValueOnce({ id: supplierId } as any);
    prismaMock.purchase.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post(`/api/it/purchases/${purchaseId}/approve`)
      .set(auth("ADMIN", "admin-1"))
      .send({ expectedUpdatedAt: version.toISOString() });

    expect(response.status).toBe(200);
    expect(prismaMock.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: "ADMIN", isActive: true }),
      }),
    );
    expect(prismaMock.purchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPROVED",
          authorizedById: "admin-1",
        }),
      }),
    );
  });

  it("impide autoaprobación y detecta total inconsistente", async () => {
    prismaMock.purchase.findUnique.mockResolvedValueOnce(makePurchase() as any);
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: "user-1" } as any);
    const self = await request(app)
      .post(`/api/it/purchases/${purchaseId}/approve`)
      .set(auth("ADMIN", "user-1"))
      .send({ expectedUpdatedAt: version.toISOString() });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("PURCHASE_SELF_APPROVAL_FORBIDDEN");

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => work(prismaMock));
    prismaMock.purchase.findUnique.mockResolvedValueOnce(
      makePurchase({ totalAmount: new Prisma.Decimal("1.00") }) as any,
    );
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: "admin-1" } as any);
    prismaMock.supplier.findFirst.mockResolvedValueOnce({ id: supplierId } as any);
    const inconsistent = await request(app)
      .post(`/api/it/purchases/${purchaseId}/approve`)
      .set(auth("ADMIN", "admin-1"))
      .send({ expectedUpdatedAt: version.toISOString() });
    expect(inconsistent.status).toBe(409);
    expect(inconsistent.body.error.code).toBe("PURCHASE_TOTAL_INCONSISTENT");
  });

  it("revalida proveedor al ordenar y permite recibir aunque luego esté inactivo", async () => {
    prismaMock.purchase.findUnique.mockResolvedValueOnce(
      makePurchase({ status: "APPROVED" }) as any,
    );
    prismaMock.supplier.findFirst.mockResolvedValueOnce(null);
    const order = await request(app)
      .post(`/api/it/purchases/${purchaseId}/order`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString() });
    expect(order.status).toBe(400);
    expect(order.body.error.code).toBe("SUPPLIER_NOT_AVAILABLE");

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => work(prismaMock));
    prismaMock.purchase.findUnique
      .mockResolvedValueOnce(makePurchase({ status: "ORDERED" }) as any)
      .mockResolvedValueOnce(makePurchase({ status: "RECEIVED" }) as any);
    prismaMock.purchase.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    const receive = await request(app)
      .post(`/api/it/purchases/${purchaseId}/receive`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString() });
    expect(receive.status).toBe(200);
    expect(prismaMock.supplier.findFirst).not.toHaveBeenCalled();
  });

  it("AGENT cancela REQUESTED, pero sólo ADMIN puede cancelar después", async () => {
    prismaMock.purchase.findUnique.mockResolvedValueOnce(
      makePurchase({ status: "APPROVED" }) as any,
    );
    const forbidden = await request(app)
      .post(`/api/it/purchases/${purchaseId}/cancel`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString(), reason: "Ya no se necesita" });
    expect(forbidden.status).toBe(403);

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => work(prismaMock));
    prismaMock.purchase.findUnique
      .mockResolvedValueOnce(makePurchase({ status: "APPROVED" }) as any)
      .mockResolvedValueOnce(makePurchase({ status: "CANCELLED" }) as any);
    prismaMock.user.findFirst.mockResolvedValueOnce({ id: "admin-1" } as any);
    prismaMock.purchase.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    const cancelled = await request(app)
      .post(`/api/it/purchases/${purchaseId}/cancel`)
      .set(auth("ADMIN", "admin-1"))
      .send({ expectedUpdatedAt: version.toISOString(), reason: "Cambio de plan" });
    expect(cancelled.status).toBe(200);
    expect(prismaMock.purchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notes: expect.stringContaining("Motivo: Cambio de plan"),
        }),
      }),
    );
    const audit = (prismaMock.auditLog.create.mock.calls[0][0] as any).data.meta;
    expect(JSON.stringify(audit)).not.toContain("Cambio de plan");
  });

  it("rechaza versiones viejas y cuerpos extra en transiciones", async () => {
    prismaMock.purchase.findUnique.mockResolvedValueOnce(
      makePurchase({ status: "ORDERED", updatedAt: nextVersion }) as any,
    );
    const stale = await request(app)
      .post(`/api/it/purchases/${purchaseId}/receive`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString() });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("PURCHASE_VERSION_CONFLICT");

    const extra = await request(app)
      .post(`/api/it/purchases/${purchaseId}/receive`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString(), invoiceNumber: "X" });
    expect(extra.status).toBe(400);
  });
});
