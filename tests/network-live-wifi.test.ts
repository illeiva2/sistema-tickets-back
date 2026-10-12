import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

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
import { WIFI_VISIBLE_MS } from "../src/services/networkLive.service";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const COLLECTOR = "red-colector-test";
const SECRET = "s".repeat(43);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const collectorHeaders = { "x-service-client": COLLECTOR, Authorization: `Bearer ${SECRET}` };
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  collector: { version: "0.3.0", host: "SRV-TEST" },
  startedAt: "2026-10-12T22:30:00.000Z",
  finishedAt: "2026-10-12T22:30:25.000Z",
  devices: [],
  links: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (work: any) =>
    typeof work === "function" ? work(prismaMock) : Promise.all(work),
  );
  prismaMock.serviceClient.findFirst.mockResolvedValue({
    id: "sc-red",
    slug: COLLECTOR,
    isActive: true,
    secretHash: sha256(SECRET),
    scopes: ["network:ingest"],
  } as any);
});

describe("Red en vivo: clientes Wi-Fi", () => {
  it("guarda los clientes de cada AP: alta, actualización y lo raro en null", async () => {
    prismaMock.networkLiveDevice.findMany.mockResolvedValue([{ id: "dev-ap1", key: "ap-fc:ec:da:3d:af:54" }] as any);
    prismaMock.networkLiveWifiClient.findMany.mockResolvedValue([{ id: "wc-1", macAddress: "AA:BB:CC:00:00:04" }] as any);

    const res = await request(app)
      .post("/api/network-collector/snapshot")
      .set(collectorHeaders)
      .send(
        snapshot({
          wifiClients: [
            { mac: "aa:bb:cc:00:00:04", ap: "ap-fc:ec:da:3d:af:54", ssid: "GRF_Privado", band: "5", channel: 44, signal: -61, txKbps: 866700, rxKbps: 780000, uptimeSeconds: 3600, hostname: "notebook-ana", ip: "192.168.110.20", vlan: 200 },
            { mac: "AA-BB-CC-00-00-05", ap: "ap-fc:ec:da:3d:af:54", ssid: "AERO", band: "9", signal: 12, channel: 6 },
            { mac: "AA:BB:CC:00:00:06", ap: "ap-desconocido", ssid: "GRF" },
            { mac: "no-es-mac", ap: "ap-fc:ec:da:3d:af:54" },
          ],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.data.wifiClients).toBe(2);
    expect(prismaMock.networkLiveWifiClient.update).toHaveBeenCalledWith({
      where: { id: "wc-1" },
      data: expect.objectContaining({ apDeviceId: "dev-ap1", ssid: "GRF_Privado", band: "5", signal: -61, ipAddress: "192.168.110.20", vlan: 200 }),
    });
    const created = (prismaMock.networkLiveWifiClient.createMany.mock.calls[0][0] as any).data;
    expect(created).toEqual([
      expect.objectContaining({ collector: COLLECTOR, macAddress: "AA:BB:CC:00:00:05", apDeviceId: "dev-ap1", ssid: "AERO", band: null, signal: null, channel: 6 }),
    ]);
  });

  it("un colector sin clientes Wi-Fi (corrida sin UniFi o versión vieja) no los toca", async () => {
    const res = await request(app).post("/api/network-collector/snapshot").set(collectorHeaders).send(snapshot());
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty("wifiClients");
    expect(prismaMock.networkLiveWifiClient.findMany).not.toHaveBeenCalled();
  });

  it("la vista suma los clientes de la última lectura de UniFi, con la PC del agente", async () => {
    const now = Date.now();
    prismaMock.networkCollector.findMany.mockResolvedValue([
      { slug: COLLECTOR, version: "0.3.0", host: "SRV", lastStartedAt: new Date(now), lastFinishedAt: new Date(now), lastReceivedAt: new Date(now - 20_000), devicesTotal: 1, devicesOk: 1, createdAt: new Date(now) },
    ] as any);
    prismaMock.networkLiveDevice.findMany.mockResolvedValue([]);
    prismaMock.networkLiveLink.findMany.mockResolvedValue([]);
    prismaMock.networkLiveEndpoint.findMany.mockResolvedValue([]);
    prismaMock.networkLiveAlert.findMany.mockResolvedValue([]);
    prismaMock.networkLiveWifiClient.findMany.mockResolvedValue([
      {
        id: "wc-1", collector: COLLECTOR, macAddress: "AA:BB:CC:00:00:04", apDeviceId: "dev-ap1", ssid: "GRF_Privado", band: "5", channel: 44, signal: -61,
        txKbps: 866700, rxKbps: 780000, uptimeSeconds: 3600, hostname: "notebook-ana", ipAddress: "192.168.110.20", vlan: 200,
        firstSeenAt: new Date(now - 86_400_000), lastSeenAt: new Date(now - 60_000),
      },
    ] as any);
    prismaMock.agentDevice.findMany.mockResolvedValue([
      { id: "ag-1", hostname: "NOTEBOOK-ANA", loggedInUser: "GRF\\ana", primaryMac: "AA:BB:CC:00:00:04", primaryIp: null, lastSeenAt: new Date(now), assetId: null },
    ] as any);

    const res = await request(app)
      .get("/api/it/network/live")
      .set({ Authorization: `Bearer ${signAccessToken({ role: "AGENT", id: "agent-1" })}` });

    expect(res.status).toBe(200);
    expect(res.body.data.wifiClients).toEqual([
      expect.objectContaining({
        mac: "AA:BB:CC:00:00:04",
        apDeviceId: "dev-ap1",
        ssid: "GRF_Privado",
        band: "5",
        signal: -61,
        ip: "192.168.110.20",
        agent: expect.objectContaining({ hostname: "NOTEBOOK-ANA", loggedInUser: "GRF\\ana" }),
      }),
    ]);
    const query = prismaMock.networkLiveWifiClient.findMany.mock.calls[0][0] as any;
    expect(query.where.lastSeenAt.gte.getTime()).toBe(now - 20_000 - WIFI_VISIBLE_MS);
  });
});
