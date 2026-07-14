import { createHash } from "node:crypto";
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
import { createApp, shouldSkipGlobalRateLimit } from "../src/app";
import { prisma } from "../src/lib/database";
import { AGENT_ENROLL_RATE_LIMIT } from "../src/routes/agent-machine.routes";
import {
  machineEnrollSchema,
  machineHeartbeatSchema,
} from "../src/validations/agents";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const deviceId = "cmhaaaaaaaaaaaaaaaaaaaaaaa";
const tokenId = "cmhbbbbbbbbbbbbbbbbbbbbbbb";
const assetId = "cmhccccccccccccccccccccccc";
const sessionId = "cmhddddddddddddddddddddddd";
const personId = "cmheeeeeeeeeeeeeeeeeeeeeee";
const assignmentId = "cmhfffffffffffffffffffffff";
const version = new Date("2026-07-13T10:00:00.000Z");
const nextVersion = new Date("2026-07-13T10:01:00.000Z");
const token = "A".repeat(43);
const deviceSecret = "B".repeat(43);
const otherSecret = "C".repeat(43);
const machineGuid = "550e8400-e29b-41d4-a716-446655440000";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const uniqueError = (field: string) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.15.0",
    meta: { target: [field] },
  });

const auth = (role: "USER" | "AGENT" | "ADMIN", id = "agent-1") => ({
  Authorization: `Bearer ${signAccessToken({ role, id })}`,
});

const machineAuth = (secret = deviceSecret, id = deviceId) => ({
  "X-Agent-Device-Id": id,
  Authorization: `Bearer ${secret}`,
});

const makeDevice = (overrides: Record<string, any> = {}) => ({
  id: deviceId,
  machineId: machineGuid,
  hostname: "PC-GRF-001",
  agentVersion: "1.0.0",
  osName: "Windows 11 Pro",
  osVersion: "10.0.26100",
  connState: "ONLINE",
  lastSeenAt: new Date(),
  lastEnrolledAt: version,
  loggedInUser: "GRF\\usuario",
  primaryIp: "10.0.0.25",
  primaryMac: "AA:BB:CC:DD:EE:FF",
  uptimeSec: 3600,
  cpuPct: 20,
  ramUsedMb: 8192,
  ramTotalMb: 16384,
  batteryPct: 85,
  batteryCharging: false,
  vncRunning: true,
  sshRunning: true,
  isActive: true,
  deletedAt: null,
  assetId,
  asset: {
    id: assetId,
    assetTag: "NB-0001",
    type: "NOTEBOOK",
    status: "ASSIGNED",
    brand: "Dell",
    model: "Latitude",
  },
  createdAt: version,
  updatedAt: version,
  ...overrides,
});

const makeToken = (overrides: Record<string, any> = {}) => ({
  id: tokenId,
  label: "Lote Contaduría",
  expiresAt: new Date(Date.now() + 60 * 60_000),
  maxUses: 1,
  useCount: 0,
  usedAt: null,
  revokedAt: null,
  createdAt: version,
  createdBy: { id: "agent-1", name: "Agente" },
  enrolledDevices: [],
  ...overrides,
});

const makeAsset = (overrides: Record<string, any> = {}) => ({
  id: assetId,
  assetTag: "NB-0001",
  type: "NOTEBOOK",
  status: "IN_STOCK",
  brand: "Dell",
  model: "Latitude 5420",
  serialNumber: "SER-AGENT-001",
  specs: { cpu: "Core i5", ramGb: 16 },
  notes: null,
  location: null,
  warrantyUntil: null,
  assignedPersonId: null,
  assignedDepartmentId: null,
  purchaseItemId: null,
  retiredAt: null,
  retirementReason: null,
  isActive: true,
  createdById: "agent-1",
  createdAt: version,
  updatedAt: version,
  assignedPerson: null,
  assignedDepartment: null,
  createdBy: { id: "agent-1", name: "Agente", email: "it@grf.com.ar" },
  assignments: [],
  ...overrides,
});

const makeSession = (overrides: Record<string, any> = {}) => ({
  id: sessionId,
  deviceId,
  userId: "agent-1",
  kind: "SSH",
  status: "ACTIVE",
  clientIp: "10.0.0.10",
  targetHost: "10.0.0.25",
  startedAt: version,
  endedAt: null,
  bytesIn: null,
  bytesOut: null,
  errorMsg: null,
  device: { id: deviceId, hostname: "PC-GRF-001" },
  user: { id: "agent-1", name: "Agente" },
  ...overrides,
});

