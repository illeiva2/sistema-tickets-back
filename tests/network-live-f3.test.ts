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

vi.mock("../src/services/push.service", () => ({
  default: { sendToUser: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../src/services/tickets.service", () => ({
  TicketsService: { createTicket: vi.fn().mockResolvedValue({ id: "ticket-1" }) },
}));

import type { PrismaClient } from "@prisma/client";
import type { DeepMockProxy } from "vitest-mock-extended";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import { deviceEvents, portEvent } from "../src/services/networkLive.events";
import type { StoredPort } from "../src/services/networkLive.service";
import NetworkWatchdog, { AP_DOWN_ALERT_MS, RE_NOTIFY_MS } from "../src/services/networkLive.watchdog";
import PushService from "../src/services/push.service";
import { TicketsService } from "../src/services/tickets.service";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const pushMock = PushService.sendToUser as unknown as ReturnType<typeof vi.fn>;
const ticketMock = TicketsService.createTicket as unknown as ReturnType<typeof vi.fn>;
const app = createApp();
const COLLECTOR = "red-colector-test";
const SECRET = "s".repeat(43);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const collectorHeaders = { "x-service-client": COLLECTOR, Authorization: `Bearer ${SECRET}` };
const auth = (role: "USER" | "AGENT" | "ADMIN") => ({
  Authorization: `Bearer ${signAccessToken({ role, id: "agent-1" })}`,
});
const at = new Date("2026-10-12T21:00:00Z");
const ago = (ms: number) => new Date(at.getTime() - ms);
const MIN = 60_000;

const port = (overrides: Record<string, unknown> = {}) => ({
  key: "ether1",
  name: "ether1-Oficina",
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

const storedPort = (overrides: Partial<StoredPort> = {}): StoredPort => ({
  id: "port-1",
  key: "ether1",
  name: "ether1-Oficina",
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

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  collector: { version: "0.2.1", host: "SRV-TEST" },
  startedAt: "2026-10-12T21:00:00.000Z",
  finishedAt: "2026-10-12T21:00:20.000Z",
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
  prismaMock.user.findMany.mockResolvedValue([{ id: "admin-1" }, { id: "admin-2" }] as any);
  prismaMock.networkLiveAlert.create.mockImplementation(async (args: any) => ({ id: "alert-new", ...args.data }));
  ticketMock.mockResolvedValue({ id: "ticket-1" });
});

describe("Red en vivo F3: qué cuenta como cambio", () => {
  const device = { key: "10.0.0.3", source: "routeros", role: "access" };

  it("equipo nuevo, caído, de vuelta (reiniciado o no) y reinicio sin caída", () => {
    expect(deviceEvents("c", "d", null, { ...device, reachable: true }, at)).toEqual([
      { collector: "c", deviceId: "d", at, kind: "device_new" },
    ]);
    expect(deviceEvents("c", "d", { reachable: true, uptimeSeconds: 900 }, { ...device, reachable: false, error: "timeout" }, at)[0])
      .toMatchObject({ kind: "device_down", detail: { error: "timeout" } });
    expect(deviceEvents("c", "d", { reachable: false, uptimeSeconds: 900 }, { ...device, reachable: true, uptimeSeconds: 40 }, at)[0])
      .toMatchObject({ kind: "device_up", detail: { restarted: true } });
    expect(deviceEvents("c", "d", { reachable: false, uptimeSeconds: 900 }, { ...device, reachable: true, uptimeSeconds: 960 }, at)[0])
      .toMatchObject({ kind: "device_up", detail: { restarted: false } });
    expect(deviceEvents("c", "d", { reachable: true, uptimeSeconds: 900 }, { ...device, reachable: true, uptimeSeconds: 30 }, at)[0])
      .toMatchObject({ kind: "device_restart" });
    expect(deviceEvents("c", "d", { reachable: true, uptimeSeconds: 900 }, { ...device, reachable: true, uptimeSeconds: 960 }, at)).toEqual([]);
  });

  it("puerto que cae, vuelve o cambia de velocidad; renombrarlo o darlo de alta no es un evento", () => {
    expect(portEvent("c", "d", storedPort(), port({ linkUp: false, speedMbps: null }) as any, at)).toMatchObject({
      kind: "port_down",
      portKey: "ether1",
      detail: { name: "ether1-Oficina" },
    });
    expect(portEvent("c", "d", storedPort({ linkUp: false, speedMbps: null }), port() as any, at)).toMatchObject({
      kind: "port_up",
      detail: { speedMbps: 1000 },
    });
    expect(portEvent("c", "d", storedPort(), port({ speedMbps: 100 }) as any, at)).toMatchObject({
      kind: "port_speed",
      detail: { from: 1000, to: 100 },
    });
    expect(portEvent("c", "d", storedPort(), port({ name: "ether1-Compras" }) as any, at)).toBeNull();
    expect(portEvent("c", "d", undefined, port() as any, at)).toBeNull();
  });
});

describe("Red en vivo F3: la ingesta escribe el historial", () => {
  it("un switch que deja de responder y los puertos que cambian quedan como eventos", async () => {
    prismaMock.networkLiveDevice.findUnique
      .mockResolvedValueOnce({ id: "dev-1", reachable: true, uptimeSeconds: 900 } as any)
      .mockResolvedValueOnce({ id: "dev-2", reachable: true, uptimeSeconds: 900 } as any);
    prismaMock.networkLiveDevice.update
      .mockResolvedValueOnce({ id: "dev-1" } as any)
      .mockResolvedValueOnce({ id: "dev-2" } as any);
    prismaMock.networkLivePort.findMany.mockResolvedValue([
      storedPort(),
      storedPort({ id: "port-2", key: "ether2", name: "ether2" }),
    ] as any);

    const res = await request(app)
      .post("/api/network-collector/snapshot")
      .set(collectorHeaders)
      .send(
        snapshot({
          devices: [
            { key: "10.0.0.5", source: "routeros", role: "access", reachable: false, error: "Sin respuesta" },
            {
              key: "10.0.0.3",
              source: "routeros",
              role: "access",
              reachable: true,
              name: "SW",
              uptimeSeconds: 960,
              ports: [port({ linkUp: false, speedMbps: null }), port({ key: "ether2", name: "ether2", speedMbps: 100 })],
            },
          ],
        }),
      );

    expect(res.status).toBe(200);
    const written = prismaMock.networkLiveEvent.createMany.mock.calls.map((call) => (call[0] as any).data);
    expect(written).toHaveLength(2);
    expect(written[0]).toEqual([expect.objectContaining({ kind: "device_down", deviceId: "dev-1", collector: COLLECTOR })]);
    expect(written[1].map((event: any) => [event.kind, event.portKey])).toEqual([
      ["port_down", "ether1"],
      ["port_speed", "ether2"],
    ]);
  });

  it("un enlace nuevo queda con los puertos de los dos lados", async () => {
    prismaMock.networkLiveDevice.findMany.mockResolvedValue([
      { id: "dev-a", key: "10.0.0.11" },
      { id: "dev-b", key: "10.0.0.3" },
    ] as any);
    prismaMock.networkLiveLink.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post("/api/network-collector/snapshot")
      .set(collectorHeaders)
      .send(snapshot({ links: [{ a: { device: "10.0.0.11", ports: ["3", "4"] }, b: { device: "10.0.0.3", ports: ["sfp1"] }, source: "lldp" }] }));

    expect(res.status).toBe(200);
    expect((prismaMock.networkLiveEvent.createMany.mock.calls[0][0] as any).data).toEqual([
      expect.objectContaining({
        kind: "link_new",
        deviceId: "dev-a",
        portKey: "3+4",
        peerDeviceId: "dev-b",
        peerPortKey: "sfp1",
        detail: { source: "lldp", aPorts: ["3", "4"], bPorts: ["sfp1"] },
      }),
    ]);
  });

  it("un equipo final nuevo y otro que se mudó de puerto (con de dónde venía)", async () => {
    prismaMock.networkLiveDevice.findMany.mockResolvedValue([
      { id: "dev-s1", key: "10.0.0.3" },
      { id: "dev-s2", key: "10.0.0.6" },
    ] as any);
    prismaMock.networkLiveEndpoint.findMany.mockResolvedValue([
      {
        id: "ep-1",
        macAddress: "AA:BB:CC:00:00:01",
        deviceId: "dev-s1",
        portKey: "ether5",
        vlan: 200,
        ipAddress: "192.168.100.41",
        hostname: "pc-1",
        viaDeviceId: null,
        sharedPort: false,
        lastSeenAt: ago(MIN),
      },
    ] as any);

    const res = await request(app)
      .post("/api/network-collector/snapshot")
      .set(collectorHeaders)
      .send(
        snapshot({
          endpoints: [
            { mac: "AA:BB:CC:00:00:01", device: "10.0.0.6", port: "12", vlan: 200 },
            { mac: "AA:BB:CC:00:00:02", device: "10.0.0.3", port: "ether7", vlan: 200 },
          ],
        }),
      );

    expect(res.status).toBe(200);
    const events = (prismaMock.networkLiveEvent.createMany.mock.calls[0][0] as any).data;
    expect(events).toEqual([
      expect.objectContaining({
        kind: "endpoint_moved",
        macAddress: "AA:BB:CC:00:00:01",
        deviceId: "dev-s2",
        portKey: "12",
        peerDeviceId: "dev-s1",
        peerPortKey: "ether5",
      }),
      expect.objectContaining({ kind: "endpoint_new", macAddress: "AA:BB:CC:00:00:02", deviceId: "dev-s1", portKey: "ether7" }),
    ]);
  });
});

describe("Red en vivo F3: historial y silencio por API", () => {
  it("el historial es para AGENT y ADMIN y valida los filtros", async () => {
    expect((await request(app).get("/api/it/network/live/events")).status).toBe(401);
    expect((await request(app).get("/api/it/network/live/events").set(auth("USER"))).status).toBe(403);
    for (const query of ["kinds=device_down,inventado", "portKey=ether1", "mac=no-es-mac", "limit=9999"]) {
      const res = await request(app).get(`/api/it/network/live/events?${query}`).set(auth("AGENT"));
      expect(res.status, query).toBe(400);
    }
  });

  it("filtra por equipo y puerto incluyendo el otro lado, nombra el equipo final y avisa si hay más", async () => {
    prismaMock.networkLiveEvent.findMany.mockResolvedValue([
      { id: "e2", at: ago(MIN), kind: "endpoint_moved", deviceId: "dev-s2", portKey: "12", macAddress: "AA:BB:CC:00:00:01", peerDeviceId: "dev-s1", peerPortKey: "ether5", detail: { vlan: 200 } },
      { id: "e1", at: ago(2 * MIN), kind: "port_down", deviceId: "dev-s1", portKey: "ether5", macAddress: null, peerDeviceId: null, peerPortKey: null, detail: { name: "ether5" } },
      { id: "e0", at: ago(3 * MIN), kind: "port_up", deviceId: "dev-s1", portKey: "ether5", macAddress: null, peerDeviceId: null, peerPortKey: null, detail: null },
    ] as any);
    prismaMock.networkLiveEndpoint.findMany.mockResolvedValue([
      { macAddress: "AA:BB:CC:00:00:01", ipAddress: "192.168.100.41", hostname: "pc-1" },
    ] as any);
    prismaMock.agentDevice.findMany.mockResolvedValue([
      { id: "ag-1", hostname: "PUESTO041", loggedInUser: "GRF\\jperez", primaryMac: "AA:BB:CC:00:00:01", primaryIp: null, lastSeenAt: new Date(), assetId: null },
    ] as any);

    const res = await request(app)
      .get("/api/it/network/live/events?deviceId=dev-s1&portKey=ether5&limit=2&since=2026-10-12T00:00:00Z")
      .set(auth("ADMIN"));

    expect(res.status).toBe(200);
    const query = prismaMock.networkLiveEvent.findMany.mock.calls[0][0] as any;
    expect(query.where.OR).toEqual([
      { deviceId: "dev-s1", portKey: "ether5" },
      { peerDeviceId: "dev-s1", peerPortKey: "ether5" },
    ]);
    expect(query.where.at.gte.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(query.take).toBe(3);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.events.map((event: any) => event.id)).toEqual(["e2", "e1"]);
    expect(res.body.data.events[0].endpoint).toMatchObject({ hostname: "pc-1", agent: { hostname: "PUESTO041" } });
    expect(res.body.data.events[1].endpoint).toBeNull();
  });

  it("silenciar es sólo para ADMIN y cierra el aviso abierto sin notificar", async () => {
    expect((await request(app).patch("/api/it/network/live/devices/dev-1/alerts").set(auth("AGENT")).send({ muted: true })).status).toBe(403);

    prismaMock.networkLiveDevice.findUnique.mockResolvedValueOnce(null);
    expect((await request(app).patch("/api/it/network/live/devices/nada/alerts").set(auth("ADMIN")).send({ muted: true })).status).toBe(404);

    prismaMock.networkLiveDevice.findUnique.mockResolvedValue({ id: "dev-1" } as any);
    prismaMock.networkLiveDevice.update.mockResolvedValue({ id: "dev-1", name: "AP-007", alertsMuted: true } as any);
    prismaMock.networkLiveAlert.findMany.mockResolvedValue([
      { id: "al-1", collector: COLLECTOR, kind: "device_down", deviceId: "dev-1", openedAt: ago(60 * MIN), resolvedAt: null, lastNotifiedAt: ago(60 * MIN), ticketId: "t-9", detail: "x" },
    ] as any);

    const res = await request(app).patch("/api/it/network/live/devices/dev-1/alerts").set(auth("ADMIN")).send({ muted: true });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ alertsMuted: true });
    expect(prismaMock.networkLiveAlert.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "al-1" }, data: { resolvedAt: expect.any(Date) } }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t-9" }, data: expect.objectContaining({ status: "RESOLVED" }) }));
    expect(pushMock).not.toHaveBeenCalled();
    expect((await request(app).patch("/api/it/network/live/devices/dev-1/alerts").set(auth("ADMIN")).send({ muted: "sí" })).status).toBe(400);
  });
});

