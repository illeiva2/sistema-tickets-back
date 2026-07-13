import {
  AssetType,
  NetworkDeviceType,
  NetworkDeviceStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import type {
  CreateDeviceRequest,
  CreateLinkRequest,
  CreateSiteRequest,
  CreateTopologyViewRequest,
  DeleteLinkRequest,
  DeviceFilters,
  LinkFilters,
  SiteFilters,
  TopologyLayoutRequest,
  TopologyViewFilters,
  UpdateDeviceRequest,
  UpdateLinkRequest,
  UpdateSiteRequest,
  UpdateTopologyViewRequest,
} from "../validations/network";

const siteListSelect = {
  id: true,
  name: true,
  slug: true,
  address: true,
  description: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { devices: true, topologyViews: true } },
} as const;

const endpointSelect = {
  id: true,
  name: true,
  type: true,
  status: true,
  siteId: true,
  managementIp: true,
  site: { select: { id: true, name: true, slug: true } },
} as const;

const linkSelect = {
  id: true,
  deviceAId: true,
  deviceBId: true,
  portA: true,
  portB: true,
  type: true,
  vlans: true,
  speedMbps: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  deviceA: { select: endpointSelect },
  deviceB: { select: endpointSelect },
} as const;

const deviceListSelect = {
  id: true,
  name: true,
  type: true,
  status: true,
  managementIp: true,
  macAddress: true,
  vlans: true,
  location: true,
  adminUrl: true,
  siteId: true,
  assetId: true,
  isActive: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  site: { select: { id: true, name: true, slug: true, isActive: true } },
  asset: {
    select: { id: true, assetTag: true, type: true, brand: true, model: true },
  },
  _count: { select: { linksA: true, linksB: true } },
} as const;

const deviceDetailSelect = {
  ...deviceListSelect,
  notes: true,
  secretsRef: true,
  linksA: { select: linkSelect, orderBy: { createdAt: "asc" as const } },
  linksB: { select: linkSelect, orderBy: { createdAt: "asc" as const } },
} as const;

const topologyListSelect = {
  id: true,
  name: true,
  description: true,
  siteId: true,
  isDefault: true,
  viewport: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  site: { select: { id: true, name: true, slug: true, isActive: true } },
  createdBy: { select: { id: true, name: true } },
  _count: { select: { nodes: true } },
} as const;

const knownError = (
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;

const targetHas = (error: unknown, field: string) => {
  if (!knownError(error, "P2002")) return false;
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.includes(field)
    : typeof target === "string" && target.includes(field);
};

const translateWriteError = (error: unknown): never => {
  if (targetHas(error, "assetId")) {
    throw new ApiError(
      "NETWORK_ASSET_ALREADY_LINKED",
      "El activo ya está vinculado a otro dispositivo de red",
      409,
    );
  }
  if (
    targetHas(error, "deviceAId") ||
    targetHas(error, "deviceBId") ||
    targetHas(error, "portA") ||
    targetHas(error, "portB")
  ) {
    throw new ApiError(
      "NETWORK_LINK_EXISTS",
      "Ya existe ese enlace entre los dispositivos y puertos indicados",
      409,
    );
  }
  if (targetHas(error, "name")) {
    throw new ApiError("SITE_NAME_EXISTS", "Ya existe un sitio con ese nombre", 409);
  }
  if (targetHas(error, "slug")) {
    throw new ApiError("SITE_SLUG_EXISTS", "Ya existe un sitio con ese slug", 409);
  }
  throw error;
};

const runSerializable = async <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!knownError(error, "P2034")) throw error;
      if (attempt === 2) {
        throw new ApiError(
          "NETWORK_WRITE_CONFLICT",
          "Los datos de red cambiaron durante la operación",
          409,
        );
      }
    }
  }
  throw new ApiError("NETWORK_WRITE_CONFLICT", "Conflicto de escritura", 409);
};

const paginationResult = (page: number, pageSize: number, total: number) => ({
  page,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
});

const serializeSite = (site: Record<string, any>) => {
  const { _count, ...rest } = site;
  return {
    ...rest,
    devicesCount: _count?.devices ?? 0,
    topologyViewsCount: _count?.topologyViews ?? 0,
  };
};

const serializeDevice = (device: Record<string, any>) => {
  const { _count, linksA, linksB, ...rest } = device;
  return {
    ...rest,
    linksCount: (_count?.linksA ?? 0) + (_count?.linksB ?? 0),
    ...(linksA || linksB ? { links: [...(linksA ?? []), ...(linksB ?? [])] } : {}),
  };
};