const heartbeat = (overrides: Record<string, any> = {}) => ({
  hostname: "PC-GRF-001",
  username: "GRF\\usuario",
  ipAddresses: ["fe80::1%12", "10.0.0.25"],
  macAddresses: ["aa-bb-cc-dd-ee-ff"],
  uptimeSeconds: 3600,
  cpuPercent: 25.5,
  ram: { totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3 },
  battery: { percent: 85, charging: false },
  disks: [{ name: "C:", totalBytes: 1000, usedBytes: 500 }],
  services: {
    ssh: { available: true, port: 2222 },
    vnc: { available: true, port: 5901 },
  },
  os: { name: "Windows 11 Pro", version: "10.0.26100", build: "26100" },
  agentVersion: "1.0.0",
  ...overrides,
});

const registerAssetBody = (overrides: Record<string, any> = {}) => ({
  expectedUpdatedAt: version.toISOString(),
  asset: {
    type: "NOTEBOOK",
    brand: "Dell",
    model: "Latitude 5420",
    serialNumber: "SER-AGENT-001",
    specs: { cpu: "Core i5", ramGb: 16 },
  },
  ...overrides,
});

describe("API de agentes de monitoreo IT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
  });

  it("protege gestión humana para AGENT/ADMIN y valida filtros strict", async () => {
    expect(AGENT_ENROLL_RATE_LIMIT).toBeGreaterThanOrEqual(60);
    expect(shouldSkipGlobalRateLimit("/api/agent/heartbeat")).toBe(true);
    expect((await request(app).get("/api/it/agents/devices")).status).toBe(401);
    expect(
      (await request(app).get("/api/it/agents/devices").set(auth("USER")))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/it/agents/devices?unknown=true")
          .set(auth("AGENT"))
      ).status,
    ).toBe(400);
  });

  it("acepta MachineGuid real no-RFC y elimina zone ID IPv6 sin lanzar", () => {
    const enroll = machineEnrollSchema.parse({
      token,
      deviceSecret,
      machineGuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      hostname: "PC-GRF-001",
      agentVersion: "1.0.0",
    });
    expect(enroll.machineGuid).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    const parsed = machineHeartbeatSchema.parse(
      heartbeat({ ipAddresses: ["fe80::1%12"] }),
    );
    expect(parsed.ipAddresses).toEqual(["fe80::1"]);
  });

  it("ofrece lookups sólo con activos compatibles y no vinculados", async () => {
    prismaMock.asset.findMany.mockResolvedValueOnce([]);
    const response = await request(app)
      .get("/api/it/agents/lookups")
      .set(auth("AGENT"));
    expect(response.status).toBe(200);
    expect(prismaMock.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentDevice: null,
          type: { in: ["DESKTOP", "NOTEBOOK", "SERVER", "OTHER"] },
        }),
      }),
    );
  });

  it("crea token CSPRNG por lote, almacena sólo hash y conserva un uso por defecto", async () => {
    prismaMock.agentEnrollmentToken.create.mockImplementationOnce(
      async (args: any) =>
        ({
          ...makeToken(),
          label: args.data.label,
          expiresAt: args.data.expiresAt,
        }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/it/agents/enrollment-tokens")
      .set(auth("ADMIN"))
      .send({ label: "Lote Contaduría", maxUses: 25 });

    expect(response.status).toBe(201);
    expect(response.body.data.plainToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const createData = (
      prismaMock.agentEnrollmentToken.create.mock.calls[0][0] as any
    ).data;
    expect(createData.tokenHash).toHaveLength(64);
    expect(createData.tokenHash).not.toBe(response.body.data.plainToken);
    expect(createData.maxUses).toBe(25);
    const audit = (prismaMock.auditLog.create.mock.calls[0][0] as any).data
      .meta;
    expect(JSON.stringify(audit)).not.toContain(response.body.data.plainToken);
    expect(audit.maxUses).toBe(25);

    prismaMock.agentEnrollmentToken.create.mockImplementationOnce(
      async (args: any) =>
        ({
          ...makeToken(),
          maxUses: args.data.maxUses,
          expiresAt: args.data.expiresAt,
        }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    await request(app)
      .post("/api/it/agents/enrollment-tokens")
      .set(auth("AGENT"))
      .send({});
    expect(
      (prismaMock.agentEnrollmentToken.create.mock.calls[1][0] as any).data
        .maxUses,
    ).toBe(1);

    const tooLarge = await request(app)
      .post("/api/it/agents/enrollment-tokens")
      .set(auth("ADMIN"))
      .send({ maxUses: 251 });
    expect(tooLarge.status).toBe(400);
  });

  it("lista estados derivados de tokens y revoca sólo vigente/no usado", async () => {
    prismaMock.agentEnrollmentToken.findMany.mockResolvedValueOnce([
      makeToken(),
      makeToken({
        id: "partial",
        maxUses: 10,
        useCount: 4,
        usedAt: new Date(),
      }),
      makeToken({ id: "used", useCount: 1, usedAt: new Date() }),
      makeToken({ id: "expired", expiresAt: new Date(Date.now() - 1000) }),
      makeToken({ id: "revoked", revokedAt: new Date() }),
    ] as any);
    const listed = await request(app)
      .get("/api/it/agents/enrollment-tokens")
      .set(auth("AGENT"));
    expect(listed.status).toBe(200);
    expect(listed.body.data.items.map((item: any) => item.status)).toEqual([
      "AVAILABLE",
      "AVAILABLE",
      "USED",
      "EXPIRED",
      "REVOKED",
    ]);
    expect(listed.body.data.items[1]).toEqual(
      expect.objectContaining({ maxUses: 10, useCount: 4, remainingUses: 6 }),
    );

    prismaMock.agentEnrollmentToken.findMany.mockResolvedValueOnce([
      makeToken({ id: "revoked", revokedAt: new Date() }),
    ] as any);
    const revokedOnly = await request(app)
      .get("/api/it/agents/enrollment-tokens?status=REVOKED")
      .set(auth("AGENT"));
    expect(revokedOnly.status).toBe(200);
    expect(revokedOnly.body.data.items).toHaveLength(1);
    expect(prismaMock.agentEnrollmentToken.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { revokedAt: { not: null } } }),
    );

    prismaMock.agentEnrollmentToken.findUnique.mockResolvedValueOnce({
      id: tokenId,
      maxUses: 10,
      useCount: 4,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    prismaMock.agentEnrollmentToken.updateMany.mockResolvedValueOnce({
      count: 1,
    });
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    const revoked = await request(app)
      .post(`/api/it/agents/enrollment-tokens/${tokenId}/revoke`)
      .set(auth("AGENT"))
      .send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body.data).toEqual({ revoked: true, id: tokenId });
    expect(prismaMock.agentEnrollmentToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { revokedAt: expect.any(Date) } }),
    );
  });

  it("enrola con secreto generado por la máquina y nunca lo devuelve ni persiste plano", async () => {
    prismaMock.agentEnrollmentToken.findUnique.mockResolvedValueOnce({
      id: tokenId,
      createdById: "agent-1",
      maxUses: 10,
      useCount: 3,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    prismaMock.agentDevice.findUnique.mockResolvedValueOnce(null);
    prismaMock.agentDevice.create.mockResolvedValueOnce({
      id: deviceId,
    } as any);
    prismaMock.agentEnrollmentToken.updateMany.mockResolvedValueOnce({
      count: 1,
    });
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app).post("/api/agent/enroll").send({
      token,
      deviceSecret,
      machineGuid,
      hostname: "PC-GRF-001",
      agentVersion: "1.0.0",
      osName: "Windows 11 Pro",
      osVersion: "10.0.26100",
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ deviceId, nextHeartbeatSeconds: 60 });
    expect(JSON.stringify(response.body)).not.toContain(deviceSecret);
    const createData = (prismaMock.agentDevice.create.mock.calls[0][0] as any)
      .data;
    expect(createData.secretHash).toBe(hash(deviceSecret));
    expect(createData.enrollmentTokenId).toBe(tokenId);
    expect(JSON.stringify(createData)).not.toContain(deviceSecret);
    expect(
      JSON.stringify(
        (prismaMock.auditLog.create.mock.calls[0][0] as any).data.meta,
      ),
    ).not.toContain(deviceSecret);
    expect(prismaMock.agentEnrollmentToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: tokenId,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
        maxUses: 10,
        useCount: 3,
      },
      data: { useCount: { increment: 1 }, usedAt: expect.any(Date) },
    });
  });

  it("rechaza atómicamente si otro equipo consume el último uso durante el enrolamiento", async () => {
    prismaMock.agentEnrollmentToken.findUnique.mockResolvedValueOnce({
      id: tokenId,
      createdById: "agent-1",
      maxUses: 5,
      useCount: 4,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    prismaMock.agentDevice.findUnique.mockResolvedValueOnce(null);
    prismaMock.agentDevice.create.mockResolvedValueOnce({
      id: deviceId,
    } as any);
    prismaMock.agentEnrollmentToken.updateMany.mockResolvedValueOnce({
      count: 0,
    });

    const response = await request(app)
      .post("/api/agent/enroll")
      .send({
        token,
        deviceSecret,
        machineGuid,
        hostname: "PC-GRF-001",
        agentVersion: "1.0.0",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ENROLLMENT_TOKEN_NOT_AVAILABLE");
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("reintenta el mismo enrolamiento idempotentemente aunque el lote ya no esté disponible", async () => {
    prismaMock.agentEnrollmentToken.findUnique.mockResolvedValueOnce({
      id: tokenId,
      createdById: "agent-1",
      maxUses: 1,
      useCount: 1,
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() - 60_000),
    } as any);
    prismaMock.agentDevice.findUnique.mockResolvedValueOnce({
      id: deviceId,
      isActive: true,
      deletedAt: null,
      enrollmentTokenId: tokenId,
      secretHash: hash(deviceSecret),
    } as any);

    const response = await request(app).post("/api/agent/enroll").send({
      token,
      deviceSecret,
      machineGuid,
      hostname: "PC-GRF-001",
      agentVersion: "1.0.0",
    });

    expect(response.status).toBe(200);
    expect(response.body.data.deviceId).toBe(deviceId);
    expect(prismaMock.agentDevice.create).not.toHaveBeenCalled();
    expect(prismaMock.agentDevice.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("rechaza uniformemente reuso de token con secreto diferente", async () => {
    prismaMock.agentEnrollmentToken.findUnique.mockResolvedValueOnce({
      id: tokenId,
      createdById: "agent-1",
      maxUses: 10,
      useCount: 1,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    prismaMock.agentDevice.findUnique.mockResolvedValueOnce({
      id: deviceId,
      isActive: true,
      deletedAt: null,
      enrollmentTokenId: tokenId,
      secretHash: hash(deviceSecret),
    } as any);
    const response = await request(app).post("/api/agent/enroll").send({
      token,
      deviceSecret: otherSecret,
      machineGuid,
      hostname: "PC-GRF-001",
      agentVersion: "1.0.0",
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ENROLLMENT_TOKEN_NOT_AVAILABLE");
  });

  it("re-enrola misma máquina con token nuevo, rota hash y preserva gestión", async () => {
    prismaMock.agentEnrollmentToken.findUnique.mockResolvedValueOnce({
      id: tokenId,
      createdById: "agent-1",
      maxUses: 1,
      useCount: 0,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    prismaMock.agentDevice.findUnique.mockResolvedValueOnce({
      id: deviceId,
      isActive: false,
      deletedAt: null,
      enrollmentTokenId: "cmholdtokenaaaaaaaaaaaaaaaaa",
      secretHash: hash(otherSecret),
    } as any);
    prismaMock.agentEnrollmentToken.updateMany.mockResolvedValueOnce({
      count: 1,
    });
    prismaMock.agentDevice.update.mockResolvedValueOnce({
      id: deviceId,
    } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/agent/enroll")
      .send({
        token,
        deviceSecret,
        machineGuid,
        hostname: "PC-GRF-001",
        agentVersion: "2.0.0",
      });
    expect(response.status).toBe(200);
    const updateData = (prismaMock.agentDevice.update.mock.calls[0][0] as any)
      .data;
    expect(updateData.secretHash).toBe(hash(deviceSecret));
    expect(updateData.enrollmentTokenId).toBe(tokenId);
    expect(updateData.isActive).toBeUndefined();
    expect(updateData.assetId).toBeUndefined();
  });

  it("impide que un token por lote rote el secreto de una máquina existente", async () => {
    prismaMock.agentEnrollmentToken.findUnique.mockResolvedValueOnce({
      id: tokenId,
      createdById: "agent-1",
      maxUses: 25,
      useCount: 4,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    prismaMock.agentDevice.findUnique.mockResolvedValueOnce({
      id: deviceId,
      isActive: true,
      deletedAt: null,
      enrollmentTokenId: "cmholdtokenaaaaaaaaaaaaaaaaa",
      secretHash: hash(otherSecret),
    } as any);

    const response = await request(app).post("/api/agent/enroll").send({
      token,
      deviceSecret,
      machineGuid,
      hostname: "PC-GRF-001",
      agentVersion: "2.0.0",
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("AGENT_MACHINE_NOT_AVAILABLE");
    expect(prismaMock.agentDevice.update).not.toHaveBeenCalled();
    expect(prismaMock.agentEnrollmentToken.updateMany).not.toHaveBeenCalled();
  });

  it("usa 401 uniforme para deviceId, secreto o agente revocado", async () => {
    prismaMock.agentDevice.findFirst.mockResolvedValueOnce(null);
    const missing = await request(app)
      .post("/api/agent/heartbeat")
      .set(machineAuth())
      .send(heartbeat());
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("AGENT_AUTH_INVALID");

    prismaMock.agentDevice.findFirst.mockResolvedValueOnce({
      id: deviceId,
      isActive: false,
      secretHash: hash(deviceSecret),
    } as any);
    const revoked = await request(app)
      .post("/api/agent/heartbeat")
      .set(machineAuth())
      .send(heartbeat());
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe("AGENT_AUTH_INVALID");
  });

  it("procesa heartbeat, canoniza zona IPv6, elige IP útil y aplica retención", async () => {
    prismaMock.agentDevice.findFirst
      .mockResolvedValueOnce({
        id: deviceId,
        isActive: true,
        secretHash: hash(deviceSecret),
      } as any)
      .mockResolvedValueOnce({
        id: deviceId,
        secretHash: hash(deviceSecret),
        updatedAt: version,
      } as any);
    prismaMock.agentDevice.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.agentMetricSample.findFirst.mockResolvedValueOnce(null);
    prismaMock.agentMetricSample.create.mockResolvedValueOnce({} as any);
    prismaMock.agentMetricSample.deleteMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.agentInventorySnapshot.create.mockResolvedValueOnce({} as any);
    prismaMock.agentInventorySnapshot.findMany.mockResolvedValueOnce([
      { id: "old-snapshot" },
    ] as any);
    prismaMock.agentInventorySnapshot.deleteMany.mockResolvedValueOnce({
      count: 1,
    });

    const response = await request(app)
      .post("/api/agent/heartbeat")
      .set(machineAuth())
      .send(
        heartbeat({
          inventory: {
            hardware: { manufacturer: "Dell", model: "Latitude" },
            software: [{ name: "Microsoft 365", version: "1" }],
          },
        }),
      );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({ nextHeartbeatSeconds: 60, state: "ONLINE" }),
    );
    const updated = (prismaMock.agentDevice.updateMany.mock.calls[0][0] as any)
      .data;
    expect(updated.primaryIp).toBe("10.0.0.25");
    expect(updated.primaryMac).toBe("AA:BB:CC:DD:EE:FF");
    expect(updated.ramUsedMb).toBe(8192);
    expect(updated.updatedAt).toEqual(version);
    expect(prismaMock.agentMetricSample.create).toHaveBeenCalledOnce();
    expect(prismaMock.agentInventorySnapshot.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-snapshot"] } },
    });
  });

  it("downsamplea métricas y sólo crea snapshot cuando viene inventario", async () => {
    prismaMock.agentDevice.findFirst
      .mockResolvedValueOnce({
        id: deviceId,
        isActive: true,
        secretHash: hash(deviceSecret),
      } as any)
      .mockResolvedValueOnce({
        id: deviceId,
        secretHash: hash(deviceSecret),
        updatedAt: version,
      } as any);
    prismaMock.agentDevice.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.agentMetricSample.findFirst.mockResolvedValueOnce({
      sampledAt: new Date(),
    } as any);
    prismaMock.agentMetricSample.deleteMany.mockResolvedValueOnce({ count: 0 });

    const response = await request(app)
      .post("/api/agent/heartbeat")
      .set(machineAuth())
      .send(heartbeat());
    expect(response.status).toBe(200);
    expect(prismaMock.agentMetricSample.create).not.toHaveBeenCalled();
    expect(prismaMock.agentInventorySnapshot.create).not.toHaveBeenCalled();
  });

  it("rechaza heartbeat desconocido y limita body público a 512 KiB", async () => {
    prismaMock.agentDevice.findFirst.mockResolvedValueOnce({
      id: deviceId,
      isActive: true,
      secretHash: hash(deviceSecret),
    } as any);
    const strict = await request(app)
      .post("/api/agent/heartbeat")
      .set(machineAuth())
      .send({ ...heartbeat(), arbitraryCommand: "format c:" });
    expect(strict.status).toBe(400);
    expect(strict.body.error.code).toBe("VALIDATION_ERROR");

    const oversized = await request(app)
      .post("/api/agent/enroll")
      .send({ padding: "x".repeat(530 * 1024) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("lista estado derivado sin mutar GET ni confiar en connState persistido", async () => {
    prismaMock.agentDevice.findMany.mockResolvedValueOnce([
      makeDevice({
        connState: "ONLINE",
        lastSeenAt: new Date(Date.now() - 5 * 60_000),
      }),
    ] as any);
    prismaMock.agentDevice.count.mockResolvedValueOnce(1);
    const response = await request(app)
      .get("/api/it/agents/devices?state=STALE")
      .set(auth("AGENT"));
    expect(response.status).toBe(200);
    expect(response.body.data.items[0].state).toBe("STALE");
    expect(response.body.data.items[0].connState).toBe("OFFLINE");
    expect(prismaMock.agentDevice.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.agentDevice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ AND: expect.any(Array) }),
      }),
    );
  });

  it("detalle incluye métricas recientes, último snapshot y sesiones activas", async () => {
    prismaMock.agentDevice.findFirst.mockResolvedValueOnce(makeDevice() as any);
    prismaMock.agentMetricSample.findMany.mockResolvedValueOnce([
      {
        id: "metric-1",
        cpuPct: 20,
        ramUsedMb: 8000,
        diskUsedPct: 50,
        batteryPct: 80,
        sampledAt: version,
      },
    ] as any);
    prismaMock.agentInventorySnapshot.findFirst.mockResolvedValueOnce({
      id: "snapshot-1",
      createdAt: version,
    } as any);
    prismaMock.remoteSession.findMany.mockResolvedValueOnce([
      makeSession(),
    ] as any);
    const response = await request(app)
      .get(`/api/it/agents/devices/${deviceId}`)
      .set(auth("AGENT"));
    expect(response.status).toBe(200);
    expect(response.body.data.device.recentMetrics).toHaveLength(1);
    expect(response.body.data.device.latestSnapshot.id).toBe("snapshot-1");
    expect(response.body.data.device.activeSessions).toHaveLength(1);
    expect(response.body.data.device.secretHash).toBeUndefined();
  });

  it("vincula activo compatible con CAS y audita sin datos secretos", async () => {
    prismaMock.agentDevice.findFirst
      .mockResolvedValueOnce({
        id: deviceId,
        assetId: null,
        updatedAt: version,
      } as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeDevice({ updatedAt: nextVersion }) as any);
    prismaMock.asset.findFirst.mockResolvedValueOnce({ id: assetId } as any);
    prismaMock.agentDevice.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    const response = await request(app)
      .patch(`/api/it/agents/devices/${deviceId}`)
      .set(auth("ADMIN"))
      .send({ expectedUpdatedAt: version.toISOString(), assetId });
    expect(response.status).toBe(200);
    expect(prismaMock.agentDevice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assetId } }),
    );

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      work(prismaMock),
    );
    prismaMock.agentDevice.findFirst.mockResolvedValueOnce({
      id: deviceId,
      assetId,
      updatedAt: nextVersion,
    } as any);
    const conflict = await request(app)
      .patch(`/api/it/agents/devices/${deviceId}`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString(), assetId: null });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("AGENT_DEVICE_VERSION_CONFLICT");
  });

  it("crea y vincula un activo IN_STOCK en una única transacción", async () => {
    prismaMock.agentDevice.findFirst
      .mockResolvedValueOnce({
        id: deviceId,
        assetId: null,
        isActive: true,
        updatedAt: version,
      } as any)
      .mockResolvedValueOnce(
        makeDevice({
          assetId,
          asset: {
            id: assetId,
            assetTag: "NB-0001",
            type: "NOTEBOOK",
            status: "IN_STOCK",
            brand: "Dell",
            model: "Latitude 5420",
          },
          updatedAt: nextVersion,
        }) as any,
      );
    prismaMock.asset.findMany.mockResolvedValueOnce([] as any);
    prismaMock.asset.create.mockImplementationOnce(
      async (args: any) =>
        makeAsset({ ...args.data, assetTag: args.data.assetTag }) as any,
    );
    prismaMock.agentDevice.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const response = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/register-asset`)
      .set(auth("AGENT"))
      .send(registerAssetBody());

    expect(response.status).toBe(201);
    expect(response.body.data.asset).toEqual(
      expect.objectContaining({ assetTag: "NB-0001", status: "IN_STOCK" }),
    );
    expect(response.body.data.device).toEqual(
      expect.objectContaining({ id: deviceId, assetId }),
    );
    expect(prismaMock.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "IN_STOCK" }),
      }),
    );
    expect(prismaMock.agentDevice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: deviceId,
          isActive: true,
          assetId: null,
          updatedAt: version,
        }),
        data: { assetId },
      }),
    );
    expect(
      prismaMock.auditLog.create.mock.calls.map(
        (call) => (call[0] as any).data.action,
      ),
    ).toEqual(["created", "asset_link_updated"]);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("crea, asigna custodia y vincula el agente atómicamente", async () => {
    prismaMock.agentDevice.findFirst
      .mockResolvedValueOnce({
        id: deviceId,
        assetId: null,
        isActive: true,
        updatedAt: version,
      } as any)
      .mockResolvedValueOnce(makeDevice({ updatedAt: nextVersion }) as any);
    prismaMock.asset.findMany.mockResolvedValueOnce([] as any);
    prismaMock.asset.create.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);
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
    prismaMock.agentDevice.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const response = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/register-asset`)
      .set(auth("ADMIN"))
      .send(
        registerAssetBody({
          custody: { personId, note: "Entrega inicial" },
        }),
      );

    expect(response.status).toBe(201);
    expect(response.body.data.asset).toEqual(
      expect.objectContaining({
        status: "ASSIGNED",
        assignedPersonId: personId,
      }),
    );
    expect(prismaMock.assetAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId,
          personId,
          assignedById: "agent-1",
        }),
      }),
    );
    expect(
      prismaMock.auditLog.create.mock.calls.map(
        (call) => (call[0] as any).data.action,
      ),
    ).toEqual(["created", "assigned", "asset_link_updated"]);
    expect(JSON.stringify(prismaMock.auditLog.create.mock.calls)).not.toContain(
      "Entrega inicial",
    );
  });

  it("rechaza dispositivo ya vinculado y versión obsoleta antes de crear", async () => {
    prismaMock.agentDevice.findFirst
      .mockResolvedValueOnce({
        id: deviceId,
        assetId,
        isActive: true,
        updatedAt: version,
      } as any)
      .mockResolvedValueOnce({
        id: deviceId,
        assetId: null,
        isActive: true,
        updatedAt: nextVersion,
      } as any);

    const linked = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/register-asset`)
      .set(auth("AGENT"))
      .send(registerAssetBody());
    const stale = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/register-asset`)
      .set(auth("AGENT"))
      .send(registerAssetBody());

    expect(linked.status).toBe(409);
    expect(linked.body.error.code).toBe("AGENT_DEVICE_ALREADY_LINKED");
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("AGENT_DEVICE_VERSION_CONFLICT");
    expect(prismaMock.asset.create).not.toHaveBeenCalled();
  });

  it("rechaza custodia de una persona inactiva dentro de la transacción", async () => {
    prismaMock.agentDevice.findFirst.mockResolvedValueOnce({
      id: deviceId,
      assetId: null,
      isActive: true,
      updatedAt: version,
    } as any);
    prismaMock.asset.findMany.mockResolvedValueOnce([] as any);
    prismaMock.asset.create.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.asset.findFirst.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.assetAssignment.findFirst.mockResolvedValueOnce(null);
    prismaMock.person.findFirst.mockResolvedValueOnce(null);
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const response = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/register-asset`)
      .set(auth("AGENT"))
      .send(registerAssetBody({ custody: { personId } }));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("PERSON_NOT_FOUND");
    expect(prismaMock.agentDevice.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.assetAssignment.create).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("propaga el conflicto final para que Prisma revierta alta y auditoría", async () => {
    let transactionRejected = false;
    prismaMock.$transaction.mockImplementationOnce(async (work: any) => {
      try {
        return await work(prismaMock);
      } catch (error) {
        transactionRejected = true;
        throw error;
      }
    });
    prismaMock.agentDevice.findFirst.mockResolvedValueOnce({
      id: deviceId,
      assetId: null,
      isActive: true,
      updatedAt: version,
    } as any);
    prismaMock.asset.findMany.mockResolvedValueOnce([] as any);
    prismaMock.asset.create.mockResolvedValueOnce(makeAsset() as any);
    prismaMock.agentDevice.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    const response = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/register-asset`)
      .set(auth("AGENT"))
      .send(registerAssetBody());

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("AGENT_DEVICE_VERSION_CONFLICT");
    expect(transactionRejected).toBe(true);
    expect(prismaMock.asset.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.agentDevice.findFirst).toHaveBeenCalledTimes(1);
  });

  it("aplica validación de estado y campos administrativos al nuevo flujo", async () => {
    const retired = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/register-asset`)
      .set(auth("ADMIN"))
      .send(
        registerAssetBody({
          asset: {
            type: "NOTEBOOK",
            status: "RETIRED",
            brand: "Dell",
            model: "Latitude 5420",
          },
        }),
      );
    const manualTag = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/register-asset`)
      .set(auth("AGENT"))
      .send(
        registerAssetBody({
          asset: {
            assetTag: "NB-9000",
            type: "NOTEBOOK",
            brand: "Dell",
            model: "Latitude 5420",
          },
        }),
      );

    expect(retired.status).toBe(400);
    expect(retired.body.error.code).toBe("VALIDATION_ERROR");
    expect(manualTag.status).toBe(403);
    expect(manualTag.body.error.code).toBe("FORBIDDEN");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("traduce conflictos únicos del activo sin intentar el vínculo", async () => {
    prismaMock.agentDevice.findFirst.mockResolvedValueOnce({
      id: deviceId,
      assetId: null,
      isActive: true,
      updatedAt: version,
    } as any);
    prismaMock.asset.findMany.mockResolvedValueOnce([] as any);
    prismaMock.asset.create.mockRejectedValueOnce(uniqueError("serialNumber"));

    const response = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/register-asset`)
      .set(auth("AGENT"))
      .send(registerAssetBody());

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("SERIAL_NUMBER_EXISTS");
    expect(prismaMock.agentDevice.updateMany).not.toHaveBeenCalled();
  });

  it("revoca agente con CAS y cierra sesiones remotas activas", async () => {
    prismaMock.agentDevice.findFirst
      .mockResolvedValueOnce({
        id: deviceId,
        isActive: true,
        updatedAt: version,
      } as any)
      .mockResolvedValueOnce(
        makeDevice({ isActive: false, connState: "OFFLINE" }) as any,
      );
    prismaMock.agentDevice.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.remoteSession.updateMany.mockResolvedValueOnce({ count: 2 });
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    const response = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/revoke`)
      .set(auth("ADMIN"))
      .send({ expectedUpdatedAt: version.toISOString() });
    expect(response.status).toBe(200);
    expect(prismaMock.remoteSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId, status: "ACTIVE", endedAt: null },
        data: expect.objectContaining({
          status: "ERROR",
          errorMsg: "Agente revocado",
        }),
      }),
    );
  });

  it("inicia SSH directo sólo online, sin contraseña ni command arbitrario", async () => {
    prismaMock.agentDevice.findFirst.mockResolvedValueOnce({
      id: deviceId,
      hostname: "PC-GRF-001",
      primaryIp: "10.0.0.25",
      lastSeenAt: new Date(),
      isActive: true,
      sshRunning: true,
      vncRunning: true,
      vncCredential: null,
    } as any);
    prismaMock.remoteSession.create.mockResolvedValueOnce(makeSession() as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    const response = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/remote-sessions`)
      .set(auth("AGENT"))
      .send({ protocol: "SSH" });
    expect(response.status).toBe(200);
    expect(response.body.data.connection).toEqual(
      expect.objectContaining({
        protocol: "SSH",
        target: "10.0.0.25",
        port: 22,
        uri: "ssh://10.0.0.25:22",
        scope: "DIRECT",
        requiresNetworkReachability: true,
      }),
    );
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain(
      "password",
    );
    expect(response.body.data.connection.command).toBeUndefined();
  });

  it("VNC usa sólo el puerto configurado y jamás descifra la credencial", async () => {
    prismaMock.agentDevice.findFirst.mockResolvedValueOnce({
      id: deviceId,
      hostname: "PC-GRF-001",
      primaryIp: "2001:db8::25",
      lastSeenAt: new Date(),
      isActive: true,
      sshRunning: true,
      vncRunning: true,
      vncCredential: { vncPort: 5905 },
    } as any);
    prismaMock.remoteSession.create.mockResolvedValueOnce(
      makeSession({ kind: "VNC", targetHost: "2001:db8::25" }) as any,
    );
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    const response = await request(app)
      .post(`/api/it/agents/devices/${deviceId}/remote-sessions`)
      .set(auth("AGENT"))
      .send({ protocol: "VNC" });
    expect(response.status).toBe(200);
    expect(response.body.data.connection.uri).toBe("vnc://[2001:db8::25]:5905");
    const deviceQuery = prismaMock.agentDevice.findFirst.mock
      .calls[0][0] as any;
    expect(deviceQuery.select.vncCredential.select).toEqual({ vncPort: true });
  });

  it("cierra sesión atómicamente y serializa contadores BigInt", async () => {
    prismaMock.remoteSession.findUnique
      .mockResolvedValueOnce({
        id: sessionId,
        status: "ACTIVE",
        endedAt: null,
      } as any)
      .mockResolvedValueOnce(
        makeSession({
          status: "CLOSED",
          endedAt: new Date(),
          bytesIn: 123n,
          bytesOut: 456n,
        }) as any,
      );
    prismaMock.remoteSession.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    const response = await request(app)
      .post(`/api/it/agents/remote-sessions/${sessionId}/close`)
      .set(auth("AGENT"))
      .send({});
    expect(response.status).toBe(200);
    expect(response.body.data.session.bytesIn).toBe("123");
    expect(response.body.data.session.bytesOut).toBe("456");
  });

  it("pagina snapshots y expone métricas dentro de retención", async () => {
    prismaMock.agentDevice.findFirst
      .mockResolvedValueOnce({ id: deviceId } as any)
      .mockResolvedValueOnce({ id: deviceId } as any);
    prismaMock.agentInventorySnapshot.findMany.mockResolvedValueOnce([]);
    prismaMock.agentInventorySnapshot.count.mockResolvedValueOnce(0);
    prismaMock.agentMetricSample.findMany.mockResolvedValueOnce([]);
    const snapshots = await request(app)
      .get(`/api/it/agents/devices/${deviceId}/snapshots?pageSize=10`)
      .set(auth("AGENT"));
    const metrics = await request(app)
      .get(`/api/it/agents/devices/${deviceId}/metrics?limit=100`)
      .set(auth("AGENT"));
    expect(snapshots.status).toBe(200);
    expect(snapshots.body.data.pagination.pageSize).toBe(10);
    expect(metrics.status).toBe(200);
    expect(metrics.body.data.items).toEqual([]);
  });
});
