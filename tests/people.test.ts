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
import PeopleService from "../src/services/people.service";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const personId = "cmh111aaaaaaaaaaaaaaaaaaa";
const departmentId = "cmh222aaaaaaaaaaaaaaaaaaa";
const assetId = "cmh333aaaaaaaaaaaaaaaaaaa";
const version = new Date("2026-07-12T12:00:00.000Z");
const nextVersion = new Date("2026-07-12T12:01:00.000Z");

const auth = (role: "USER" | "AGENT" | "ADMIN") => ({
  Authorization: `Bearer ${signAccessToken({ role })}`,
});

const makePerson = (overrides: Record<string, any> = {}) => ({
  id: personId,
  employeeNumber: "LEG-001",
  firstName: "Ana",
  lastName: "Pérez",
  jobTitle: "Analista",
  workEmail: "ana@empresa.com",
  workPhone: "+54 341 555-0001",
  status: "ACTIVE",
  startDate: new Date("2025-01-15T00:00:00.000Z"),
  endDate: null,
  departmentId,
  notes: null,
  isActive: true,
  createdAt: new Date("2025-01-10T00:00:00.000Z"),
  updatedAt: version,
  department: {
    id: departmentId,
    name: "Sistemas",
    slug: "sistemas",
    color: "#00FFAA",
    icon: "cpu",
  },
  assignedAssets: [],
  phoneLines: [],
  assetAssignments: [],
  phoneLineAssignments: [],
  ...overrides,
});

const uniqueError = (field: string) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.15.0",
    meta: { target: [field] },
  });

const foreignKeyError = (fieldName: string) =>
  new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
    code: "P2003",
    clientVersion: "6.15.0",
    meta: { field_name: fieldName },
  });