const serializeTopologyList = (view: Record<string, any>) => {
  const { _count, ...rest } = view;
  return { ...rest, nodesCount: _count?.nodes ?? 0 };
};

const slugify = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "sitio";

const nextAvailableSlug = async (
  tx: Prisma.TransactionClient,
  name: string,
  excludingId?: string,
) => {
  const base = slugify(name);
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    const duplicate = await tx.site.findFirst({
      where: { slug, ...(excludingId ? { id: { not: excludingId } } : {}) },
      select: { id: true },
    });
    if (!duplicate) return slug;
  }
  throw new ApiError("SITE_SLUG_EXISTS", "No se pudo generar un slug único", 409);
};

const ensureSiteName = async (
  tx: Prisma.TransactionClient,
  name: string,
  excludingId?: string,
) => {
  const duplicate = await tx.site.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(excludingId ? { id: { not: excludingId } } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new ApiError("SITE_NAME_EXISTS", "Ya existe un sitio con ese nombre", 409);
  }
};

const ensureSiteSlug = async (
  tx: Prisma.TransactionClient,
  slug: string,
  excludingId?: string,
) => {
  const duplicate = await tx.site.findFirst({
    where: { slug, ...(excludingId ? { id: { not: excludingId } } : {}) },
    select: { id: true },
  });
  if (duplicate) {
    throw new ApiError("SITE_SLUG_EXISTS", "Ya existe un sitio con ese slug", 409);
  }
};

const ensureActiveSite = async (tx: Prisma.TransactionClient, id: string) => {
  const site = await tx.site.findFirst({
    where: { id, isActive: true, deletedAt: null },
    select: { id: true },
  });
  if (!site) throw new ApiError("SITE_NOT_FOUND", "Sitio activo no encontrado", 404);
};

