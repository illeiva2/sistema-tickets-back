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
import { readFileSync } from "node:fs";
import type { DeepMockProxy } from "vitest-mock-extended";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const lineId = "cmh111aaaaaaaaaaaaaaaaaaa";
const personId = "cmh222aaaaaaaaaaaaaaaaaaa";
const assetId = "cmh333aaaaaaaaaaaaaaaaaaa";
const assignmentId = "cmh444aaaaaaaaaaaaaaaaaaa";
const simChangeId = "cmh555aaaaaaaaaaaaaaaaaaa";
const version = new Date("2026-07-14T10:00:00.000Z");
const nextVersion = new Date("2026-07-14T10:01:00.000Z");

const auth = (role: "USER" | "AGENT" | "ADMIN") => ({
  Authorization: `Bearer ${signAccessToken({ role })}`,
});

const makeLine = (overrides: Record<string, any> = {}) => ({
  id: lineId,
  phoneNumber: "+5493415551234",
  carrier: "CLARO",
  carrierOther: null,
  planName: "Empresa 10 GB",
  dataAllowanceGb: 10,
  monthlyCost: new Prisma.Decimal("10000.00"),
  currency: "ARS",
  simIccid: "8954100000000000001",
  status: "AVAILABLE",
  contractEndsAt: null,
  notes: null,
  holderId: null,
  assetId: null,
  isActive: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: version,
  holder: null,
  asset: null,
  assignments: [],
  simChanges: [],
  ...overrides,
});

