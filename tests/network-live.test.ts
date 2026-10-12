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
import {
  AP_STALE_AFTER_MS,
  DEVICE_STALE_AFTER_MS,
  deriveDeviceStatus,
  planPortWrite,
  type StoredPort,
} from "../src/services/networkLive.service";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const URL_SNAPSHOT = "/api/network-collector/snapshot";
const COLLECTOR = "red-colector-test";
const SECRET = "s".repeat(43);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const collectorHeaders = { "x-service-client": COLLECTOR, Authorization: `Bearer ${SECRET}` };
const withCollector = (scopes = ["network:ingest"]) =>
  prismaMock.serviceClient.findFirst.mockResolvedValue({
    id: "sc-red",
    slug: COLLECTOR,
    isActive: true,
    secretHash: sha256(SECRET),
    scopes,
  } as any);
const auth = (role: "USER" | "AGENT" | "ADMIN") => ({
  Authorization: `Bearer ${signAccessToken({ role, id: "agent-1" })}`,
});

const port = (overrides: Record<string, unknown> = {}) => ({
  key: "ether1",
  name: "ether1-Red Empresa",
  position: 1,
  kind: "copper",
  adminUp: true,
  linkUp: true,
  speedMbps: 1000,
  fullDuplex: true,
  pvid: 200,
  neighbors: [],
  ...overrides,
});

const device = (overrides: Record<string, unknown> = {}) => ({
  key: "10.0.0.3",
  source: "routeros",
  role: "access",
  reachable: true,
  pollMs: 640,
  name: "SWITCH-TEST",
  managementIp: "10.0.0.3",
  macAddress: "74:4D:28:00:00:01",
  vendor: "MikroTik",
  model: "CRS326-24G-2S+",
  firmware: "RouterOS 6.47.4",
  uptimeSeconds: 100,
  ports: [port()],
  ...overrides,
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  collector: { version: "0.1.0", host: "SRV-TEST" },
  startedAt: "2026-10-12T15:00:00.1234567Z",
  finishedAt: "2026-10-12T15:00:05.1234567Z",
  devices: [device()],
  links: [],
  ...overrides,
});

const storedPort = (overrides: Partial<StoredPort> = {}): StoredPort => ({
  id: "port-1",
  key: "ether1",
  name: "ether1-Red Empresa",
  description: null,
  position: 1,
  kind: "copper",
  adminUp: true,
  linkUp: true,
  speedMbps: 1000,
  fullDuplex: true,
  pvid: 200,
  neighbors: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (work: any) =>
    typeof work === "function" ? work(prismaMock) : Promise.all(work),
  );
});