const ensureManagementIpAvailable = async (
  tx: Prisma.TransactionClient,
  siteId: string,
  managementIp: string | null | undefined,
  excludingId?: string,
) => {
  if (!managementIp) return;
  const duplicate = await tx.networkDevice.findFirst({
    where: {
      siteId,
      managementIp,
      isActive: true,
      deletedAt: null,
      status: { not: NetworkDeviceStatus.RETIRED },
      ...(excludingId ? { id: { not: excludingId } } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new ApiError(
      "NETWORK_IP_EXISTS",
      "La IP de gestión ya está asignada a otro dispositivo activo del sitio",
      409,
    );
  }
};

const ensureAssetAvailable = async (
  tx: Prisma.TransactionClient,
  assetId: string | null | undefined,
  deviceType: NetworkDeviceType,
  excludingDeviceId?: string,
) => {
  if (!assetId) return;
  const compatibleTypes: AssetType[] =
    deviceType === NetworkDeviceType.PRINTER
      ? [AssetType.PRINTER, AssetType.NETWORK_DEVICE, AssetType.OTHER]
      : deviceType === NetworkDeviceType.SERVER || deviceType === NetworkDeviceType.NAS
        ? [AssetType.SERVER, AssetType.NETWORK_DEVICE, AssetType.OTHER]
        : [AssetType.NETWORK_DEVICE, AssetType.OTHER];
  const asset = await tx.asset.findFirst({
    where: {
      id: assetId,
      isActive: true,
      deletedAt: null,
      status: { not: "RETIRED" },
      type: { in: compatibleTypes },
    },
    select: { id: true },
  });
  if (!asset) throw new ApiError("ASSET_NOT_FOUND", "Activo vigente no encontrado", 404);
  const linked = await tx.networkDevice.findFirst({
    where: {
      assetId,
      deletedAt: null,
      ...(excludingDeviceId ? { id: { not: excludingDeviceId } } : {}),
    },
    select: { id: true },
  });
  if (linked) {
    throw new ApiError(
      "NETWORK_ASSET_ALREADY_LINKED",
      "El activo ya está vinculado a otro dispositivo de red",
      409,
    );
  }
};

const auditMeta = (fields: string[], redactedFields: string[] = []) => ({
  fields,
  redactedFields: fields.filter((field) => redactedFields.includes(field)),
});

const jsonInput = (value: unknown) =>
  value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

type LinkCandidate = {
  deviceAId: string;
  deviceBId: string;
  portA?: string | null;
  portB?: string | null;
};

const normalizeLinkPair = <T extends LinkCandidate>(candidate: T): T => {
  if (candidate.deviceAId === candidate.deviceBId) {
    throw new ApiError(
      "NETWORK_LINK_SELF",
      "Un dispositivo no puede enlazarse consigo mismo",
      400,
    );
  }
  if (candidate.deviceAId < candidate.deviceBId) return candidate;
  return {
    ...candidate,
    deviceAId: candidate.deviceBId,
    deviceBId: candidate.deviceAId,
    portA: candidate.portB ?? null,
    portB: candidate.portA ?? null,
  };
};

const ensureLinkEndpoints = async (
  tx: Prisma.TransactionClient,
  deviceAId: string,
  deviceBId: string,
) => {
  const devices = await tx.networkDevice.findMany({
    where: {
      id: { in: [deviceAId, deviceBId] },
      isActive: true,
      deletedAt: null,
      status: { not: NetworkDeviceStatus.RETIRED },
    },
    select: { id: true },
  });
  if (devices.length !== 2) {
    throw new ApiError(
      "NETWORK_LINK_DEVICE_INVALID",
      "Ambos extremos deben ser dispositivos vigentes",
      409,
    );
  }
};

const ensureLinkUnique = async (
  tx: Prisma.TransactionClient,
  link: LinkCandidate,
  excludingId?: string,
) => {
  const duplicate = await tx.networkLink.findFirst({
    where: {
      deviceAId: link.deviceAId,
      deviceBId: link.deviceBId,
      portA: link.portA
        ? { equals: link.portA, mode: "insensitive" }
        : null,
      portB: link.portB
        ? { equals: link.portB, mode: "insensitive" }
        : null,
      ...(excludingId ? { id: { not: excludingId } } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new ApiError(
      "NETWORK_LINK_EXISTS",
      "Ya existe ese enlace entre los dispositivos y puertos indicados",
      409,
    );
  }
};

const findTopologyDetail = async (
  db: Prisma.TransactionClient | typeof prisma,
  id: string,
) => {
  const view = await db.networkTopologyView.findUnique({
    where: { id },
    select: {
      ...topologyListSelect,
      nodes: {
        where: {
          device: {
            isActive: true,
            deletedAt: null,
            status: { not: NetworkDeviceStatus.RETIRED },
          },
        },
        select: {
          id: true,
          deviceId: true,
          x: true,
          y: true,
          device: { select: endpointSelect },
        },
        orderBy: { deviceId: "asc" },
      },
    },
  });
  if (!view) {
    throw new ApiError("TOPOLOGY_VIEW_NOT_FOUND", "Vista de topología no encontrada", 404);
  }
  const deviceWhere: Prisma.NetworkDeviceWhereInput = {
    isActive: true,
    deletedAt: null,
    status: { not: NetworkDeviceStatus.RETIRED },
    ...(view.siteId ? { siteId: view.siteId } : {}),
  };
  const devices = await db.networkDevice.findMany({
    where: deviceWhere,
    select: endpointSelect,
    orderBy: { name: "asc" },
  });
  const activeIds = devices.map((device) => device.id);
  const links = activeIds.length
    ? await db.networkLink.findMany({
        where: { deviceAId: { in: activeIds }, deviceBId: { in: activeIds } },
        select: linkSelect,
        orderBy: { createdAt: "asc" },
      })
    : [];
  return { ...serializeTopologyList(view), nodes: view.nodes, devices, links };
};

export class NetworkService {
  static async lookups() {
    const [sites, assets, devices] = await Promise.all([
      prisma.site.findMany({
        where: { isActive: true, deletedAt: null },
        select: siteListSelect,
        orderBy: { name: "asc" },
      }),
      prisma.asset.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          status: { not: "RETIRED" },
          type: {
            in: [AssetType.NETWORK_DEVICE, AssetType.SERVER, AssetType.PRINTER, AssetType.OTHER],
          },
          networkDevice: null,
        },
        select: { id: true, assetTag: true, type: true, brand: true, model: true },
        orderBy: { assetTag: "asc" },
        take: 500,
      }),
      prisma.networkDevice.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          status: { not: NetworkDeviceStatus.RETIRED },
        },
        select: endpointSelect,
        orderBy: { name: "asc" },
        take: 500,
      }),
    ]);
    return { sites: sites.map((site) => serializeSite(site)), assets, devices };
  }

  static async listSites(filters: SiteFilters) {
    const { q, isActive, page, pageSize } = filters;
    const where: Prisma.SiteWhereInput = {
      deletedAt: null,
      ...(isActive !== undefined ? { isActive } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { slug: { contains: q, mode: "insensitive" } },
              { address: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.site.findMany({
        where,
        select: siteListSelect,
        orderBy: { name: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.site.count({ where }),
    ]);
    return {
      items: items.map((item) => serializeSite(item)),
      pagination: paginationResult(page, pageSize, total),
    };
  }

  static async getSite(id: string) {
    const site = await prisma.site.findFirst({
      where: { id, deletedAt: null },
      select: siteListSelect,
    });
    if (!site) throw new ApiError("SITE_NOT_FOUND", "Sitio no encontrado", 404);
    return serializeSite(site);
  }

  static async createSite(data: CreateSiteRequest, actorId: string) {
    try {
      const site = await runSerializable(async (tx) => {
        await ensureSiteName(tx, data.name);
        const slug = data.slug ?? (await nextAvailableSlug(tx, data.name));
        if (data.slug) await ensureSiteSlug(tx, data.slug);
        const created = await tx.site.create({
          data: {
            name: data.name,
            slug,
            address: data.address,
            description: data.description,
          },
          select: siteListSelect,
        });
        await tx.auditLog.create({
          data: {
            entity: "site",
            entityId: created.id,
            action: "created",
            actorId,
            meta: auditMeta(
              ["name", "slug", ...(data.address ? ["address"] : []), ...(data.description ? ["description"] : [])],
              ["address", "description"],
            ),
          },
        });
        return created;
      });
      return serializeSite(site);
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async updateSite(id: string, data: UpdateSiteRequest, actorId: string) {
    const { expectedUpdatedAt, ...changes } = data;
    try {
      const site = await runSerializable(async (tx) => {
        const current = await tx.site.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, name: true, slug: true, isActive: true, updatedAt: true },
        });
        if (!current) throw new ApiError("SITE_NOT_FOUND", "Sitio no encontrado", 404);
        const expected = new Date(expectedUpdatedAt);
        if (current.updatedAt.getTime() !== expected.getTime()) {
          throw new ApiError("SITE_VERSION_CONFLICT", "El sitio fue modificado por otro usuario", 409);
        }
        if (changes.name && changes.name.toLowerCase() !== current.name.toLowerCase()) {
          await ensureSiteName(tx, changes.name, id);
        }
        if (changes.slug && changes.slug !== current.slug) {
          await ensureSiteSlug(tx, changes.slug, id);
        }
        if (changes.isActive === false && current.isActive) {
          const blocking = await tx.networkDevice.count({
            where: {
              siteId: id,
              deletedAt: null,
              status: { not: NetworkDeviceStatus.RETIRED },
            },
          });
          if (blocking) {
            throw new ApiError(
              "SITE_HAS_ACTIVE_DEVICES",
              "No se puede desactivar un sitio con dispositivos no retirados",
              409,
              { count: blocking },
            );
          }
        }
        const write = await tx.site.updateMany({
          where: { id, deletedAt: null, updatedAt: expected },
          data: changes,
        });
        if (write.count !== 1) {
          throw new ApiError("SITE_VERSION_CONFLICT", "El sitio fue modificado por otro usuario", 409);
        }
        const updated = await tx.site.findUnique({ where: { id }, select: siteListSelect });
        if (!updated) throw new ApiError("SITE_NOT_FOUND", "Sitio no encontrado", 404);
        await tx.auditLog.create({
          data: {
            entity: "site",
            entityId: id,
            action: "updated",
            actorId,
            meta: auditMeta(Object.keys(changes), ["address", "description"]),
          },
        });
        return updated;
      });
      return serializeSite(site);
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async listDevices(filters: DeviceFilters) {
    const { q, siteId, type, status, isActive, page, pageSize } = filters;
    const where: Prisma.NetworkDeviceWhereInput = {
      deletedAt: null,
      ...(siteId ? { siteId } : {}),
      ...(type ? { type } : {}),
      ...(status ? { status } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { managementIp: { contains: q, mode: "insensitive" } },
              { macAddress: { contains: q, mode: "insensitive" } },
              { location: { contains: q, mode: "insensitive" } },
              { asset: { is: { assetTag: { contains: q, mode: "insensitive" } } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.networkDevice.findMany({
        where,
        select: deviceListSelect,
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.networkDevice.count({ where }),
    ]);
    return {
      items: items.map((item) => serializeDevice(item)),
      pagination: paginationResult(page, pageSize, total),
    };
  }

  static async getDevice(id: string) {
    const device = await prisma.networkDevice.findFirst({
      where: { id, deletedAt: null },
      select: deviceDetailSelect,
    });
    if (!device) {
      throw new ApiError("NETWORK_DEVICE_NOT_FOUND", "Dispositivo de red no encontrado", 404);
    }
    return serializeDevice(device);
  }

  static async createDevice(data: CreateDeviceRequest, actorId: string) {
    try {
      const device = await runSerializable(async (tx) => {
        await ensureActiveSite(tx, data.siteId);
        const retired = data.status === NetworkDeviceStatus.RETIRED;
        if (!retired) {
          await ensureManagementIpAvailable(tx, data.siteId, data.managementIp);
        }
        await ensureAssetAvailable(tx, data.assetId, data.type as NetworkDeviceType);
        const created = await tx.networkDevice.create({
          data: {
            name: data.name!,
            type: data.type!,
            status: data.status ?? NetworkDeviceStatus.ACTIVE,
            siteId: data.siteId!,
            managementIp: data.managementIp,
            macAddress: data.macAddress,
            vlans: data.vlans ?? [],
            location: data.location,
            adminUrl: data.adminUrl,
            notes: data.notes,
            secretsRef: data.secretsRef,
            assetId: data.assetId,
            isActive: !retired,
          },
          select: deviceDetailSelect,
        });
        await tx.auditLog.create({
          data: {
            entity: "network_device",
            entityId: created.id,
            action: "created",
            actorId,
            meta: auditMeta(
              Object.keys(data),
              ["managementIp", "macAddress", "adminUrl", "notes", "secretsRef"],
            ),
          },
        });
        return created;
      });
      if (!data.assetId) {
        logger.warn({ deviceId: device.id }, "Network device created without asset link");
      }
      return serializeDevice(device);
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async updateDevice(
    id: string,
    data: UpdateDeviceRequest,
    actorId: string,
  ) {
    const { expectedUpdatedAt, ...changes } = data;
    try {
      const device = await runSerializable(async (tx) => {
        const current = await tx.networkDevice.findFirst({
          where: { id, deletedAt: null },
        });
        if (!current) {
          throw new ApiError("NETWORK_DEVICE_NOT_FOUND", "Dispositivo de red no encontrado", 404);
        }
        const expected = new Date(expectedUpdatedAt);
        if (current.updatedAt.getTime() !== expected.getTime()) {
          throw new ApiError(
            "NETWORK_DEVICE_VERSION_CONFLICT",
            "El dispositivo fue modificado por otro usuario",
            409,
          );
        }
        const siteId = changes.siteId ?? current.siteId;
        if (changes.siteId && changes.siteId !== current.siteId) {
          await ensureActiveSite(tx, changes.siteId);
        }
        let status = changes.status ?? current.status;
        let isActive = current.isActive;
        if (changes.status === NetworkDeviceStatus.RETIRED || changes.isActive === false) {
          status = NetworkDeviceStatus.RETIRED;
          isActive = false;
        } else if (changes.status) {
          isActive = true;
        } else if (changes.isActive === true) {
          isActive = true;
          if (status === NetworkDeviceStatus.RETIRED) status = NetworkDeviceStatus.ACTIVE;
        }
        const managementIp =
          changes.managementIp === undefined ? current.managementIp : changes.managementIp;
        if (isActive && status !== NetworkDeviceStatus.RETIRED) {
          await ensureActiveSite(tx, siteId);
          await ensureManagementIpAvailable(tx, siteId, managementIp, id);
        }
        const deviceType = (changes.type ?? current.type) as NetworkDeviceType;
        const assetId = changes.assetId === undefined ? current.assetId : changes.assetId;
        if (
          (changes.assetId !== undefined && changes.assetId !== current.assetId) ||
          (changes.type !== undefined && changes.type !== current.type)
        ) {
          await ensureAssetAvailable(tx, assetId, deviceType, id);
        }
        const writeData: Prisma.NetworkDeviceUncheckedUpdateInput = {
          ...changes,
          status,
          isActive,
          deletedAt: current.deletedAt,
        };
        const write = await tx.networkDevice.updateMany({
          where: { id, deletedAt: null, updatedAt: expected },
          data: writeData,
        });
        if (write.count !== 1) {
          throw new ApiError(
            "NETWORK_DEVICE_VERSION_CONFLICT",
            "El dispositivo fue modificado por otro usuario",
            409,
          );
        }
        const updated = await tx.networkDevice.findFirst({
          where: { id, deletedAt: null },
          select: deviceDetailSelect,
        });
        if (!updated) {
          throw new ApiError("NETWORK_DEVICE_NOT_FOUND", "Dispositivo de red no encontrado", 404);
        }
        await tx.auditLog.create({
          data: {
            entity: "network_device",
            entityId: id,
            action: status === NetworkDeviceStatus.RETIRED ? "retired" : "updated",
            actorId,
            meta: auditMeta(
              [...new Set([...Object.keys(changes), "status", "isActive"])],
              ["managementIp", "macAddress", "adminUrl", "notes", "secretsRef"],
            ),
          },
        });
        return updated;
      });
      return serializeDevice(device);
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async listLinks(filters: LinkFilters) {
    const { q, deviceId, siteId, type, page, pageSize } = filters;
    const clauses: Prisma.NetworkLinkWhereInput[] = [];
    if (deviceId) clauses.push({ OR: [{ deviceAId: deviceId }, { deviceBId: deviceId }] });
    if (siteId) clauses.push({ OR: [{ deviceA: { siteId } }, { deviceB: { siteId } }] });
    if (q) {
      clauses.push({
        OR: [
          { deviceA: { name: { contains: q, mode: "insensitive" } } },
          { deviceB: { name: { contains: q, mode: "insensitive" } } },
          { portA: { contains: q, mode: "insensitive" } },
          { portB: { contains: q, mode: "insensitive" } },
          { vlans: { has: q } },
        ],
      });
    }
    const where: Prisma.NetworkLinkWhereInput = {
      ...(type ? { type } : {}),
      ...(clauses.length ? { AND: clauses } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.networkLink.findMany({
        where,
        select: linkSelect,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.networkLink.count({ where }),
    ]);
    return { items, pagination: paginationResult(page, pageSize, total) };
  }

  static async getLink(id: string) {
    const link = await prisma.networkLink.findUnique({
      where: { id },
      select: linkSelect,
    });
    if (!link) throw new ApiError("NETWORK_LINK_NOT_FOUND", "Enlace no encontrado", 404);
    return link;
  }

  static async createLink(data: CreateLinkRequest, actorId: string) {
    try {
      return await runSerializable(async (tx) => {
        const candidate = normalizeLinkPair({
          ...data,
          deviceAId: data.deviceAId!,
          deviceBId: data.deviceBId!,
        });
        await ensureLinkEndpoints(tx, candidate.deviceAId, candidate.deviceBId);
        await ensureLinkUnique(tx, candidate);
        const link = await tx.networkLink.create({
          data: candidate,
          select: linkSelect,
        });
        await tx.auditLog.create({
          data: {
            entity: "network_link",
            entityId: link.id,
            action: "created",
            actorId,
            meta: auditMeta(Object.keys(data), ["notes"]),
          },
        });
        return link;
      });
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async updateLink(id: string, data: UpdateLinkRequest, actorId: string) {
    const { expectedUpdatedAt, ...changes } = data;
    try {
      return await runSerializable(async (tx) => {
        const current = await tx.networkLink.findUnique({ where: { id } });
        if (!current) throw new ApiError("NETWORK_LINK_NOT_FOUND", "Enlace no encontrado", 404);
        const expected = new Date(expectedUpdatedAt);
        if (current.updatedAt.getTime() !== expected.getTime()) {
          throw new ApiError(
            "NETWORK_LINK_VERSION_CONFLICT",
            "El enlace fue modificado por otro usuario",
            409,
          );
        }
        const candidate = normalizeLinkPair({
          ...current,
          ...changes,
          portA: changes.portA === undefined ? current.portA : changes.portA,
          portB: changes.portB === undefined ? current.portB : changes.portB,
        });
        await ensureLinkEndpoints(tx, candidate.deviceAId, candidate.deviceBId);
        await ensureLinkUnique(tx, candidate, id);
        const write = await tx.networkLink.updateMany({
          where: { id, updatedAt: expected },
          data: {
            deviceAId: candidate.deviceAId,
            deviceBId: candidate.deviceBId,
            portA: candidate.portA,
            portB: candidate.portB,
            type: candidate.type,
            vlans: candidate.vlans,
            speedMbps: candidate.speedMbps,
            notes: candidate.notes,
          },
        });
        if (write.count !== 1) {
          throw new ApiError(
            "NETWORK_LINK_VERSION_CONFLICT",
            "El enlace fue modificado por otro usuario",
            409,
          );
        }
        const updated = await tx.networkLink.findUnique({ where: { id }, select: linkSelect });
        if (!updated) throw new ApiError("NETWORK_LINK_NOT_FOUND", "Enlace no encontrado", 404);
        await tx.auditLog.create({
          data: {
            entity: "network_link",
            entityId: id,
            action: "updated",
            actorId,
            meta: auditMeta(Object.keys(changes), ["notes"]),
          },
        });
        return updated;
      });
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async deleteLink(id: string, data: DeleteLinkRequest, actorId: string) {
    return runSerializable(async (tx) => {
      const current = await tx.networkLink.findUnique({ where: { id } });
      if (!current) throw new ApiError("NETWORK_LINK_NOT_FOUND", "Enlace no encontrado", 404);
      const expected = new Date(data.expectedUpdatedAt);
      if (current.updatedAt.getTime() !== expected.getTime()) {
        throw new ApiError(
          "NETWORK_LINK_VERSION_CONFLICT",
          "El enlace fue modificado por otro usuario",
          409,
        );
      }
      const deleted = await tx.networkLink.deleteMany({ where: { id, updatedAt: expected } });
      if (deleted.count !== 1) {
        throw new ApiError(
          "NETWORK_LINK_VERSION_CONFLICT",
          "El enlace fue modificado por otro usuario",
          409,
        );
      }
      await tx.auditLog.create({
        data: {
          entity: "network_link",
          entityId: id,
          action: "deleted",
          actorId,
          meta: {
            snapshot: {
              deviceAId: current.deviceAId,
              deviceBId: current.deviceBId,
              portA: current.portA,
              portB: current.portB,
              type: current.type,
              vlans: current.vlans,
              speedMbps: current.speedMbps,
            },
            notesRedacted: Boolean(current.notes),
          },
        },
      });
      return { deleted: true as const, id };
    });
  }

  static async listTopologyViews(filters: TopologyViewFilters) {
    const { q, siteId, page, pageSize } = filters;
    const where: Prisma.NetworkTopologyViewWhereInput = {
      ...(siteId ? { siteId } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.networkTopologyView.findMany({
        where,
        select: topologyListSelect,
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.networkTopologyView.count({ where }),
    ]);
    return {
      items: items.map((item) => serializeTopologyList(item)),
      pagination: paginationResult(page, pageSize, total),
    };
  }

  static getTopologyView(id: string) {
    return findTopologyDetail(prisma, id);
  }

  static async createTopologyView(
    data: CreateTopologyViewRequest,
    actorId: string,
  ) {
    return runSerializable(async (tx) => {
      if (data.siteId) await ensureActiveSite(tx, data.siteId);
      if (data.isDefault) {
        await tx.networkTopologyView.updateMany({
          where: { siteId: data.siteId ?? null, isDefault: true },
          data: { isDefault: false },
        });
      }
      const view = await tx.networkTopologyView.create({
        data: {
          name: data.name,
          description: data.description,
          siteId: data.siteId,
          isDefault: data.isDefault,
          ...(data.viewport !== undefined ? { viewport: jsonInput(data.viewport) } : {}),
          createdById: actorId,
        },
        select: topologyListSelect,
      });
      await tx.auditLog.create({
        data: {
          entity: "network_topology_view",
          entityId: view.id,
          action: "created",
          actorId,
          meta: auditMeta(Object.keys(data), ["description"]),
        },
      });
      return findTopologyDetail(tx, view.id);
    });
  }

  static async updateTopologyView(
    id: string,
    data: UpdateTopologyViewRequest,
    actorId: string,
  ) {
    const { expectedUpdatedAt, ...changes } = data;
    return runSerializable(async (tx) => {
      const current = await tx.networkTopologyView.findUnique({ where: { id } });
      if (!current) {
        throw new ApiError("TOPOLOGY_VIEW_NOT_FOUND", "Vista de topología no encontrada", 404);
      }
      const expected = new Date(expectedUpdatedAt);
      if (current.updatedAt.getTime() !== expected.getTime()) {
        throw new ApiError(
          "TOPOLOGY_VIEW_VERSION_CONFLICT",
          "La vista fue modificada por otro usuario",
          409,
        );
      }
      const nextSiteId = changes.siteId === undefined ? current.siteId : changes.siteId;
      if (nextSiteId && nextSiteId !== current.siteId) await ensureActiveSite(tx, nextSiteId);
      if (changes.siteId !== undefined && changes.siteId !== current.siteId) {
        const nodes = await tx.networkTopologyNodePosition.count({ where: { viewId: id } });
        if (nodes > 0) {
          throw new ApiError(
            "VIEW_SITE_CHANGE_REQUIRES_EMPTY",
            "Quite los nodos del layout antes de cambiar el sitio de la vista",
            409,
            { nodesCount: nodes },
          );
        }
      }
      const nextDefault = changes.isDefault ?? current.isDefault;
      if (nextDefault && (changes.isDefault === true || nextSiteId !== current.siteId)) {
        await tx.networkTopologyView.updateMany({
          where: { id: { not: id }, siteId: nextSiteId ?? null, isDefault: true },
          data: { isDefault: false },
        });
      }
      const updateData: Prisma.NetworkTopologyViewUncheckedUpdateInput = {
        ...changes,
        ...(changes.viewport !== undefined ? { viewport: jsonInput(changes.viewport) } : {}),
      };
      const write = await tx.networkTopologyView.updateMany({
        where: { id, updatedAt: expected },
        data: updateData,
      });
      if (write.count !== 1) {
        throw new ApiError(
          "TOPOLOGY_VIEW_VERSION_CONFLICT",
          "La vista fue modificada por otro usuario",
          409,
        );
      }
      await tx.auditLog.create({
        data: {
          entity: "network_topology_view",
          entityId: id,
          action: "updated",
          actorId,
          meta: auditMeta(Object.keys(changes), ["description"]),
        },
      });
      return findTopologyDetail(tx, id);
    });
  }

  static async updateTopologyLayout(
    id: string,
    data: TopologyLayoutRequest,
    actorId: string,
  ) {
    return runSerializable(async (tx) => {
      const view = await tx.networkTopologyView.findUnique({
        where: { id },
        select: { id: true, siteId: true, updatedAt: true },
      });
      if (!view) {
        throw new ApiError("TOPOLOGY_VIEW_NOT_FOUND", "Vista de topología no encontrada", 404);
      }
      const expected = new Date(data.expectedUpdatedAt);
      if (view.updatedAt.getTime() !== expected.getTime()) {
        throw new ApiError(
          "TOPOLOGY_VIEW_VERSION_CONFLICT",
          "La vista fue modificada por otro usuario",
          409,
        );
      }
      const deviceIds = data.nodes.map((node) => node.deviceId);
      const devices = deviceIds.length
        ? await tx.networkDevice.findMany({
            where: {
              id: { in: deviceIds },
              isActive: true,
              deletedAt: null,
              status: { not: NetworkDeviceStatus.RETIRED },
              ...(view.siteId ? { siteId: view.siteId } : {}),
            },
            select: { id: true },
          })
        : [];
      if (devices.length !== deviceIds.length) {
        throw new ApiError(
          "TOPOLOGY_LAYOUT_DEVICE_INVALID",
          "El layout contiene dispositivos retirados, inexistentes o de otro sitio",
          409,
        );
      }
      const now = new Date();
      const write = await tx.networkTopologyView.updateMany({
        where: { id, updatedAt: expected },
        data: {
          updatedAt: now,
          ...(data.viewport !== undefined ? { viewport: jsonInput(data.viewport) } : {}),
        },
      });
      if (write.count !== 1) {
        throw new ApiError(
          "TOPOLOGY_VIEW_VERSION_CONFLICT",
          "La vista fue modificada por otro usuario",
          409,
        );
      }
      await tx.networkTopologyNodePosition.deleteMany({
        where: {
          viewId: id,
          ...(deviceIds.length ? { deviceId: { notIn: deviceIds } } : {}),
        },
      });
      for (const node of data.nodes) {
        await tx.networkTopologyNodePosition.upsert({
          where: { viewId_deviceId: { viewId: id, deviceId: node.deviceId } },
          create: { viewId: id, deviceId: node.deviceId, x: node.x, y: node.y },
          update: { x: node.x, y: node.y },
        });
      }
      await tx.auditLog.create({
        data: {
          entity: "network_topology_view",
          entityId: id,
          action: "layout_updated",
          actorId,
          meta: {
            nodeCount: data.nodes.length,
            viewportChanged: data.viewport !== undefined,
          },
        },
      });
      return findTopologyDetail(tx, id);
    });
  }
}

export default NetworkService;