describe("API de líneas celulares IT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => {
      if (typeof work === "function") return work(prismaMock);
      return Promise.all(work);
    });
  });

  it("requiere autenticación y rechaza USER en todo el módulo", async () => {
    expect((await request(app).get("/api/it/phone-lines")).status).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/it/phone-lines")
          .set(auth("USER"))
      ).status,
    ).toBe(403);
  });

  it("permite a AGENT hacer una baja lógica", async () => {
    prismaMock.phoneLine.findFirst.mockResolvedValueOnce(makeLine() as any);
    prismaMock.phoneLineAssignment.findFirst.mockResolvedValueOnce(null);
    prismaMock.phoneLine.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .delete(`/api/it/phone-lines/${lineId}`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString() });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ id: lineId, deleted: true });
    expect(prismaMock.phoneLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAt: version }),
        data: expect.objectContaining({
          isActive: false,
          status: "CANCELLED",
          pukCipherText: null,
          pukIv: null,
          pukAuthTag: null,
        }),
      }),
    );
  });

  it("lista con filtros y paginación usando un select que nunca pide PUK", async () => {
    prismaMock.phoneLine.findMany.mockResolvedValueOnce([
      { ...makeLine(), _count: { assignments: 2, simChanges: 1 } },
    ] as any);
    prismaMock.phoneLine.count.mockResolvedValueOnce(11);

    const response = await request(app)
      .get(
        `/api/it/phone-lines?q=341&status=AVAILABLE&carrier=CLARO&holderId=${personId}&assetId=${assetId}&page=2&pageSize=10`,
      )
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    expect(response.body.data.items[0].assignmentsCount).toBe(2);
    expect(response.body.data.items[0].simChangesCount).toBe(1);
    expect(response.body.data.pagination).toEqual({
      page: 2,
      pageSize: 10,
      total: 11,
      totalPages: 2,
    });
    const query = prismaMock.phoneLine.findMany.mock.calls[0][0] as any;
    const serializedSelect = JSON.stringify(query.select);
    expect(serializedSelect).not.toContain("pukCipherText");
    expect(serializedSelect).not.toContain("pukIv");
    expect(serializedSelect).not.toContain("pukAuthTag");
    expect(serializedSelect).not.toContain("pukKeyVersion");
    expect(serializedSelect).not.toContain('"notes":true');
    expect(query.where).toEqual(
      expect.objectContaining({
        status: "AVAILABLE",
        carrier: "CLARO",
        holderId: personId,
        assetId,
      }),
    );
  });

  it("devuelve detalle seguro con titular, activo e historiales", async () => {
    prismaMock.phoneLine.findFirst.mockResolvedValueOnce(
      makeLine({
        holderId: personId,
        assetId,
        status: "ACTIVE",
        holder: { id: personId, firstName: "Ana", lastName: "Pérez" },
        asset: { id: assetId, assetTag: "CE-0001", type: "PHONE" },
      }) as any,
    );

    const response = await request(app)
      .get(`/api/it/phone-lines/${lineId}`)
      .set(auth("ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.holder.id).toBe(personId);
    const select = (prismaMock.phoneLine.findFirst.mock.calls[0][0] as any).select;
    expect(JSON.stringify(select)).not.toContain("pukCipherText");
  });

  it("crea una línea con GB opcionales y audita campos sensibles redactados", async () => {
    prismaMock.phoneLine.create.mockResolvedValueOnce(makeLine() as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/it/phone-lines")
      .set(auth("AGENT"))
      .send({
        phoneNumber: "+5493415551234",
        carrier: "CLARO",
        planName: "Empresa 10 GB",
        dataAllowanceGb: 10,
        monthlyCost: "10000.00",
        currency: "ARS",
        simIccid: "8954100000000000001",
      });

    expect(response.status).toBe(201);
    expect(prismaMock.phoneLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dataAllowanceGb: 10 }),
      }),
    );
    const meta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data.meta;
    expect(meta.changes.phoneNumber).toEqual({ changed: true, redacted: true });
    expect(meta.changes.simIccid).toEqual({ changed: true, redacted: true });
    expect(JSON.stringify(meta)).not.toContain("+5493415551234");
    expect(JSON.stringify(meta)).not.toContain("8954100000000000001");
  });

  it("reactiva el mismo registro cancelado si la operadora recicla el número", async () => {
    const cancelled = makeLine({
      status: "CANCELLED",
      isActive: false,
      deletedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    prismaMock.phoneLine.findUnique.mockResolvedValueOnce(cancelled as any);
    prismaMock.phoneLineAssignment.findFirst.mockResolvedValueOnce(null);
    prismaMock.phoneLine.update.mockResolvedValueOnce(
      makeLine({ updatedAt: nextVersion }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/it/phone-lines")
      .set(auth("AGENT"))
      .send({ phoneNumber: "+5493415551234", carrier: "CLARO" });

    expect(response.status).toBe(201);
    expect(prismaMock.phoneLine.create).not.toHaveBeenCalled();
    expect(prismaMock.phoneLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: lineId },
        data: expect.objectContaining({
          isActive: true,
          deletedAt: null,
          pukCipherText: null,
          pukIv: null,
          pukAuthTag: null,
        }),
      }),
    );
    expect(
      (prismaMock.auditLog.create.mock.calls[0][0] as any).data.action,
    ).toBe("reactivated");
  });

  it("valida operadora OTHER y rechaza campos desconocidos", async () => {
    const missingCarrier = await request(app)
      .post("/api/it/phone-lines")
      .set(auth("AGENT"))
      .send({ phoneNumber: "+5493415551234", carrier: "OTHER" });
    expect(missingCarrier.status).toBe(400);

    const unknown = await request(app)
      .post("/api/it/phone-lines")
      .set(auth("AGENT"))
      .send({
        phoneNumber: "+5493415551234",
        carrier: "CLARO",
        pukEncrypted: "no permitido",
      });
    expect(unknown.status).toBe(400);
    expect(prismaMock.phoneLine.create).not.toHaveBeenCalled();
  });

  it("edita una línea ACTIVE sin cambiar su status y evita un falso cambio Decimal", async () => {
    const active = makeLine({
      holderId: personId,
      status: "ACTIVE",
      monthlyCost: new Prisma.Decimal("10000"),
    });
    prismaMock.phoneLine.findFirst
      .mockResolvedValueOnce(active as any)
      .mockResolvedValueOnce(active as any);

    const response = await request(app)
      .patch(`/api/it/phone-lines/${lineId}`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "ACTIVE",
        monthlyCost: "10000.00",
      });

    expect(response.status).toBe(200);
    expect(prismaMock.phoneLine.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("aplica PATCH con CAS y exige el endpoint de chip para cambiar ICCID", async () => {
    prismaMock.phoneLine.findFirst.mockResolvedValueOnce(makeLine() as any);
    const simBypass = await request(app)
      .patch(`/api/it/phone-lines/${lineId}`)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        simIccid: "8954100000000000002",
      });
    expect(simBypass.status).toBe(409);
    expect(simBypass.body.error.code).toBe("PHONE_LINE_SIM_CHANGE_REQUIRED");

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
    prismaMock.phoneLine.findFirst.mockResolvedValueOnce(makeLine() as any);
    prismaMock.phoneLine.updateMany.mockResolvedValueOnce({ count: 0 } as any);
    const raced = await request(app)
      .patch(`/api/it/phone-lines/${lineId}`)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        planName: "Plan nuevo",
      });
    expect(raced.status).toBe(409);
    expect(raced.body.error.code).toBe("PHONE_LINE_VERSION_CONFLICT");
  });

  it("asigna atómicamente a persona y celular, con auditoría sin nota", async () => {
    prismaMock.phoneLine.findFirst
      .mockResolvedValueOnce(makeLine() as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        makeLine({ holderId: personId, assetId, status: "ACTIVE" }) as any,
      );
    prismaMock.phoneLineAssignment.findFirst.mockResolvedValueOnce(null);
    prismaMock.person.findFirst.mockResolvedValueOnce({ id: personId } as any);
    prismaMock.asset.findFirst.mockResolvedValueOnce({
      id: assetId,
      assignedPersonId: personId,
    } as any);
    prismaMock.phoneLineAssignment.create.mockResolvedValueOnce({
      id: assignmentId,
    } as any);
    prismaMock.phoneLine.update.mockResolvedValueOnce({} as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post(`/api/it/phone-lines/${lineId}/assign`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        personId,
        assetId,
        note: "detalle privado",
      });

    expect(response.status).toBe(200);
    expect(prismaMock.phoneLineAssignment.create).toHaveBeenCalled();
    expect(prismaMock.phoneLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { holderId: personId, assetId, status: "ACTIVE" },
      }),
    );
    const meta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data.meta;
    expect(meta.noteRedacted).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("detalle privado");
  });

  it("devuelve la línea cerrando exactamente la asignación abierta", async () => {
    prismaMock.phoneLine.findFirst
      .mockResolvedValueOnce(
        makeLine({ holderId: personId, assetId, status: "ACTIVE" }) as any,
      )
      .mockResolvedValueOnce(makeLine({ updatedAt: nextVersion }) as any);
    prismaMock.phoneLineAssignment.findFirst.mockResolvedValueOnce({
      id: assignmentId,
      personId,
      assetId,
    } as any);
    prismaMock.phoneLineAssignment.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.phoneLine.update.mockResolvedValueOnce({} as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post(`/api/it/phone-lines/${lineId}/return`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        returnNote: "chip devuelto",
      });

    expect(response.status).toBe(200);
    expect(prismaMock.phoneLineAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: assignmentId, returnedAt: null },
        data: expect.objectContaining({ returnNote: "chip devuelto" }),
      }),
    );
    const meta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data.meta;
    expect(meta.returnNoteRedacted).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("chip devuelto");
  });

  it("lista cambios de SIM paginados", async () => {
    prismaMock.phoneLine.findFirst.mockResolvedValueOnce({ id: lineId } as any);
    prismaMock.phoneLineSimChange.findMany.mockResolvedValueOnce([
      { id: simChangeId, phoneLineId: lineId },
    ] as any);
    prismaMock.phoneLineSimChange.count.mockResolvedValueOnce(1);

    const response = await request(app)
      .get(`/api/it/phone-lines/${lineId}/sim-changes?page=1&pageSize=10`)
      .set(auth("AGENT"));
    expect(response.status).toBe(200);
    expect(response.body.data.pagination.total).toBe(1);
  });

  it("registra el cambio de chip y actualiza ICCID en la misma transacción", async () => {
    prismaMock.phoneLine.findFirst
      .mockResolvedValueOnce(makeLine() as any)
      .mockResolvedValueOnce(null);
    prismaMock.phoneLineSimChange.create.mockResolvedValueOnce({
      id: simChangeId,
      phoneLineId: lineId,
      previousIccid: "8954100000000000001",
      newIccid: "8954100000000000002",
      changedAt: nextVersion,
      reason: "Daño",
      notes: "detalle privado",
      createdAt: nextVersion,
      changedBy: { id: "user-1" },
    } as any);
    prismaMock.phoneLine.update.mockResolvedValueOnce({} as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post(`/api/it/phone-lines/${lineId}/sim-changes`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        newIccid: "8954100000000000002",
        changedAt: nextVersion.toISOString(),
        reason: "Daño",
        notes: "detalle privado",
      });

    expect(response.status).toBe(201);
    expect(prismaMock.phoneLine.update).toHaveBeenCalledWith({
      where: { id: lineId },
      data: { simIccid: "8954100000000000002" },
    });
    const audit = (prismaMock.auditLog.create.mock.calls[0][0] as any).data;
    expect(audit.action).toBe("sim_swapped");
    expect(JSON.stringify(audit.meta)).not.toContain("8954100000000000001");
    expect(JSON.stringify(audit.meta)).not.toContain("8954100000000000002");
    expect(JSON.stringify(audit.meta)).not.toContain("detalle privado");
  });

  it("rechaza un cambio de SIM anterior al último evento del historial", async () => {
    prismaMock.phoneLine.findFirst.mockResolvedValueOnce(makeLine() as any);
    prismaMock.phoneLineSimChange.findFirst.mockResolvedValueOnce({
      changedAt: new Date("2026-07-14T11:00:00.000Z"),
    } as any);

    const response = await request(app)
      .post(`/api/it/phone-lines/${lineId}/sim-changes`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        newIccid: "8954100000000000002",
        changedAt: "2026-07-14T10:30:00.000Z",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PHONE_LINE_SIM_DATE_OUT_OF_ORDER");
    expect(prismaMock.phoneLineSimChange.create).not.toHaveBeenCalled();
    expect(prismaMock.phoneLine.update).not.toHaveBeenCalled();
  });

  it("rechaza cambiar por el mismo ICCID y borrar una línea asignada", async () => {
    prismaMock.phoneLine.findFirst.mockResolvedValueOnce(makeLine() as any);
    const unchanged = await request(app)
      .post(`/api/it/phone-lines/${lineId}/sim-changes`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        newIccid: "8954100000000000001",
      });
    expect(unchanged.status).toBe(409);
    expect(unchanged.body.error.code).toBe("PHONE_LINE_SIM_UNCHANGED");

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
    prismaMock.phoneLine.findFirst.mockResolvedValueOnce(
      makeLine({ holderId: personId, status: "ACTIVE" }) as any,
    );
    prismaMock.phoneLineAssignment.findFirst.mockResolvedValueOnce({ id: assignmentId } as any);
    const assignedDelete = await request(app)
      .delete(`/api/it/phone-lines/${lineId}`)
      .set(auth("ADMIN"))
      .send({ expectedUpdatedAt: version.toISOString() });
    expect(assignedDelete.status).toBe(409);
    expect(assignedDelete.body.error.code).toBe("PHONE_LINE_ASSIGNED");
  });

  it.each([
    ["assign", { personId }],
    ["return", { returnNote: "recibida" }],
    ["sim-changes", { newIccid: "8954100000000000002" }],
  ])("rechaza una mutación %s basada en una versión obsoleta", async (path, body) => {
    prismaMock.phoneLine.findFirst.mockResolvedValueOnce(
      makeLine({ updatedAt: nextVersion }) as any,
    );

    const response = await request(app)
      .post(`/api/it/phone-lines/${lineId}/${path}`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString(), ...body });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PHONE_LINE_VERSION_CONFLICT");
    expect(prismaMock.phoneLine.update).not.toHaveBeenCalled();
    expect(prismaMock.phoneLineAssignment.create).not.toHaveBeenCalled();
    expect(prismaMock.phoneLineSimChange.create).not.toHaveBeenCalled();
  });

  it("la migración refuerza GB y una única asignación vigente", () => {
    const sql = readFileSync(
      "prisma/migrations/20260714100000_add_phone_line_operations/migration.sql",
      "utf8",
    );
    expect(sql).toContain("phone_lines_dataAllowanceGb_check");
    expect(sql).toContain('"dataAllowanceGb" >= 0');
    expect(sql).toContain("phone_line_assignments_one_open_per_line_key");
    expect(sql).toMatch(/WHERE\s+"returnedAt"\s+IS\s+NULL/i);
    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toMatch(/HAVING\s+COUNT\(\*\)\s*>\s*1/i);
    expect(sql.indexOf("HAVING COUNT(*) > 1")).toBeLessThan(
      sql.indexOf('ALTER TABLE "phone_lines"'),
    );
  });
});
