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
const auth = (role: "USER" | "AGENT" | "ADMIN") => ({
  Authorization: `Bearer ${signAccessToken({ role })}`,
});

describe("GET /api/it/overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockResolvedValue([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ] as any);
  });

  it("requiere autenticación", async () => {
    const response = await request(app).get("/api/it/overview");
    expect(response.status).toBe(401);
  });

  it("rechaza usuarios sin rol de staff", async () => {
    const response = await request(app)
      .get("/api/it/overview")
      .set(auth("USER"));

    expect(response.status).toBe(403);
  });

  it("devuelve la superficie real sin doble conteo y cobertura v2 para AGENT", async () => {
    prismaMock.$transaction.mockResolvedValueOnce([
      90, 84, 130, 72, 3, 42, 88, 72, 4, 6, 2, 100, 88, 1, 21, 40, 54, 8, 5, 0,
    ] as any);

    const response = await request(app)
      .get("/api/it/overview")
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    expect(response.body.data.schemaVersion).toBe("it-management-v2");
    expect(response.body.data.counts.people).toEqual({ total: 90, active: 84 });
    expect(response.body.data.counts.assets.total).toBe(130);
    expect(response.body.data.counts.managedDevices).toEqual({
      total: 191,
      workstations: 42,
      phones: 88,
      networkInfrastructure: 21,
      cameras: 40,
    });
    expect(response.body.data.counts.networkDevices).toEqual({
      total: 61,
      active: 54,
    });
    expect(response.body.data.coverage.apiSurface).toEqual({
      overview: "available",
      crud: "assets,people,maintenances,procurement,network,phoneLines",
      agentGateway: "available",
      telemetry: "available",
      remoteControl: "available_direct_lan_vpn",
    });
    expect(response.body.data.coverage.modules).toEqual({
      inventory: "available",
      people: "available",
      maintenance: "available",
      procurement: "available",
      network: "available",
      monitoring: "available",
      cameras: "limited",
      phoneLines: "available",
    });
    expect(prismaMock.person.count).toHaveBeenNthCalledWith(1, {
      where: { isActive: true, deletedAt: null },
    });
    expect(prismaMock.person.count).toHaveBeenNthCalledWith(2, {
      where: { isActive: true, deletedAt: null, status: "ACTIVE" },
    });
    expect(prismaMock.asset.count).toHaveBeenNthCalledWith(1, {
      where: { isActive: true, deletedAt: null },
    });
    expect(prismaMock.asset.count).toHaveBeenNthCalledWith(2, {
      where: { status: "ASSIGNED", isActive: true, deletedAt: null },
    });
    expect(prismaMock.asset.count).toHaveBeenNthCalledWith(3, {
      where: { status: "IN_REPAIR", isActive: true, deletedAt: null },
    });
    expect(prismaMock.asset.count).toHaveBeenNthCalledWith(4, {
      where: {
        isActive: true,
        deletedAt: null,
        type: { in: ["DESKTOP", "NOTEBOOK"] },
      },
    });
    expect(prismaMock.asset.count).toHaveBeenNthCalledWith(5, {
      where: { isActive: true, deletedAt: null, type: "PHONE" },
    });
    expect(prismaMock.phoneLine.count).toHaveBeenNthCalledWith(1, {
      where: { isActive: true, deletedAt: null },
    });
    expect(prismaMock.networkDevice.count).toHaveBeenNthCalledWith(1, {
      where: {
        isActive: true,
        deletedAt: null,
        type: { not: "CAMERA" },
      },
    });
    expect(prismaMock.networkDevice.count).toHaveBeenNthCalledWith(2, {
      where: { isActive: true, deletedAt: null, type: "CAMERA" },
    });
    expect(prismaMock.agentDevice.count).toHaveBeenNthCalledWith(1, {
      where: { isActive: true, deletedAt: null },
    });
    expect(prismaMock.agentDevice.count).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          deletedAt: null,
          lastSeenAt: { gte: expect.any(Date) },
        }),
      }),
    );
  });
});
