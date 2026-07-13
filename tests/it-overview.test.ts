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
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
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

  it("devuelve baseline real y cobertura separada para AGENT", async () => {
    const response = await request(app)
      .get("/api/it/overview")
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    expect(response.body.data.counts.people).toEqual({ total: 0, active: 0 });
    expect(response.body.data.counts.assets.total).toBe(0);
    expect(response.body.data.coverage.apiSurface).toEqual({
      overview: "available",
      crud: "assets,people",
      agentGateway: "not_exposed",
      remoteControl: "not_exposed",
    });
    expect(response.body.data.coverage.crud).toEqual({
      people: "available",
      assets: "available",
    });
    expect(prismaMock.person.count).toHaveBeenNthCalledWith(1, {
      where: { isActive: true },
    });
    expect(prismaMock.person.count).toHaveBeenNthCalledWith(2, {
      where: { isActive: true, status: "ACTIVE" },
    });
    expect(prismaMock.asset.count).toHaveBeenNthCalledWith(1, {
      where: { isActive: true },
    });
    expect(prismaMock.asset.count).toHaveBeenNthCalledWith(2, {
      where: { status: "ASSIGNED", isActive: true },
    });
    expect(prismaMock.asset.count).toHaveBeenNthCalledWith(3, {
      where: { status: "IN_REPAIR", isActive: true },
    });
  });
});