describe("API de personal IT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => {
      if (typeof work === "function") return work(prismaMock);
      return Promise.all(work);
    });
  });

  it("requiere autenticación y rechaza USER", async () => {
    const unauthenticated = await request(app).get("/api/it/people");
    expect(unauthenticated.status).toBe(401);

    const forbidden = await request(app)
      .get("/api/it/people")
      .set(auth("USER"));
    expect(forbidden.status).toBe(403);
  });

  it("lista con filtros, paginación y preview seguro de activos", async () => {
    prismaMock.person.findMany.mockResolvedValueOnce([
      {
        ...makePerson(),
        notes: undefined,
        assignedAssets: [
          {
            id: assetId,
            assetTag: "NB-0001",
            type: "NOTEBOOK",
            status: "ASSIGNED",
            brand: "Lenovo",
            model: "T14",
            serialNumber: "SER-1",
            location: "Rosario",
            assignedDepartmentId: departmentId,
            updatedAt: version,
          },
        ],
        _count: { assignedAssets: 1 },
      },
    ] as any);
    prismaMock.person.count.mockResolvedValueOnce(11);

    const response = await request(app)
      .get(
        "/api/it/people?q=ana&status=ACTIVE&departmentId=" +
          departmentId +
          "&page=2&pageSize=10",
      )
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    expect(response.body.data.items[0].assignedAssetsCount).toBe(1);
    expect(response.body.data.items[0].assignedAssetsPreview).toHaveLength(1);
    expect(response.body.data.items[0].notes).toBeUndefined();
    expect(response.body.data.pagination).toEqual({
      page: 2,
      pageSize: 10,
      total: 11,
      totalPages: 2,
    });
    expect(prismaMock.person.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          status: "ACTIVE",
          departmentId,
          OR: expect.any(Array),
        }),
        skip: 10,
        take: 10,
      }),
    );
    const select = (prismaMock.person.findMany.mock.calls[0][0] as any).select;
    expect(select.notes).toBeUndefined();
    expect(select.userId).toBeUndefined();
    expect(select.assignedAssets.select.secretsRef).toBeUndefined();
  });

  it("devuelve detalle con tenencias e historiales mediante selects explícitos", async () => {
    prismaMock.person.findFirst.mockResolvedValueOnce(
      makePerson({
        assignedAssets: [{ id: assetId, assetTag: "NB-0001" }],
        assetAssignments: [{ id: "history-1", assetId }],
        phoneLines: [{ id: "line-1", phoneNumber: "+5493415550001" }],
        phoneLineAssignments: [{ id: "line-history-1" }],
      }) as any,
    );

    const response = await request(app)
      .get("/api/it/people/" + personId)
      .set(auth("ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.assignedAssets).toHaveLength(1);
    expect(response.body.data.assetAssignments).toHaveLength(1);
    expect(response.body.data.phoneLineAssignments).toHaveLength(1);
    const select = (prismaMock.person.findFirst.mock.calls[0][0] as any).select;
    expect(select.assignedAssets.select.secretsRef).toBeUndefined();
    expect(select.phoneLines.select.pukCipherText).toBeUndefined();
    expect(select.assetAssignments.take).toBe(20);
    expect(select.phoneLineAssignments.take).toBe(20);
  });

  it("crea sólo datos laborales, normaliza campos y audita notes redactado", async () => {
    prismaMock.person.create.mockImplementationOnce(async (args: any) =>
      makePerson({ ...args.data, updatedAt: version }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/it/people")
      .set(auth("AGENT"))
      .send({
        employeeNumber: " leg-002 ",
        firstName: " Beatriz ",
        lastName: " Gómez ",
        jobTitle: "   ",
        workEmail: "BEATRIZ@EMPRESA.COM",
        workPhone: "  ",
        startDate: "2026-07-01",
        departmentId,
        notes: "seguimiento laboral interno",
      });

    expect(response.status).toBe(201);
    expect(prismaMock.person.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          employeeNumber: "LEG-002",
          firstName: "Beatriz",
          lastName: "Gómez",
          jobTitle: null,
          workEmail: "beatriz@empresa.com",
          workPhone: null,
          startDate: new Date("2026-07-01T00:00:00.000Z"),
          endDate: null,
        }),
      }),
    );
    const auditMeta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data
      .meta;
    expect(auditMeta.changes.notes).toEqual({
      changed: true,
      redacted: true,
    });
    expect(auditMeta.changes.workEmail).toEqual({
      changed: true,
      redacted: true,
    });
    expect(JSON.stringify(auditMeta)).not.toContain(
      "seguimiento laboral interno",
    );
    expect(JSON.stringify(auditMeta)).not.toContain("beatriz@empresa.com");
  });

  it.each(["2026-02-31", "2026-13-01"])(
    "rechaza la fecha calendario inválida %s",
    async (startDate) => {
      const response = await request(app)
        .post("/api/it/people")
        .set(auth("ADMIN"))
        .send({ firstName: "Ana", lastName: "Pérez", startDate });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(prismaMock.person.create).not.toHaveBeenCalled();
    },
  );

  it.each(["2026-02-31", "2026-13-01"])(
    "protege el service ante la fecha inválida %s aunque se saltee Zod",
    async (startDate) => {
      await expect(
        PeopleService.create(
          {
            firstName: "Ana",
            lastName: "Pérez",
            status: "ACTIVE",
            startDate,
          },
          "actor-1",
        ),
      ).rejects.toMatchObject({
        code: "PERSON_DATE_INVALID",
        statusCode: 400,
      });
      expect(prismaMock.person.create).not.toHaveBeenCalled();
    },
  );

  it("rechaza campos personales fuera del contrato estricto", async () => {
    const response = await request(app)
      .post("/api/it/people")
      .set(auth("ADMIN"))
      .send({
        firstName: "Ana",
        lastName: "Pérez",
        dni: "12345678",
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(prismaMock.person.create).not.toHaveBeenCalled();
  });

  it.each([
    ["employeeNumber", "PERSON_EMPLOYEE_NUMBER_EXISTS"],
    ["workEmail", "PERSON_WORK_EMAIL_EXISTS"],
  ])("devuelve 409 claro para duplicado de %s", async (field, code) => {
    prismaMock.person.create.mockRejectedValueOnce(uniqueError(field));

    const response = await request(app)
      .post("/api/it/people")
      .set(auth("ADMIN"))
      .send({
        employeeNumber: "LEG-001",
        firstName: "Ana",
        lastName: "Pérez",
        workEmail: "ana@empresa.com",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(code);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("sólo traduce P2003 cuando identifica la FK de sector", async () => {
    prismaMock.person.create.mockRejectedValueOnce(
      foreignKeyError("audit_logs_actor_id_fkey (index)"),
    );

    await expect(
      PeopleService.create(
        {
          firstName: "Ana",
          lastName: "Pérez",
          status: "ACTIVE",
        },
        "deleted-actor",
      ),
    ).rejects.toMatchObject({ code: "P2003" });

    prismaMock.person.create.mockRejectedValueOnce(
      foreignKeyError("people_department_id_fkey (index)"),
    );

    await expect(
      PeopleService.create(
        {
          firstName: "Ana",
          lastName: "Pérez",
          status: "ACTIVE",
          departmentId,
        },
        "actor-1",
      ),
    ).rejects.toMatchObject({
      code: "PERSON_DEPARTMENT_NOT_FOUND",
      statusCode: 400,
    });
  });

  it("actualiza sólo cambios reales y redacta contactos y notes en auditoría", async () => {
    prismaMock.person.findFirst
      .mockResolvedValueOnce(makePerson() as any)
      .mockResolvedValueOnce(
        makePerson({
          lastName: "Pérez López",
          workEmail: "ana.it@empresa.com",
          workPhone: "+54 341 555-0002",
          notes: "nota laboral confidencial",
          updatedAt: nextVersion,
        }) as any,
      );
    prismaMock.person.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .patch("/api/it/people/" + personId)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        firstName: " Ana ",
        lastName: "Pérez López",
        workEmail: "ana.it@empresa.com",
        workPhone: "+54 341 555-0002",
        notes: "nota laboral confidencial",
      });

    expect(response.status).toBe(200);
    expect(prismaMock.person.updateMany).toHaveBeenCalledWith({
      where: { id: personId, isActive: true, updatedAt: version },
      data: {
        lastName: "Pérez López",
        workEmail: "ana.it@empresa.com",
        workPhone: "+54 341 555-0002",
        notes: "nota laboral confidencial",
      },
    });
    const auditMeta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data
      .meta;
    expect(auditMeta).toEqual({
      fields: ["lastName", "workEmail", "workPhone", "notes"],
      changes: {
        lastName: { from: "Pérez", to: "Pérez López" },
        workEmail: { changed: true, redacted: true },
        workPhone: { changed: true, redacted: true },
        notes: { changed: true, redacted: true },
      },
    });
    expect(JSON.stringify(auditMeta)).not.toContain(
      "nota laboral confidencial",
    );
    expect(JSON.stringify(auditMeta)).not.toContain("ana.it@empresa.com");
    expect(JSON.stringify(auditMeta)).not.toContain("+54 341 555-0002");
  });

  it("rechaza endDate explícito si el estado resultante no es TERMINATED", async () => {
    prismaMock.person.findFirst.mockResolvedValueOnce(makePerson() as any);

    const response = await request(app)
      .patch("/api/it/people/" + personId)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        endDate: "2026-07-01",
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("PERSON_END_DATE_STATUS_INVALID");
    expect(prismaMock.person.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("mantiene el conflicto optimista para versión vencida", async () => {
    prismaMock.person.findFirst.mockResolvedValueOnce(
      makePerson({ updatedAt: nextVersion }) as any,
    );

    const response = await request(app)
      .patch("/api/it/people/" + personId)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        firstName: "Ana",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PERSON_VERSION_CONFLICT");
    expect(prismaMock.person.updateMany).not.toHaveBeenCalled();
  });

  it("detecta una carrera entre lectura y updateMany", async () => {
    prismaMock.person.findFirst.mockResolvedValueOnce(makePerson() as any);
    prismaMock.person.updateMany.mockResolvedValueOnce({ count: 0 } as any);

    const response = await request(app)
      .patch("/api/it/people/" + personId)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        jobTitle: "Líder de IT",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PERSON_VERSION_CONFLICT");
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("devuelve el recurso sin escribir ni auditar para un PATCH no-op", async () => {
    const unchanged = makePerson();
    prismaMock.person.findFirst
      .mockResolvedValueOnce(unchanged as any)
      .mockResolvedValueOnce(unchanged as any);

    const response = await request(app)
      .patch("/api/it/people/" + personId)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        employeeNumber: "leg-001",
        firstName: " Ana ",
        startDate: "2025-01-15",
        notes: null,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.updatedAt).toBe(version.toISOString());
    expect(prismaMock.person.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("bloquea TERMINATED mientras conserva equipos o líneas actuales", async () => {
    prismaMock.person.findFirst.mockResolvedValueOnce(makePerson() as any);
    prismaMock.asset.count.mockResolvedValueOnce(2);
    prismaMock.phoneLine.count.mockResolvedValueOnce(1);

    const response = await request(app)
      .patch("/api/it/people/" + personId)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "TERMINATED",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PERSON_HAS_CURRENT_HOLDINGS");
    expect(response.body.error.details).toEqual({
      assignedAssets: 2,
      assignedPhoneLines: 1,
    });
    expect(prismaMock.person.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("completa endDate al desvincular sin tenencias vigentes", async () => {
    const now = new Date();
    const automaticEndDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    prismaMock.person.findFirst
      .mockResolvedValueOnce(makePerson() as any)
      .mockResolvedValueOnce(
        makePerson({
          status: "TERMINATED",
          endDate: automaticEndDate,
          updatedAt: nextVersion,
        }) as any,
      );
    prismaMock.asset.count.mockResolvedValueOnce(0);
    prismaMock.phoneLine.count.mockResolvedValueOnce(0);
    prismaMock.person.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .patch("/api/it/people/" + personId)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "TERMINATED",
      });

    expect(response.status).toBe(200);
    expect(prismaMock.person.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "TERMINATED",
          endDate: automaticEndDate,
        },
      }),
    );
    const auditMeta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data
      .meta;
    expect(auditMeta.changes.status).toEqual({
      from: "ACTIVE",
      to: "TERMINATED",
    });
    expect(auditMeta.changes.endDate.to).toBe(automaticEndDate.toISOString());
  });

  it("limpia endDate al reactivar o pasar a ON_LEAVE", async () => {
    const endDate = new Date("2026-07-01T00:00:00.000Z");
    prismaMock.person.findFirst
      .mockResolvedValueOnce(
        makePerson({ status: "TERMINATED", endDate }) as any,
      )
      .mockResolvedValueOnce(
        makePerson({ status: "ON_LEAVE", endDate: null }) as any,
      );
    prismaMock.person.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .patch("/api/it/people/" + personId)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        status: "ON_LEAVE",
      });

    expect(response.status).toBe(200);
    expect(prismaMock.person.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "ON_LEAVE", endDate: null },
      }),
    );
    expect(prismaMock.asset.count).not.toHaveBeenCalled();
    expect(prismaMock.phoneLine.count).not.toHaveBeenCalled();
  });
});
