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

import type { PrismaClient } from "@prisma/client";
import type { DeepMockProxy } from "vitest-mock-extended";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const siteId = "cmh111aaaaaaaaaaaaaaaaaaa";
const siteBId = "cmh222aaaaaaaaaaaaaaaaaaa";
const deviceAId = "cmhaaaaaaaaaaaaaaaaaaaaaaa";
const deviceBId = "cmhbbbbbbbbbbbbbbbbbbbbbbb";
const linkId = "cmh333aaaaaaaaaaaaaaaaaaa";
const viewId = "cmh444aaaaaaaaaaaaaaaaaaa";
const assetId = "cmh555aaaaaaaaaaaaaaaaaaa";
const version = new Date("2026-07-12T15:00:00.000Z");
const nextVersion = new Date("2026-07-12T15:01:00.000Z");

const auth = (role: "USER" | "AGENT" | "ADMIN", id = "agent-1") => ({
  Authorization: `Bearer ${signAccessToken({ role, id })}`,
});

const makeSite = (overrides: Record<string, any> = {}) => ({
  id: siteId,
  name: "Casa central",
  slug: "casa-central",
  address: null,
  description: null,
  isActive: true,
  deletedAt: null,
  createdAt: new Date("2026-07-01T10:00:00.000Z"),
  updatedAt: version,
  _count: { devices: 0, topologyViews: 0 },
  ...overrides,
});

const endpoint = (id: string, name: string, overrides: Record<string, any> = {}) => ({
  id,
  name,
  type: "SWITCH",
  status: "ACTIVE",
  siteId,
  managementIp: null,
  site: { id: siteId, name: "Casa central", slug: "casa-central" },
  ...overrides,
});

const makeDevice = (overrides: Record<string, any> = {}) => ({
  id: deviceAId,
  name: "Core SW 01",
  type: "SWITCH",
  status: "ACTIVE",
  managementIp: "10.0.0.2",
  macAddress: "AA:BB:CC:DD:EE:FF",
  vlans: ["10", "20-VoIP"],
  location: "Rack principal",
  adminUrl: "https://10.0.0.2",
  notes: null,
  secretsRef: null,
  siteId,
  assetId: null,
  isActive: true,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: version,
  site: { id: siteId, name: "Casa central", slug: "casa-central", isActive: true },
  asset: null,
  linksA: [],
  linksB: [],
  _count: { linksA: 0, linksB: 0 },
  ...overrides,
});

const makeLink = (overrides: Record<string, any> = {}) => ({
  id: linkId,
  deviceAId,
  deviceBId,
  portA: null,
  portB: null,
  type: "ETHERNET",
  vlans: ["10"],
  speedMbps: 1000,
  notes: "Dato operativo reservado",
  createdAt: new Date(),
  updatedAt: version,
  deviceA: endpoint(deviceAId, "Core SW 01"),
  deviceB: endpoint(deviceBId, "Acceso SW 02"),
  ...overrides,
});

const makeView = (overrides: Record<string, any> = {}) => ({
  id: viewId,
  name: "Topología principal",
  description: null,
  siteId,
  isDefault: true,
  viewport: { x: 0, y: 0, zoom: 1 },
  createdById: "agent-1",
  createdAt: new Date(),
  updatedAt: nextVersion,
  site: { id: siteId, name: "Casa central", slug: "casa-central", isActive: true },
  createdBy: { id: "agent-1", name: "Agente" },
  nodes: [],
  _count: { nodes: 0 },
  ...overrides,
});