describe("Colector de red: ingesta", () => {
  it("exige credencial de servicio con el scope network:ingest", async () => {
    expect((await request(app).post(URL_SNAPSHOT).send(snapshot())).status).toBe(401);

    withCollector(["lab:ingest"]);
    const denied = await request(app).post(URL_SNAPSHOT).set(collectorHeaders).send(snapshot());
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("SERVICE_SCOPE_DENIED");
    expect(prismaMock.networkLiveDevice.findUnique).not.toHaveBeenCalled();
  });

  it("rechaza un envío sin la forma esperada", async () => {
    withCollector();
    const res = await request(app)
      .post(URL_SNAPSHOT)
      .set(collectorHeaders)
      .send(snapshot({ devices: [device({ role: "firewall" })] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("da de alta un equipo nuevo con sus puertos y anota el envío del colector", async () => {
    withCollector();
    prismaMock.networkLiveDevice.findUnique.mockResolvedValue(null);
    prismaMock.networkLiveDevice.create.mockResolvedValue({ id: "dev-1" } as any);
    prismaMock.networkLivePort.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(URL_SNAPSHOT)
      .set(collectorHeaders)
      .send(
        snapshot({
          devices: [
            device({
              name: "SW\u0007 Taller",
              macAddress: "74-4d-28-00-00-01",
              model: "x".repeat(200),
              ports: [
                port(),
                port({ name: "repetido" }),
                port({
                  key: "sfp1",
                  name: "sfp1-TRUNK",
                  kind: "sfp",
                  position: 25,
                  neighbors: [
                    { protocol: "lldp", name: "AP-1", mac: "fcecda000001", ip: "10.1.1.5", port: "eth0" },
                    { protocol: "raro", name: "Teléfono", mac: "192.168.33.24", ip: "no-es-una-ip" },
                  ],
                }),
              ],
            }),
          ],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ devices: 1, devicesOk: 1, links: 0 });

    const created = prismaMock.networkLiveDevice.create.mock.calls[0][0].data as any;
    expect(created).toMatchObject({
      collector: COLLECTOR,
      key: "10.0.0.3",
      name: "SW Taller",
      macAddress: "74:4D:28:00:00:01",
      reachable: true,
      portKeys: ["ether1", "sfp1"],
    });
    expect(created.model).toHaveLength(80);

    const ports = prismaMock.networkLivePort.createMany.mock.calls[0][0].data as any[];
    expect(ports.map((p) => p.key)).toEqual(["ether1", "sfp1"]);
    expect(ports[1]).toMatchObject({ deviceId: "dev-1", kind: "sfp" });
    // Lo que no es MAC ni IP válida queda en null en vez de rechazar el envío.
    expect(ports[1].neighbors).toEqual([
      { protocol: "other", name: "Teléfono", mac: null, ip: null, port: null, platform: null },
      { protocol: "lldp", name: "AP-1", mac: "FC:EC:DA:00:00:01", ip: "10.1.1.5", port: "eth0", platform: null },
    ]);
    expect(prismaMock.networkCollector.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: COLLECTOR },
        create: expect.objectContaining({ devicesTotal: 1, devicesOk: 1, version: "0.1.0" }),
      }),
    );
  });

  it("un equipo que no respondió conserva su identidad y sus puertos", async () => {
    withCollector();
    prismaMock.networkLiveDevice.findUnique.mockResolvedValue({ id: "dev-1" } as any);
    prismaMock.networkLiveDevice.update.mockResolvedValue({ id: "dev-1" } as any);

    const res = await request(app)
      .post(URL_SNAPSHOT)
      .set(collectorHeaders)
      .send(
        snapshot({
          devices: [{ key: "10.0.0.3", source: "routeros", role: "access", reachable: false, error: "Sin respuesta en el puerto 8729" }],
        }),
      );

    expect(res.status).toBe(200);
    const data = prismaMock.networkLiveDevice.update.mock.calls[0][0].data as any;
    expect(data).toMatchObject({ reachable: false, lastError: "Sin respuesta en el puerto 8729" });
    expect(data).not.toHaveProperty("name");
    expect(data).not.toHaveProperty("portKeys");
    expect(data).not.toHaveProperty("lastOkAt");
    expect(prismaMock.networkLivePort.findMany).not.toHaveBeenCalled();
  });

  it("guarda un enlace por par de equipos, prefiere LLDP y descarta equipos desconocidos", async () => {
    withCollector();
    prismaMock.networkLiveDevice.findUnique.mockResolvedValue({ id: "dev-b" } as any);
    prismaMock.networkLiveDevice.update.mockResolvedValue({ id: "dev-b" } as any);
    prismaMock.networkLivePort.findMany.mockResolvedValue([]);
    prismaMock.networkLiveDevice.findMany.mockResolvedValue([
      { id: "dev-a", key: "10.0.0.11" },
      { id: "dev-b", key: "10.0.0.3" },
    ] as any);
    prismaMock.networkLiveLink.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(URL_SNAPSHOT)
      .set(collectorHeaders)
      .send(
        snapshot({
          links: [
            { a: { device: "10.0.0.3", ports: ["sfp1", "sfp2"] }, b: { device: "10.0.0.11", ports: ["3"] }, source: "fdb" },
            { a: { device: "10.0.0.11", ports: ["3", "4"] }, b: { device: "10.0.0.3", ports: ["sfp1", "sfp2"] }, source: "lldp" },
            { a: { device: "10.0.0.3", ports: ["ether9"] }, b: { device: "ap-desconocido", ports: ["eth0"] }, source: "lldp" },
          ],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.data.links).toBe(1);
    expect(prismaMock.networkLiveLink.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.networkLiveLink.create.mock.calls[0][0].data).toMatchObject({
      collector: COLLECTOR,
      aDeviceId: "dev-a",
      aPorts: ["3", "4"],
      bDeviceId: "dev-b",
      bPorts: ["sfp1", "sfp2"],
      source: "lldp",
    });
  });

  it("no reescribe un enlace igual hasta que pasa el intervalo de refresco", async () => {
    withCollector();
    prismaMock.networkLiveDevice.findUnique.mockResolvedValue({ id: "dev-b" } as any);
    prismaMock.networkLiveDevice.update.mockResolvedValue({ id: "dev-b" } as any);
    prismaMock.networkLivePort.findMany.mockResolvedValue([]);
    prismaMock.networkLiveDevice.findMany.mockResolvedValue([
      { id: "dev-a", key: "10.0.0.11" },
      { id: "dev-b", key: "10.0.0.3" },
    ] as any);
    prismaMock.networkLiveLink.findMany.mockResolvedValue([
      { id: "l1", aDeviceId: "dev-a", bDeviceId: "dev-b", aPorts: ["3"], bPorts: ["sfp1"], source: "fdb", lastSeenAt: new Date() },
    ] as any);

    const res = await request(app)
      .post(URL_SNAPSHOT)
      .set(collectorHeaders)
      .send(snapshot({ links: [{ a: { device: "10.0.0.11", ports: ["3"] }, b: { device: "10.0.0.3", ports: ["sfp1"] }, source: "fdb" }] }));

    expect(res.status).toBe(200);
    expect(prismaMock.networkLiveLink.update).not.toHaveBeenCalled();
    expect(prismaMock.networkLiveLink.create).not.toHaveBeenCalled();
  });
});

describe("Colector de red: escritura de puertos", () => {
  const now = new Date("2026-10-12T15:00:00Z");

  it("no escribe nada si el puerto no cambió, aunque JSONB devuelva las claves en otro orden", () => {
    const stored = storedPort({
      neighbors: [{ ip: "10.1.1.5", mac: "FC:EC:DA:00:00:01", name: "AP-1", port: "eth0", platform: null, protocol: "lldp" }],
    });
    const incoming = port({
      neighbors: [{ protocol: "lldp", name: "AP-1", mac: "FC:EC:DA:00:00:01", ip: "10.1.1.5", port: "eth0" }],
    }) as any;
    expect(planPortWrite(stored, incoming, now)).toBeNull();
  });

  it("marca el cambio de enlace cuando cae o cambia la velocidad, no cuando lo renombran", () => {
    const down = planPortWrite(storedPort(), port({ linkUp: false, speedMbps: null }) as any, now);
    expect(down).toMatchObject({ kind: "update", data: { linkUp: false, speedMbps: null, linkChangedAt: now } });

    const renamed = planPortWrite(storedPort(), port({ name: "ether1-Oficina" }) as any, now);
    expect(renamed?.kind).toBe("update");
    expect(renamed?.data).not.toHaveProperty("linkChangedAt");
  });
});

describe("Pantalla Red en vivo", () => {
  it("es sólo para AGENT y ADMIN", async () => {
    expect((await request(app).get("/api/it/network/live")).status).toBe(401);
    expect((await request(app).get("/api/it/network/live").set(auth("USER"))).status).toBe(403);
  });

  it("deriva el estado por edad y oculta puertos y enlaces que dejaron de aparecer", async () => {
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);
    const base = {
      collector: COLLECTOR,
      managementIp: null,
      macAddress: null,
      vendor: null,
      model: null,
      firmware: null,
      serialNumber: null,
      uptimeSeconds: null,
      clients: null,
      lastError: null,
      lastPollMs: 500,
      lastOkAt: null,
      alertsMuted: false,
      createdAt: ago(86_400_000),
      updatedAt: ago(30_000),
    };
    const livePort = (key: string) => ({
      id: `p-${key}`,
      deviceId: "d1",
      key,
      name: key,
      description: null,
      position: 1,
      kind: "copper",
      adminUp: true,
      linkUp: true,
      speedMbps: 1000,
      fullDuplex: true,
      pvid: 200,
      neighbors: null,
      linkChangedAt: null,
      updatedAt: ago(30_000),
    });
    prismaMock.networkCollector.findMany.mockResolvedValue([
      {
        slug: COLLECTOR,
        version: "0.1.0",
        host: "SRV-TEST",
        lastStartedAt: ago(35_000),
        lastFinishedAt: ago(31_000),
        lastReceivedAt: ago(30_000),
        devicesTotal: 3,
        devicesOk: 2,
        createdAt: ago(86_400_000),
      },
    ] as any);
    prismaMock.networkLiveDevice.findMany.mockResolvedValue([
      { ...base, id: "d1", key: "10.0.0.3", source: "routeros", role: "access", name: "SW", reachable: true, lastPolledAt: ago(30_000), portKeys: ["ether1"], ports: [livePort("ether1"), livePort("ether99")] },
      { ...base, id: "d2", key: "10.0.0.6", source: "snmp", role: "access", name: "HPE", reachable: false, lastError: "timeout", lastPolledAt: ago(30_000), portKeys: [], ports: [] },
      { ...base, id: "d3", key: "ap-x", source: "unifi", role: "ap", name: "AP", reachable: true, lastPolledAt: ago(AP_STALE_AFTER_MS + 60_000), portKeys: [], ports: [] },
    ] as any);
    prismaMock.networkLiveLink.findMany.mockResolvedValue([
      { id: "l1", collector: COLLECTOR, aDeviceId: "d1", aPorts: ["ether1"], bDeviceId: "d2", bPorts: ["1"], source: "fdb", firstSeenAt: ago(86_400_000), lastSeenAt: ago(60_000) },
      { id: "l2", collector: COLLECTOR, aDeviceId: "d1", aPorts: ["ether2"], bDeviceId: "d3", bPorts: ["eth0"], source: "lldp", firstSeenAt: ago(86_400_000), lastSeenAt: ago(60 * 60_000) },
    ] as any);
    prismaMock.networkLiveEndpoint.findMany.mockResolvedValue([]);
    prismaMock.networkLiveAlert.findMany.mockResolvedValue([
      { id: "al-1", collector: COLLECTOR, kind: "device_down", deviceId: "d2", openedAt: ago(5 * 60_000), resolvedAt: null, lastNotifiedAt: ago(5 * 60_000), ticketId: "t-1", detail: "HPE no responde desde hace 8 min." },
    ] as any);

    const res = await request(app).get("/api/it/network/live").set(auth("AGENT"));

    expect(res.status).toBe(200);
    const { collectors, devices, links, alerts } = res.body.data;
    expect(collectors[0]).toMatchObject({ slug: COLLECTOR, stale: false, devicesOk: 2 });
    expect(devices.map((d: any) => d.status)).toEqual(["ok", "down", "stale"]);
    expect(devices[0].ports.map((p: any) => p.key)).toEqual(["ether1"]);
    expect(devices[0].ports[0].neighbors).toEqual([]);
    expect(devices[0].alertsMuted).toBe(false);
    expect(links.map((l: any) => l.id)).toEqual(["l1"]);
    expect(alerts).toEqual([
      expect.objectContaining({ id: "al-1", kind: "device_down", deviceId: "d2", ticketId: "t-1", detail: "HPE no responde desde hace 8 min." }),
    ]);
    expect(prismaMock.networkLiveAlert.findMany.mock.calls[0][0]).toMatchObject({ where: { resolvedAt: null } });
  });

  it("los APs tienen más margen que los switches antes de pasar a 'sin datos'", () => {
    const now = new Date();
    const polled = new Date(now.getTime() - DEVICE_STALE_AFTER_MS - 60_000);
    expect(deriveDeviceStatus({ source: "routeros", reachable: true, lastPolledAt: polled }, now)).toBe("stale");
    expect(deriveDeviceStatus({ source: "unifi", reachable: true, lastPolledAt: polled }, now)).toBe("ok");
  });
});

describe("Red en vivo F2: equipos finales", () => {
  const storedEndpoint = (overrides: Record<string, unknown> = {}) => ({
    id: "ep-1",
    macAddress: "AA:BB:CC:00:00:01",
    deviceId: "dev-s1",
    portKey: "ether5",
    vlan: 200,
    ipAddress: "192.168.100.41",
    hostname: "PC-ADMIN-01",
    viaDeviceId: null,
    sharedPort: false,
    lastSeenAt: new Date(),
    ...overrides,
  });

  const withDevices = () => {
    prismaMock.networkLiveDevice.findUnique.mockResolvedValue({ id: "dev-s1" } as any);
    prismaMock.networkLiveDevice.update.mockResolvedValue({ id: "dev-s1" } as any);
    prismaMock.networkLivePort.findMany.mockResolvedValue([]);
    prismaMock.networkLiveDevice.findMany.mockResolvedValue([
      { id: "dev-s1", key: "10.0.0.3" },
      { id: "dev-ap", key: "ap-fc:ec:da:00:00:01" },
    ] as any);
  };

  it("da de alta los nuevos, conserva la IP conocida, marca la mudanza y toca lo que no cambió", async () => {
    withCollector();
    withDevices();
    const old = new Date(Date.now() - 6 * 60_000);
    prismaMock.networkLiveEndpoint.findMany.mockResolvedValue([
      storedEndpoint(),
      storedEndpoint({ id: "ep-2", macAddress: "AA:BB:CC:00:00:02", portKey: "ether6", hostname: null, ipAddress: "192.168.100.42", lastSeenAt: old }),
      storedEndpoint({ id: "ep-3", macAddress: "AA:BB:CC:00:00:03", portKey: "ether7", hostname: null, ipAddress: null, lastSeenAt: old }),
    ] as any);

    const res = await request(app)
      .post(URL_SNAPSHOT)
      .set(collectorHeaders)
      .send(
        snapshot({
          endpoints: [
            // Nuevo, cliente Wi-Fi de un AP.
            { mac: "aa-bb-cc-00-00-09", device: "10.0.0.3", port: "ether10", vlan: 600, ip: "10.6.0.5", hostname: "celular", via: "ap-fc:ec:da:00:00:01" },
            // Se mudó del ether5 al ether8: sin IP esta vez, se conserva la anterior.
            { mac: "AA:BB:CC:00:00:01", device: "10.0.0.3", port: "ether8", vlan: 200 },
            // Igual que antes y hace 6 min que no se tocaba.
            { mac: "AA:BB:CC:00:00:02", device: "10.0.0.3", port: "ether6", vlan: 200, ip: "192.168.100.42" },
            // Switch desconocido y MAC inválida: se descartan.
            { mac: "AA:BB:CC:00:00:04", device: "10.0.0.99", port: "1" },
            { mac: "no-es-mac", device: "10.0.0.3", port: "ether9" },
          ],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.data.endpoints).toBe(3);
    const created = prismaMock.networkLiveEndpoint.createMany.mock.calls[0][0].data as any[];
    expect(created).toEqual([
      expect.objectContaining({ macAddress: "AA:BB:CC:00:00:09", deviceId: "dev-s1", portKey: "ether10", viaDeviceId: "dev-ap", hostname: "celular", collector: COLLECTOR }),
    ]);
    const moved = prismaMock.networkLiveEndpoint.update.mock.calls[0][0] as any;
    expect(moved.where).toEqual({ id: "ep-1" });
    expect(moved.data).toMatchObject({ portKey: "ether8", ipAddress: "192.168.100.41", hostname: "PC-ADMIN-01" });
    expect(moved.data.movedAt).toBeInstanceOf(Date);
    expect(prismaMock.networkLiveEndpoint.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["ep-2"] } } }),
    );
  });

  it("un colector viejo que no manda equipos finales no los toca", async () => {
    withCollector();
    withDevices();
    const res = await request(app).post(URL_SNAPSHOT).set(collectorHeaders).send(snapshot());
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty("endpoints");
    expect(prismaMock.networkLiveEndpoint.findMany).not.toHaveBeenCalled();
  });

  it("la vista suma los equipos conectados y los reconoce por el agente (MAC o IP reciente)", async () => {
    const now = Date.now();
    prismaMock.networkCollector.findMany.mockResolvedValue([
      { slug: COLLECTOR, version: "0.2.0", host: "SRV", lastStartedAt: new Date(now), lastFinishedAt: new Date(now), lastReceivedAt: new Date(now - 20_000), devicesTotal: 1, devicesOk: 1, createdAt: new Date(now) },
    ] as any);
    prismaMock.networkLiveDevice.findMany.mockResolvedValue([]);
    prismaMock.networkLiveLink.findMany.mockResolvedValue([]);
    prismaMock.networkLiveAlert.findMany.mockResolvedValue([]);
    const endpoint = (mac: string, ip: string | null) => ({
      id: mac, collector: COLLECTOR, macAddress: mac, deviceId: "dev-s1", portKey: "ether5", vlan: 200, ipAddress: ip,
      hostname: null, viaDeviceId: null, sharedPort: false, firstSeenAt: new Date(now - 3_600_000), lastSeenAt: new Date(now - 30_000), movedAt: null,
    });
    prismaMock.networkLiveEndpoint.findMany.mockResolvedValue([
      endpoint("AA:BB:CC:00:00:01", "192.168.100.41"),
      endpoint("AA:BB:CC:00:00:02", "192.168.100.42"),
      endpoint("AA:BB:CC:00:00:03", "192.168.100.43"),
    ] as any);
    prismaMock.agentDevice.findMany.mockResolvedValue([
      { id: "ag-1", hostname: "PUESTO041", loggedInUser: "GRF\\jperez", primaryMac: "AA:BB:CC:00:00:01", primaryIp: "192.168.100.99", lastSeenAt: new Date(now), assetId: "as-1" },
      { id: "ag-2", hostname: "PUESTO042", loggedInUser: null, primaryMac: "11:22:33:44:55:66", primaryIp: "192.168.100.42", lastSeenAt: new Date(now - 60_000), assetId: null },
      { id: "ag-3", hostname: "PUESTO-VIEJO", loggedInUser: null, primaryMac: "11:22:33:44:55:77", primaryIp: "192.168.100.43", lastSeenAt: new Date(now - 3 * 86_400_000), assetId: null },
    ] as any);

    const res = await request(app).get("/api/it/network/live").set(auth("ADMIN"));

    expect(res.status).toBe(200);
    const endpoints = res.body.data.endpoints;
    expect(endpoints.map((item: any) => item.agent?.hostname ?? null)).toEqual(["PUESTO041", "PUESTO042", null]);
    expect(endpoints[0]).toMatchObject({ mac: "AA:BB:CC:00:00:01", portKey: "ether5", vlan: 200, ip: "192.168.100.41" });
    const query = prismaMock.networkLiveEndpoint.findMany.mock.calls[0][0] as any;
    expect(query.where.lastSeenAt.gte.getTime()).toBe(now - 20_000 - 10 * 60_000);
  });

  it("busca por usuario o nombre de PC vía el agente y dice si sigue conectado", async () => {
    const now = Date.now();
    prismaMock.agentDevice.findMany
      .mockResolvedValueOnce([{ primaryMac: "AA:BB:CC:00:00:01", primaryIp: "192.168.100.41" }] as any)
      .mockResolvedValueOnce([
        { id: "ag-1", hostname: "PUESTO041", loggedInUser: "GRF\\jperez", primaryMac: "AA:BB:CC:00:00:01", primaryIp: "192.168.100.41", lastSeenAt: new Date(now), assetId: null },
      ] as any);
    prismaMock.networkLiveEndpoint.findMany.mockResolvedValue([
      {
        id: "ep-1", collector: COLLECTOR, macAddress: "AA:BB:CC:00:00:01", deviceId: "dev-s1", portKey: "ether5", vlan: 200,
        ipAddress: "192.168.100.41", hostname: null, viaDeviceId: null, sharedPort: false,
        firstSeenAt: new Date(now - 86_400_000), lastSeenAt: new Date(now - 40 * 60_000), movedAt: null,
        device: { id: "dev-s1", name: "SWITCH-CRS-TALLER", role: "access" },
      },
    ] as any);
    prismaMock.networkCollector.findMany.mockResolvedValue([{ slug: COLLECTOR, lastReceivedAt: new Date(now - 10_000) }] as any);

    const res = await request(app).get("/api/it/network/live/search").query({ q: "jperez" }).set(auth("AGENT"));

    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      expect.objectContaining({ mac: "AA:BB:CC:00:00:01", deviceName: "SWITCH-CRS-TALLER", online: false, agent: expect.objectContaining({ hostname: "PUESTO041" }) }),
    ]);
    const where = prismaMock.networkLiveEndpoint.findMany.mock.calls[0][0] as any;
    expect(where.where.OR).toEqual(
      expect.arrayContaining([{ macAddress: { in: ["AA:BB:CC:00:00:01"] } }]),
    );
  });

  it("busca por MAC en cualquier formato y valida la consulta", async () => {
    prismaMock.networkLiveEndpoint.findMany.mockResolvedValue([]);
    prismaMock.networkCollector.findMany.mockResolvedValue([]);
    const res = await request(app).get("/api/it/network/live/search").query({ q: "aabb.cc00.0001" }).set(auth("ADMIN"));
    expect(res.status).toBe(200);
    expect((prismaMock.networkLiveEndpoint.findMany.mock.calls[0][0] as any).where.OR).toEqual([{ macAddress: "AA:BB:CC:00:00:01" }]);
    expect(prismaMock.agentDevice.findMany).not.toHaveBeenCalled();

    expect((await request(app).get("/api/it/network/live/search").query({ q: "a" }).set(auth("ADMIN"))).status).toBe(400);
    expect((await request(app).get("/api/it/network/live/search").query({ q: "pc" }).set(auth("USER"))).status).toBe(403);
  });
});