describe("Red en vivo F3: vigilancia y avisos", () => {
  const collector = (lastReceivedAt: Date) => ({
    slug: COLLECTOR,
    host: "SRV-DATOS",
    version: "0.2.1",
    lastReceivedAt,
    lastStartedAt: lastReceivedAt,
    lastFinishedAt: lastReceivedAt,
    devicesTotal: 4,
    devicesOk: 2,
    createdAt: ago(86_400_000),
  });
  const dev = (id: string, role: string, reachable: boolean, overrides: Record<string, unknown> = {}) => ({
    id,
    collector: COLLECTOR,
    name: id.toUpperCase(),
    role,
    source: role === "ap" ? "unifi" : "routeros",
    reachable,
    lastPolledAt: ago(30_000),
    alertsMuted: false,
    ...overrides,
  });
  // router → core → sw → ap
  const tree = [
    { aDeviceId: "router", bDeviceId: "core" },
    { aDeviceId: "core", bDeviceId: "sw" },
    { aDeviceId: "sw", bDeviceId: "ap" },
  ];
  const setup = (options: { devices: any[]; events?: any[]; open?: any[]; received?: Date }) => {
    prismaMock.networkCollector.findMany.mockResolvedValue([collector(options.received ?? ago(30_000))] as any);
    prismaMock.networkLiveAlert.findMany.mockResolvedValue((options.open ?? []) as any);
    prismaMock.networkLiveDevice.findMany.mockResolvedValue(options.devices as any);
    prismaMock.networkLiveLink.findMany.mockResolvedValue(tree as any);
    prismaMock.networkLiveEvent.findMany.mockResolvedValue((options.events ?? []) as any);
  };
  const created = () => prismaMock.networkLiveAlert.create.mock.calls.map((call) => (call[0] as any).data);

  it("un switch caído hace más de 3 min abre un aviso por él, con lo que cuelga, ticket y push a los ADMIN", async () => {
    setup({
      devices: [dev("router", "router", true), dev("core", "core", true), dev("sw", "access", false), dev("ap", "ap", false)],
      events: [
        { deviceId: "sw", kind: "device_down", at: ago(5 * MIN) },
        { deviceId: "ap", kind: "device_down", at: ago(20 * MIN) },
      ],
    });

    const result = await NetworkWatchdog.run(at);

    expect(result.actions).toEqual(["abierto:device_down:sw"]);
    expect(created()).toEqual([
      expect.objectContaining({ kind: "device_down", deviceId: "sw", detail: expect.stringContaining("SW no responde desde hace 5 min; también quedaron sin respuesta 1 equipo que depende de él (AP)") }),
    ]);
    expect(ticketMock).toHaveBeenCalledWith(expect.objectContaining({ category: "RED", priority: "HIGH", title: "Red: SW no responde" }), "admin-1");
    expect(prismaMock.networkLiveAlert.update).toHaveBeenCalledWith({ where: { id: "alert-new" }, data: { ticketId: "ticket-1" } });
    expect(pushMock.mock.calls.map((call) => call[0])).toEqual(["admin-1", "admin-2"]);
    expect(pushMock.mock.calls[0][1]).toMatchObject({ title: "Red: SW no responde", url: "/it/network-live" });
  });

  it("no avisa lo que recién se cayó, lo que ya estaba caído antes del historial ni lo silenciado", async () => {
    setup({
      devices: [
        dev("router", "router", true),
        dev("core", "core", true),
        dev("sw", "access", false),
        dev("ap", "ap", false, { alertsMuted: true }),
        dev("ap2", "ap", false),
      ],
      events: [
        { deviceId: "sw", kind: "device_down", at: ago(2 * MIN) },
        { deviceId: "ap", kind: "device_down", at: ago(60 * MIN) },
      ],
    });

    expect((await NetworkWatchdog.run(at)).actions).toEqual([]);
    expect(prismaMock.networkLiveAlert.create).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("los APs tienen 10 min de margen y su ticket es de prioridad media", async () => {
    setup({
      devices: [dev("router", "router", true), dev("core", "core", true), dev("sw", "access", true), dev("ap", "ap", false)],
      events: [{ deviceId: "ap", kind: "device_down", at: ago(AP_DOWN_ALERT_MS - MIN) }],
    });
    expect((await NetworkWatchdog.run(at)).actions).toEqual([]);

    prismaMock.networkLiveEvent.findMany.mockResolvedValue([{ deviceId: "ap", kind: "device_down", at: ago(AP_DOWN_ALERT_MS + MIN) }] as any);
    expect((await NetworkWatchdog.run(at)).actions).toEqual(["abierto:device_down:ap"]);
    expect(ticketMock).toHaveBeenCalledWith(expect.objectContaining({ priority: "MEDIUM", title: "Red: AP está desconectado del controlador" }), "admin-1");
  });

  it("recuerda cada 6 h mientras siga caído y cierra (con aviso) cuando vuelve", async () => {
    const open = (lastNotifiedAt: Date) => ({
      id: "al-1", collector: COLLECTOR, kind: "device_down", deviceId: "sw", openedAt: ago(7 * 60 * MIN), resolvedAt: null, lastNotifiedAt, ticketId: "t-1", detail: "x",
    });
    const down = [dev("router", "router", true), dev("core", "core", true), dev("sw", "access", false)];
    setup({ devices: down, events: [{ deviceId: "sw", kind: "device_down", at: ago(7 * 60 * MIN) }], open: [open(ago(MIN))] });
    expect((await NetworkWatchdog.run(at)).actions).toEqual([]);

    prismaMock.networkLiveAlert.findMany.mockResolvedValue([open(ago(RE_NOTIFY_MS + MIN))] as any);
    expect((await NetworkWatchdog.run(at)).actions).toEqual(["recordado:device_down:sw"]);
    expect(pushMock.mock.calls[0][1]).toMatchObject({ title: "Red: SW sigue sin responder" });

    vi.clearAllMocks();
    prismaMock.user.findMany.mockResolvedValue([{ id: "admin-1" }] as any);
    setup({ devices: [dev("router", "router", true), dev("core", "core", true), dev("sw", "access", true)], open: [open(ago(MIN))] });
    expect((await NetworkWatchdog.run(at)).actions).toEqual(["cerrado:device_down:sw"]);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: "t-1" }, data: { status: "RESOLVED", closedAt: at } });
    expect(pushMock.mock.calls[0][1]).toMatchObject({ title: "Red: SW volvió" });
  });

  it("con el colector mudo avisa por el colector y no juzga a los equipos; cuando vuelve, cierra", async () => {
    setup({
      devices: [dev("router", "router", true), dev("sw", "access", false)],
      events: [{ deviceId: "sw", kind: "device_down", at: ago(60 * MIN) }],
      received: ago(15 * MIN),
    });

    expect((await NetworkWatchdog.run(at)).actions).toEqual([`abierto:collector_silent:${COLLECTOR}`]);
    expect(prismaMock.networkLiveDevice.findMany).not.toHaveBeenCalled();
    expect(prismaMock.networkLiveEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "collector_silent", collector: COLLECTOR }),
    });
    expect(ticketMock).toHaveBeenCalledWith(expect.objectContaining({ priority: "HIGH" }), "admin-1");

    vi.clearAllMocks();
    prismaMock.user.findMany.mockResolvedValue([{ id: "admin-1" }] as any);
    setup({
      devices: [dev("router", "router", true), dev("sw", "access", true)],
      open: [{ id: "al-c", collector: COLLECTOR, kind: "collector_silent", deviceId: null, openedAt: ago(20 * MIN), resolvedAt: null, lastNotifiedAt: ago(20 * MIN), ticketId: null, detail: "x" }],
    });
    expect((await NetworkWatchdog.run(at)).actions).toEqual([`cerrado:collector_silent:${COLLECTOR}`]);
    expect(prismaMock.networkLiveEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "collector_back", detail: { silentMinutes: 20 } }),
    });
  });

  it("si falla el ticket, el push sale igual", async () => {
    setup({
      devices: [dev("router", "router", true), dev("core", "core", true), dev("sw", "access", false)],
      events: [{ deviceId: "sw", kind: "device_down", at: ago(5 * MIN) }],
    });
    ticketMock.mockRejectedValueOnce(new Error("categoría inválida"));

    expect((await NetworkWatchdog.run(at)).actions).toEqual(["abierto:device_down:sw"]);
    expect(pushMock).toHaveBeenCalledTimes(2);
  });
});