describe("API IT de red y topología", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) =>
      typeof work === "function" ? work(prismaMock) : Promise.all(work),
    );
  });

  it("protege todo el módulo para AGENT/ADMIN y valida query strict", async () => {
    expect((await request(app).get("/api/it/network/lookups")).status).toBe(401);
    expect(
      (await request(app).get("/api/it/network/lookups").set(auth("USER"))).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/it/network/devices?unknown=true")
          .set(auth("AGENT"))
      ).status,
    ).toBe(400);
  });

  it("devuelve sitios completos en lookups para el fallback de edición", async () => {
    prismaMock.site.findMany.mockResolvedValueOnce([makeSite()] as any);
    prismaMock.asset.findMany.mockResolvedValueOnce([]);
    prismaMock.networkDevice.findMany.mockResolvedValueOnce([]);

    const response = await request(app)
      .get("/api/it/network/lookups")
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    expect(response.body.data.sites[0]).toEqual(
      expect.objectContaining({
        id: siteId,
        name: "Casa central",
        slug: "casa-central",
        address: null,
        description: null,
        isActive: true,
        updatedAt: version.toISOString(),
        devicesCount: 0,
        topologyViewsCount: 0,
      }),
    );
    expect(response.body.data.sites[0]._count).toBeUndefined();
  });

  it("lista dispositivos incluyendo históricos y expone linksCount plural", async () => {
    prismaMock.networkDevice.findMany.mockResolvedValueOnce([
      makeDevice({ status: "RETIRED", isActive: false, _count: { linksA: 1, linksB: 2 } }),
    ] as any);
    prismaMock.networkDevice.count.mockResolvedValueOnce(1);

    const response = await request(app)
      .get("/api/it/network/devices?pageSize=10")
      .set(auth("AGENT"));

    expect(response.status).toBe(200);
    expect(response.body.data.items[0].linksCount).toBe(3);
    expect(response.body.data.items[0].status).toBe("RETIRED");
    expect(response.body.data.pagination.total).toBe(1);
  });

  it("genera slug de sitio y bloquea su desactivación con equipos no retirados", async () => {
    prismaMock.site.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prismaMock.site.create.mockResolvedValueOnce(makeSite() as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const created = await request(app)
      .post("/api/it/network/sites")
      .set(auth("ADMIN"))
      .send({ name: "Casa Central" });
    expect(created.status).toBe(201);
    expect(prismaMock.site.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ slug: "casa-central" }) }),
    );

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => work(prismaMock));
    prismaMock.site.findFirst.mockResolvedValueOnce(makeSite() as any);
    prismaMock.networkDevice.count.mockResolvedValueOnce(2);
    const blocked = await request(app)
      .patch(`/api/it/network/sites/${siteId}`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString(), isActive: false });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("SITE_HAS_ACTIVE_DEVICES");
  });

  it("normaliza MAC/VLAN al crear y nunca guarda credenciales en adminUrl", async () => {
    prismaMock.site.findFirst.mockResolvedValueOnce({ id: siteId } as any);
    prismaMock.networkDevice.findFirst.mockResolvedValueOnce(null);
    prismaMock.networkDevice.create.mockResolvedValueOnce(makeDevice() as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/it/network/devices")
      .set(auth("AGENT"))
      .send({
        name: "Core SW 01",
        type: "SWITCH",
        siteId,
        managementIp: "10.0.0.2",
        macAddress: "aa-bb-cc-dd-ee-ff",
        vlans: ["10", "20-VoIP", "10"],
        adminUrl: "https://10.0.0.2",
      });

    expect(response.status).toBe(201);
    expect(prismaMock.networkDevice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          macAddress: "AA:BB:CC:DD:EE:FF",
          vlans: ["10", "20-VoIP"],
        }),
      }),
    );
    const audit = (prismaMock.auditLog.create.mock.calls[0][0] as any).data.meta;
    expect(JSON.stringify(audit)).not.toContain("10.0.0.2");

    const invalid = await request(app)
      .post("/api/it/network/devices")
      .set(auth("AGENT"))
      .send({
        name: "Switch inseguro",
        type: "SWITCH",
        siteId,
        adminUrl: "https://admin:clave@10.0.0.3",
      });
    expect(invalid.status).toBe(400);
  });

  it("impide repetir IP por sitio entre equipos activos", async () => {
    prismaMock.site.findFirst.mockResolvedValueOnce({ id: siteId } as any);
    prismaMock.networkDevice.findFirst.mockResolvedValueOnce({ id: deviceBId } as any);
    const response = await request(app)
      .post("/api/it/network/devices")
      .set(auth("AGENT"))
      .send({
        name: "Acceso SW 02",
        type: "SWITCH",
        siteId,
        managementIp: "10.0.0.2",
      });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("NETWORK_IP_EXISTS");
  });

  it("retira sin borrado lógico y protege CAS de dispositivo", async () => {
    prismaMock.networkDevice.findFirst
      .mockResolvedValueOnce(makeDevice() as any)
      .mockResolvedValueOnce(makeDevice({ status: "RETIRED", isActive: false }) as any);
    prismaMock.networkDevice.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .patch(`/api/it/network/devices/${deviceAId}`)
      .set(auth("ADMIN"))
      .send({ expectedUpdatedAt: version.toISOString(), status: "RETIRED" });
    expect(response.status).toBe(200);
    expect(prismaMock.networkDevice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RETIRED", isActive: false, deletedAt: null }),
      }),
    );

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => work(prismaMock));
    prismaMock.networkDevice.findFirst.mockResolvedValueOnce(
      makeDevice({ updatedAt: nextVersion }) as any,
    );
    const conflict = await request(app)
      .patch(`/api/it/network/devices/${deviceAId}`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString(), name: "Otro nombre" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("NETWORK_DEVICE_VERSION_CONFLICT");
  });

  it("limita asset 1:1 a tipos patrimoniales compatibles", async () => {
    prismaMock.site.findFirst.mockResolvedValueOnce({ id: siteId } as any);
    prismaMock.asset.findFirst.mockResolvedValueOnce(null);
    const response = await request(app)
      .post("/api/it/network/devices")
      .set(auth("AGENT"))
      .send({ name: "Switch con activo", type: "SWITCH", siteId, assetId });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ASSET_NOT_FOUND");
    expect(prismaMock.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: { in: ["NETWORK_DEVICE", "OTHER"] } }),
      }),
    );
  });

  it("normaliza extremos/puertos del enlace y detecta duplicados incluso con null", async () => {
    prismaMock.networkDevice.findMany.mockResolvedValueOnce([
      { id: deviceAId },
      { id: deviceBId },
    ] as any);
    prismaMock.networkLink.findFirst.mockResolvedValueOnce(null);
    prismaMock.networkLink.create.mockResolvedValueOnce(makeLink() as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .post("/api/it/network/links")
      .set(auth("AGENT"))
      .send({
        deviceAId: deviceBId,
        deviceBId: deviceAId,
        portA: "  Gi0/2  ",
        portB: " Gi0/1 ",
        vlans: ["10"],
      });
    expect(response.status).toBe(201);
    expect(prismaMock.networkLink.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deviceAId,
          deviceBId,
          portA: "Gi0/1",
          portB: "Gi0/2",
        }),
      }),
    );

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (work: any) => work(prismaMock));
    prismaMock.networkDevice.findMany.mockResolvedValueOnce([
      { id: deviceAId },
      { id: deviceBId },
    ] as any);
    prismaMock.networkLink.findFirst.mockResolvedValueOnce({ id: linkId } as any);
    const duplicate = await request(app)
      .post("/api/it/network/links")
      .set(auth("AGENT"))
      .send({ deviceAId, deviceBId });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("NETWORK_LINK_EXISTS");
  });

  it("rechaza self-link y filtra enlaces que tocan un sitio", async () => {
    const invalid = await request(app)
      .post("/api/it/network/links")
      .set(auth("AGENT"))
      .send({ deviceAId, deviceBId: deviceAId });
    expect(invalid.status).toBe(400);

    prismaMock.networkLink.findMany.mockResolvedValueOnce([]);
    prismaMock.networkLink.count.mockResolvedValueOnce(0);
    const response = await request(app)
      .get(`/api/it/network/links?siteId=${siteId}`)
      .set(auth("AGENT"));
    expect(response.status).toBe(200);
    expect(prismaMock.networkLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { OR: [{ deviceA: { siteId } }, { deviceB: { siteId } }] },
          ]),
        }),
      }),
    );
  });

  it("hard-deletea enlace con CAS y auditoría sin notes", async () => {
    prismaMock.networkLink.findUnique.mockResolvedValueOnce(makeLink() as any);
    prismaMock.networkLink.deleteMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const response = await request(app)
      .delete(`/api/it/network/links/${linkId}`)
      .set(auth("ADMIN"))
      .send({ expectedUpdatedAt: version.toISOString() });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ deleted: true, id: linkId });
    const meta = (prismaMock.auditLog.create.mock.calls[0][0] as any).data.meta;
    expect(JSON.stringify(meta)).not.toContain("Dato operativo reservado");
    expect(meta.notesRedacted).toBe(true);
  });

  it("mantiene un único default por scope al crear una vista", async () => {
    prismaMock.site.findFirst.mockResolvedValueOnce({ id: siteId } as any);
    prismaMock.networkTopologyView.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.networkTopologyView.create.mockResolvedValueOnce(makeView() as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    prismaMock.networkTopologyView.findUnique.mockResolvedValueOnce(makeView() as any);
    prismaMock.networkDevice.findMany.mockResolvedValueOnce([]);

    const response = await request(app)
      .post("/api/it/network/topology-views")
      .set(auth("AGENT"))
      .send({ name: "Topología principal", siteId, isDefault: true });
    expect(response.status).toBe(201);
    expect(prismaMock.networkTopologyView.updateMany).toHaveBeenCalledWith({
      where: { siteId, isDefault: true },
      data: { isDefault: false },
    });
  });

  it("rechaza IDs duplicados y dispositivos incompatibles en layout", async () => {
    const duplicated = await request(app)
      .put(`/api/it/network/topology-views/${viewId}/layout`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        nodes: [
          { deviceId: deviceAId, x: 0, y: 0 },
          { deviceId: deviceAId, x: 1, y: 1 },
        ],
      });
    expect(duplicated.status).toBe(400);

    prismaMock.networkTopologyView.findUnique.mockResolvedValueOnce({
      id: viewId,
      siteId,
      updatedAt: version,
    } as any);
    prismaMock.networkDevice.findMany.mockResolvedValueOnce([{ id: deviceAId }] as any);
    const incompatible = await request(app)
      .put(`/api/it/network/topology-views/${viewId}/layout`)
      .set(auth("AGENT"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        nodes: [
          { deviceId: deviceAId, x: 0, y: 0 },
          { deviceId: deviceBId, x: 10, y: 10 },
        ],
      });
    expect(incompatible.status).toBe(409);
    expect(incompatible.body.error.code).toBe("TOPOLOGY_LAYOUT_DEVICE_INVALID");
  });

  it("actualiza layout atómicamente con CAS y devuelve devices/nodes/links", async () => {
    prismaMock.networkTopologyView.findUnique
      .mockResolvedValueOnce({ id: viewId, siteId, updatedAt: version } as any)
      .mockResolvedValueOnce(
        makeView({
          nodes: [
            { id: "position-1", deviceId: deviceAId, x: 12, y: 34, device: endpoint(deviceAId, "Core") },
          ],
        }) as any,
      );
    prismaMock.networkDevice.findMany
      .mockResolvedValueOnce([{ id: deviceAId }] as any)
      .mockResolvedValueOnce([endpoint(deviceAId, "Core")] as any);
    prismaMock.networkTopologyView.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.networkTopologyNodePosition.deleteMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.networkTopologyNodePosition.upsert.mockResolvedValueOnce({} as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    prismaMock.networkLink.findMany.mockResolvedValueOnce([]);

    const response = await request(app)
      .put(`/api/it/network/topology-views/${viewId}/layout`)
      .set(auth("ADMIN"))
      .send({
        expectedUpdatedAt: version.toISOString(),
        viewport: { x: 1, y: 2, zoom: 1.2 },
        nodes: [{ deviceId: deviceAId, x: 12, y: 34 }],
      });
    expect(response.status).toBe(200);
    expect(response.body.data.view.devices).toHaveLength(1);
    expect(response.body.data.view.nodes).toHaveLength(1);
    expect(response.body.data.view.links).toEqual([]);
    expect(prismaMock.networkTopologyNodePosition.upsert).toHaveBeenCalledOnce();
  });

  it("no permite cambiar site de una vista con nodos ni omitir CAS", async () => {
    prismaMock.networkTopologyView.findUnique.mockResolvedValueOnce({
      id: viewId,
      name: "Topología principal",
      siteId,
      isDefault: false,
      updatedAt: version,
    } as any);
    prismaMock.site.findFirst.mockResolvedValueOnce({ id: siteBId } as any);
    prismaMock.networkTopologyNodePosition.count.mockResolvedValueOnce(3);
    const blocked = await request(app)
      .patch(`/api/it/network/topology-views/${viewId}`)
      .set(auth("AGENT"))
      .send({ expectedUpdatedAt: version.toISOString(), siteId: siteBId });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("VIEW_SITE_CHANGE_REQUIRES_EMPTY");

    const missingCas = await request(app)
      .patch(`/api/it/network/links/${linkId}`)
      .set(auth("AGENT"))
      .send({ speedMbps: 1000 });
    expect(missingCas.status).toBe(400);
  });
});
