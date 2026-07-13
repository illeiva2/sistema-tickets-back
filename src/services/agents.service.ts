import {
  AgentConnState,
  AssetType,
  Prisma,
  RemoteSessionKind,
  RemoteSessionStatus,
  UserRole,
} from "@prisma/client";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import {
  asAssetWriteError,
  assertAssetCreateAllowed,
  assignAssetInTransaction,
  createAssetInTransaction,
  isGeneratedAssetTagConflict,
} from "./assets.service";
import type {
  AgentDeviceFilters,
  AgentDeviceTransitionRequest,
  CreateEnrollmentTokenRequest,
  EnrollmentTokenFilters,
  LinkAgentAssetRequest,
  MachineEnrollRequest,
  MachineHeartbeatRequest,
  MetricFilters,
  RegisterAgentAssetRequest,
  SnapshotFilters,
  StartRemoteSessionRequest,
} from "../validations/agents";

export const AGENT_ONLINE_THRESHOLD_MS = 120_000;
export const AGENT_STALE_THRESHOLD_MS = 600_000;
export const AGENT_HEARTBEAT_SECONDS = 60;
const METRIC_INTERVAL_MS = 5 * 60_000;
const METRIC_RETENTION_MS = 14 * 24 * 60 * 60_000;
const SNAPSHOT_RETENTION = 30;
const TOKEN_DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
const TOKEN_MIN_TTL_MS = 10 * 60_000;
const TOKEN_MAX_TTL_MS = 7 * 24 * 60 * 60_000;
const DUMMY_HASH = createHash("sha256").update("invalid-agent-secret").digest("hex");

type AgentApiState = "ONLINE" | "STALE" | "OFFLINE";

const assetSelect = {
  id: true,
  assetTag: true,
  type: true,
  status: true,
  brand: true,
  model: true,
} as const;

const deviceListSelect = {
  id: true,
  machineId: true,
  hostname: true,
  agentVersion: true,
  osName: true,
  osVersion: true,
  connState: true,
  lastSeenAt: true,
  lastEnrolledAt: true,
  loggedInUser: true,
  primaryIp: true,
  primaryMac: true,
  uptimeSec: true,
  cpuPct: true,
  ramUsedMb: true,
  ramTotalMb: true,
  batteryPct: true,
  batteryCharging: true,
  vncRunning: true,
  sshRunning: true,
  isActive: true,
  assetId: true,
  asset: { select: assetSelect },
  createdAt: true,
  updatedAt: true,
} as const;

const tokenSelect = {
  id: true,
  label: true,
  expiresAt: true,
  usedAt: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
  usedByDevice: { select: { id: true, hostname: true, isActive: true } },
} as const;

const metricSelect = {
  id: true,
  cpuPct: true,
  ramUsedMb: true,
  diskUsedPct: true,
  batteryPct: true,
  sampledAt: true,
} as const;

const sessionSelect = {
  id: true,
  deviceId: true,
  userId: true,
  kind: true,
  status: true,
  clientIp: true,
  targetHost: true,
  startedAt: true,
  endedAt: true,
  bytesIn: true,
  bytesOut: true,
  errorMsg: true,
  device: { select: { id: true, hostname: true } },
  user: { select: { id: true, name: true } },
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
      "AGENT_ASSET_ALREADY_LINKED",
      "El activo ya está vinculado a otro agente",
      409,
    );
  }
  if (targetHas(error, "machineId")) {
    throw new ApiError(
      "AGENT_MACHINE_CONFLICT",
      "La identidad de máquina ya fue enrolada",
      409,
    );
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
          "AGENT_WRITE_CONFLICT",
          "El dispositivo cambió durante la operación",
          409,
        );
      }
    }
  }
  throw new ApiError("AGENT_WRITE_CONFLICT", "Conflicto de escritura", 409);
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const randomSecret = () => randomBytes(32).toString("base64url");

const safeHashEquals = (suppliedPlain: string, expectedHash: string) => {
  const supplied = Buffer.from(sha256(suppliedPlain), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};

const safeDigestEquals = (leftHash: string, rightHash: string) => {
  const left = Buffer.from(leftHash, "hex");
  const right = Buffer.from(rightHash, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};

const deriveState = (
  device: { isActive: boolean; lastSeenAt: Date | null },
  now = new Date(),
): AgentApiState => {
  if (!device.isActive || !device.lastSeenAt) return "OFFLINE";
  const age = now.getTime() - device.lastSeenAt.getTime();
  if (age <= AGENT_ONLINE_THRESHOLD_MS) return "ONLINE";
  if (age <= AGENT_STALE_THRESHOLD_MS) return "STALE";
  return "OFFLINE";
};

const serializeDevice = (device: Record<string, any>, now = new Date()) => {
  const state = deriveState(
    device as { isActive: boolean; lastSeenAt: Date | null },
    now,
  );
  return {
    ...device,
    state,
    // connState persistido es sólo el último evento conocido. La API evita
    // mostrar ONLINE cuando el heartbeat ya superó el umbral, sin mutar en GET.
    connState: state === "ONLINE" ? AgentConnState.ONLINE : AgentConnState.OFFLINE,
  };
};

const serializeToken = (token: Record<string, any>, now = new Date()) => ({
  ...token,
  status: token.usedAt
    ? ("USED" as const)
    : token.expiresAt <= now
      ? ("EXPIRED" as const)
      : ("AVAILABLE" as const),
});

const serializeSession = (session: Record<string, any>) => ({
  ...session,
  bytesIn: session.bytesIn === null || session.bytesIn === undefined
    ? null
    : String(session.bytesIn),
  bytesOut: session.bytesOut === null || session.bytesOut === undefined
    ? null
    : String(session.bytesOut),
});

const pageResult = (page: number, pageSize: number, total: number) => ({
  page,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
});

const stateWhere = (state: AgentApiState, now: Date): Prisma.AgentDeviceWhereInput => {
  const onlineAfter = new Date(now.getTime() - AGENT_ONLINE_THRESHOLD_MS);
  const staleAfter = new Date(now.getTime() - AGENT_STALE_THRESHOLD_MS);
  if (state === "ONLINE") {
    return { isActive: true, lastSeenAt: { gte: onlineAfter } };
  }
  if (state === "STALE") {
    return { isActive: true, lastSeenAt: { gte: staleAfter, lt: onlineAfter } };
  }
  return {
    OR: [
      { isActive: false },
      { lastSeenAt: null },
      { lastSeenAt: { lt: staleAfter } },
    ],
  };
};

const ensureAssetAvailable = async (
  tx: Prisma.TransactionClient,
  assetId: string | null,
  excludingDeviceId: string,
) => {
  if (!assetId) return;
  const asset = await tx.asset.findFirst({
    where: {
      id: assetId,
      isActive: true,
      deletedAt: null,
      status: { not: "RETIRED" },
      type: { in: [AssetType.DESKTOP, AssetType.NOTEBOOK, AssetType.SERVER, AssetType.OTHER] },
    },
    select: { id: true },
  });
  if (!asset) throw new ApiError("ASSET_NOT_FOUND", "Activo compatible no encontrado", 404);
  const linked = await tx.agentDevice.findFirst({
    where: { assetId, id: { not: excludingDeviceId }, deletedAt: null },
    select: { id: true },
  });
  if (linked) {
    throw new ApiError(
      "AGENT_ASSET_ALREADY_LINKED",
      "El activo ya está vinculado a otro agente",
      409,
    );
  }
};

const mb = (bytes: number) => Math.min(2_147_483_647, Math.round(bytes / 1_048_576));

const diskUsedPct = (disks: MachineHeartbeatRequest["disks"]) => {
  const total = disks.reduce((sum, disk) => sum + disk.totalBytes, 0);
  const used = disks.reduce((sum, disk) => sum + disk.usedBytes, 0);
  if (!total) return null;
  return Math.round((used / total) * 10_000) / 100;
};

const usablePrimaryIp = (addresses: string[]) => {
  const unique = [...new Set(addresses)];
  return unique.find((address) => {
    if (isIP(address) === 4) {
      return !(
        address.startsWith("127.") ||
        address.startsWith("169.254.") ||
        address === "0.0.0.0"
      );
    }
    const lower = address.toLowerCase();
    return isIP(address) === 6 && lower !== "::" && lower !== "::1" && !lower.startsWith("fe80:");
  }) ?? null;
};

const formatUriTarget = (target: string) => (target.includes(":") ? `[${target}]` : target);

export class AgentsService {
  static async lookups() {
    const assets = await prisma.asset.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        status: { not: "RETIRED" },
        type: { in: [AssetType.DESKTOP, AssetType.NOTEBOOK, AssetType.SERVER, AssetType.OTHER] },
        agentDevice: null,
      },
      select: assetSelect,
      orderBy: { assetTag: "asc" },
      take: 500,
    });
    return { assets };
  }

  static async listEnrollmentTokens(filters: EnrollmentTokenFilters) {
    const now = new Date();
    const where: Prisma.AgentEnrollmentTokenWhereInput =
      filters.status === "USED"
        ? { usedAt: { not: null } }
        : filters.status === "EXPIRED"
          ? { usedAt: null, expiresAt: { lte: now } }
          : filters.status === "AVAILABLE"
            ? { usedAt: null, expiresAt: { gt: now } }
            : {};
    const tokens = await prisma.agentEnrollmentToken.findMany({
      where,
      select: tokenSelect,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return { items: tokens.map((token) => serializeToken(token, now)) };
  }

  static async createEnrollmentToken(data: CreateEnrollmentTokenRequest, actorId: string) {
    const now = new Date();
    const expiresAt = data.expiresAt
      ? new Date(data.expiresAt)
      : new Date(now.getTime() + TOKEN_DEFAULT_TTL_MS);
    const ttl = expiresAt.getTime() - now.getTime();
    if (ttl < TOKEN_MIN_TTL_MS || ttl > TOKEN_MAX_TTL_MS) {
      throw new ApiError(
        "ENROLLMENT_TOKEN_EXPIRY_INVALID",
        "El token debe vencer entre 10 minutos y 7 días",
        400,
      );
    }
    const plainToken = randomSecret();
    const token = await prisma.$transaction(async (tx) => {
      const created = await tx.agentEnrollmentToken.create({
        data: {
          tokenHash: sha256(plainToken),
          label: data.label,
          expiresAt,
          createdById: actorId,
        },
        select: tokenSelect,
      });
      await tx.auditLog.create({
        data: {
          entity: "agent_enrollment_token",
          entityId: created.id,
          action: "created",
          actorId,
          meta: { labelProvided: Boolean(data.label), expiresAt: expiresAt.toISOString() },
        },
      });
      return created;
    });
    return { token: serializeToken(token, now), plainToken };
  }

  static async revokeEnrollmentToken(id: string, actorId: string) {
    return runSerializable(async (tx) => {
      const now = new Date();
      const token = await tx.agentEnrollmentToken.findUnique({
        where: { id },
        select: { id: true, usedAt: true, expiresAt: true },
      });
      if (!token) {
        throw new ApiError("ENROLLMENT_TOKEN_NOT_FOUND", "Token no encontrado", 404);
      }
      if (token.usedAt || token.expiresAt <= now) {
        throw new ApiError(
          "ENROLLMENT_TOKEN_NOT_AVAILABLE",
          "Sólo se puede revocar un token vigente y no utilizado",
          409,
        );
      }
      const deleted = await tx.agentEnrollmentToken.deleteMany({
        where: { id, usedAt: null, expiresAt: { gt: now } },
      });
      if (deleted.count !== 1) {
        throw new ApiError(
          "ENROLLMENT_TOKEN_NOT_AVAILABLE",
          "El token ya no está disponible",
          409,
        );
      }
      await tx.auditLog.create({
        data: {
          entity: "agent_enrollment_token",
          entityId: id,
          action: "revoked",
          actorId,
          meta: { tokenRedacted: true },
        },
      });
      return { revoked: true as const, id };
    });
  }

  static async listDevices(filters: AgentDeviceFilters) {
    const now = new Date();
    const { q, state, isActive, assetId, page, pageSize } = filters;
    const clauses: Prisma.AgentDeviceWhereInput[] = [{ deletedAt: null }];
    if (state) clauses.push(stateWhere(state, now));
    if (isActive !== undefined) clauses.push({ isActive });
    if (assetId) clauses.push({ assetId });
    if (q) {
      clauses.push({
        OR: [
          { hostname: { contains: q, mode: "insensitive" } },
          { machineId: { contains: q, mode: "insensitive" } },
          { primaryIp: { contains: q, mode: "insensitive" } },
          { primaryMac: { contains: q, mode: "insensitive" } },
          { loggedInUser: { contains: q, mode: "insensitive" } },
          { asset: { is: { assetTag: { contains: q, mode: "insensitive" } } } },
        ],
      });
    }
    const where: Prisma.AgentDeviceWhereInput = { AND: clauses };
    const [items, total] = await Promise.all([
      prisma.agentDevice.findMany({
        where,
        select: deviceListSelect,
        orderBy: [{ isActive: "desc" }, { lastSeenAt: "desc" }, { hostname: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.agentDevice.count({ where }),
    ]);
    return {
      items: items.map((device) => serializeDevice(device, now)),
      pagination: pageResult(page, pageSize, total),
    };
  }

  static async getDevice(id: string) {
    const now = new Date();
    const device = await prisma.agentDevice.findFirst({
      where: { id, deletedAt: null },
      select: deviceListSelect,
    });
    if (!device) {
      throw new ApiError("AGENT_DEVICE_NOT_FOUND", "Dispositivo agente no encontrado", 404);
    }
    const [recentMetricsDesc, latestSnapshot, activeSessions] = await Promise.all([
      prisma.agentMetricSample.findMany({
        where: { deviceId: id, sampledAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } },
        select: metricSelect,
        orderBy: { sampledAt: "desc" },
        take: 288,
      }),
      prisma.agentInventorySnapshot.findFirst({
        where: { deviceId: id },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.remoteSession.findMany({
        where: { deviceId: id, status: RemoteSessionStatus.ACTIVE, endedAt: null },
        select: sessionSelect,
        orderBy: { startedAt: "desc" },
      }),
    ]);
    return {
      ...serializeDevice(device, now),
      recentMetrics: recentMetricsDesc.reverse(),
      latestSnapshot,
      activeSessions: activeSessions.map(serializeSession),
    };
  }

  static async linkAsset(id: string, data: LinkAgentAssetRequest, actorId: string) {
    try {
      return await runSerializable(async (tx) => {
        const current = await tx.agentDevice.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, assetId: true, updatedAt: true },
        });
        if (!current) {
          throw new ApiError("AGENT_DEVICE_NOT_FOUND", "Dispositivo agente no encontrado", 404);
        }
        const expected = new Date(data.expectedUpdatedAt);
        if (current.updatedAt.getTime() !== expected.getTime()) {
          throw new ApiError(
            "AGENT_DEVICE_VERSION_CONFLICT",
            "El dispositivo fue modificado por otro usuario",
            409,
          );
        }
        await ensureAssetAvailable(tx, data.assetId, id);
        const write = await tx.agentDevice.updateMany({
          where: { id, deletedAt: null, updatedAt: expected },
          data: { assetId: data.assetId },
        });
        if (write.count !== 1) {
          throw new ApiError(
            "AGENT_DEVICE_VERSION_CONFLICT",
            "El dispositivo fue modificado por otro usuario",
            409,
          );
        }
        const updated = await tx.agentDevice.findFirst({
          where: { id, deletedAt: null },
          select: deviceListSelect,
        });
        if (!updated) {
          throw new ApiError("AGENT_DEVICE_NOT_FOUND", "Dispositivo agente no encontrado", 404);
        }
        await tx.auditLog.create({
          data: {
            entity: "agent_device",
            entityId: id,
            action: "asset_link_updated",
            actorId,
            meta: {
              previousAssetLinked: Boolean(current.assetId),
              assetLinked: Boolean(data.assetId),
              assetId: data.assetId,
            },
          },
        });
        return serializeDevice(updated);
      });
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async registerAsset(
    id: string,
    data: RegisterAgentAssetRequest,
    actorId: string,
    actorRole: UserRole,
  ) {
    assertAssetCreateAllowed(data.asset, actorRole);
    if (data.asset.status !== "IN_STOCK") {
      throw new ApiError(
        "AGENT_ASSET_STATUS_INVALID",
        "El alta desde un agente sólo admite activos disponibles en stock",
        400,
      );
    }

    const expected = new Date(data.expectedUpdatedAt);
    const generatedTag = !data.asset.assetTag;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await runSerializable(async (tx) => {
          const current = await tx.agentDevice.findFirst({
            where: { id, deletedAt: null },
            select: {
              id: true,
              assetId: true,
              isActive: true,
              updatedAt: true,
            },
          });
          if (!current) {
            throw new ApiError(
              "AGENT_DEVICE_NOT_FOUND",
              "Dispositivo agente no encontrado",
              404,
            );
          }
          if (!current.isActive) {
            throw new ApiError(
              "AGENT_DEVICE_INACTIVE",
              "El agente debe estar activo para registrar su activo",
              409,
            );
          }
          if (current.assetId) {
            throw new ApiError(
              "AGENT_DEVICE_ALREADY_LINKED",
              "El dispositivo ya está vinculado a un activo",
              409,
            );
          }
          if (current.updatedAt.getTime() !== expected.getTime()) {
            throw new ApiError(
              "AGENT_DEVICE_VERSION_CONFLICT",
              "El dispositivo fue modificado por otro usuario",
              409,
            );
          }

          let asset = await createAssetInTransaction(
            tx,
            data.asset,
            actorId,
          );
          if (data.custody) {
            asset = await assignAssetInTransaction(
              tx,
              asset.id,
              data.custody,
              actorId,
            );
          }

          const write = await tx.agentDevice.updateMany({
            where: {
              id,
              deletedAt: null,
              isActive: true,
              assetId: null,
              updatedAt: expected,
            },
            data: { assetId: asset.id },
          });
          if (write.count !== 1) {
            throw new ApiError(
              "AGENT_DEVICE_VERSION_CONFLICT",
              "El dispositivo fue modificado por otro usuario",
              409,
            );
          }

          const updated = await tx.agentDevice.findFirst({
            where: { id, deletedAt: null },
            select: deviceListSelect,
          });
          if (!updated) {
            throw new ApiError(
              "AGENT_DEVICE_NOT_FOUND",
              "Dispositivo agente no encontrado",
              404,
            );
          }
          await tx.auditLog.create({
            data: {
              entity: "agent_device",
              entityId: id,
              action: "asset_link_updated",
              actorId,
              meta: {
                previousAssetLinked: false,
                assetLinked: true,
                assetId: asset.id,
                source: "created_from_agent",
                custodyAssigned: Boolean(data.custody),
              },
            },
          });
          return { device: serializeDevice(updated), asset };
        });
      } catch (error) {
        if (
          generatedTag &&
          isGeneratedAssetTagConflict(error) &&
          attempt < 4
        ) {
          continue;
        }
        const assetError = asAssetWriteError(error);
        if (assetError) throw assetError;
        translateWriteError(error);
      }
    }

    throw new ApiError(
      "ASSET_TAG_CONFLICT",
      "No se pudo reservar un código de activo",
      409,
    );
  }

  private static async transitionDevice(
    id: string,
    data: AgentDeviceTransitionRequest,
    actorId: string,
    activate: boolean,
  ) {
    return runSerializable(async (tx) => {
      const current = await tx.agentDevice.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true, updatedAt: true },
      });
      if (!current) {
        throw new ApiError("AGENT_DEVICE_NOT_FOUND", "Dispositivo agente no encontrado", 404);
      }
      const expected = new Date(data.expectedUpdatedAt);
      if (current.updatedAt.getTime() !== expected.getTime()) {
        throw new ApiError(
          "AGENT_DEVICE_VERSION_CONFLICT",
          "El dispositivo fue modificado por otro usuario",
          409,
        );
      }
      if (current.isActive === activate) {
        throw new ApiError(
          activate ? "AGENT_DEVICE_ALREADY_ACTIVE" : "AGENT_DEVICE_ALREADY_REVOKED",
          activate ? "El agente ya está activo" : "El agente ya está revocado",
          409,
        );
      }
      const write = await tx.agentDevice.updateMany({
        where: { id, deletedAt: null, updatedAt: expected, isActive: !activate },
        data: {
          isActive: activate,
          connState: AgentConnState.OFFLINE,
        },
      });
      if (write.count !== 1) {
        throw new ApiError(
          "AGENT_DEVICE_VERSION_CONFLICT",
          "El dispositivo fue modificado por otro usuario",
          409,
        );
      }
      if (!activate) {
        await tx.remoteSession.updateMany({
          where: { deviceId: id, status: RemoteSessionStatus.ACTIVE, endedAt: null },
          data: {
            status: RemoteSessionStatus.ERROR,
            endedAt: new Date(),
            errorMsg: "Agente revocado",
          },
        });
      }
      const updated = await tx.agentDevice.findFirst({
        where: { id, deletedAt: null },
        select: deviceListSelect,
      });
      if (!updated) {
        throw new ApiError("AGENT_DEVICE_NOT_FOUND", "Dispositivo agente no encontrado", 404);
      }
      await tx.auditLog.create({
        data: {
          entity: "agent_device",
          entityId: id,
          action: activate ? "activated" : "revoked",
          actorId,
          meta: { remoteSessionsClosed: !activate },
        },
      });
      return serializeDevice(updated);
    });
  }

  static activateDevice(id: string, data: AgentDeviceTransitionRequest, actorId: string) {
    return AgentsService.transitionDevice(id, data, actorId, true);
  }

  static revokeDevice(id: string, data: AgentDeviceTransitionRequest, actorId: string) {
    return AgentsService.transitionDevice(id, data, actorId, false);
  }

  static async listSnapshots(id: string, filters: SnapshotFilters) {
    const device = await prisma.agentDevice.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!device) {
      throw new ApiError("AGENT_DEVICE_NOT_FOUND", "Dispositivo agente no encontrado", 404);
    }
    const { page, pageSize } = filters;
    const where = { deviceId: id };
    const [items, total] = await Promise.all([
      prisma.agentInventorySnapshot.findMany({
        where,
        select: { id: true, payload: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.agentInventorySnapshot.count({ where }),
    ]);
    return { items, pagination: pageResult(page, pageSize, total) };
  }

  static async listMetrics(id: string, filters: MetricFilters) {
    const device = await prisma.agentDevice.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!device) {
      throw new ApiError("AGENT_DEVICE_NOT_FOUND", "Dispositivo agente no encontrado", 404);
    }
    const now = new Date();
    const from = filters.from
      ? new Date(filters.from)
      : new Date(now.getTime() - 24 * 60 * 60_000);
    const to = filters.to ? new Date(filters.to) : now;
    if (from > to) {
      throw new ApiError(
        "AGENT_METRIC_RANGE_INVALID",
        "El inicio del rango debe ser anterior al final",
        400,
      );
    }
    if (to.getTime() - from.getTime() > METRIC_RETENTION_MS) {
      throw new ApiError(
        "AGENT_METRIC_RANGE_TOO_LARGE",
        "El rango de métricas no puede superar 14 días",
        400,
      );
    }
    const desc = await prisma.agentMetricSample.findMany({
      where: { deviceId: id, sampledAt: { gte: from, lte: to } },
      select: metricSelect,
      orderBy: { sampledAt: "desc" },
      take: filters.limit,
    });
    return { items: desc.reverse() };
  }

  static async enrollMachine(data: MachineEnrollRequest) {
    const tokenHash = sha256(data.token);
    const secretHash = sha256(data.deviceSecret);
    try {
      return await runSerializable(async (tx) => {
        const now = new Date();
        const token = await tx.agentEnrollmentToken.findUnique({
          where: { tokenHash },
          select: {
            id: true,
            createdById: true,
            usedAt: true,
            expiresAt: true,
            usedByDevice: {
              select: { id: true, machineId: true, secretHash: true },
            },
          },
        });
        if (!token) {
          throw new ApiError(
            "ENROLLMENT_TOKEN_INVALID",
            "Token de enrolamiento inválido o no disponible",
            409,
          );
        }
        if (token.usedAt) {
          const sameEnrollment =
            token.usedByDevice?.machineId === data.machineGuid &&
            safeHashEquals(data.deviceSecret, token.usedByDevice.secretHash);
          if (!sameEnrollment) {
            throw new ApiError(
              "ENROLLMENT_TOKEN_NOT_AVAILABLE",
              "Token de enrolamiento inválido o no disponible",
              409,
            );
          }
          return {
            deviceId: token.usedByDevice!.id,
            nextHeartbeatSeconds: AGENT_HEARTBEAT_SECONDS,
          };
        }
        if (token.expiresAt <= now) {
          throw new ApiError(
            "ENROLLMENT_TOKEN_NOT_AVAILABLE",
            "Token de enrolamiento inválido o no disponible",
            409,
          );
        }

        const existing = await tx.agentDevice.findUnique({
          where: { machineId: data.machineGuid },
          select: {
            id: true,
            isActive: true,
            deletedAt: true,
          },
        });
        if (existing?.deletedAt) {
          throw new ApiError(
            "AGENT_MACHINE_NOT_AVAILABLE",
            "La identidad de máquina no está disponible para enrolamiento",
            409,
          );
        }

        let deviceId: string;
        if (existing) {
          // El schema sólo permite que un token apunte al dispositivo. Se
          // conserva usedAt/auditoría del token anterior, pero se libera su
          // asociación antes de relacionar el token nuevo.
          await tx.agentEnrollmentToken.updateMany({
            where: { usedByDeviceId: existing.id },
            data: { usedByDeviceId: null },
          });
          const updated = await tx.agentDevice.update({
            where: { id: existing.id },
            data: {
              secretHash,
              hostname: data.hostname,
              agentVersion: data.agentVersion,
              osName: data.osName,
              osVersion: data.osVersion,
              connState: AgentConnState.OFFLINE,
              lastEnrolledAt: now,
              // isActive y assetId se preservan intencionalmente.
            },
            select: { id: true },
          });
          deviceId = updated.id;
        } else {
          const created = await tx.agentDevice.create({
            data: {
              machineId: data.machineGuid,
              hostname: data.hostname,
              secretHash,
              agentVersion: data.agentVersion,
              osName: data.osName,
              osVersion: data.osVersion,
              connState: AgentConnState.OFFLINE,
              lastEnrolledAt: now,
            },
            select: { id: true },
          });
          deviceId = created.id;
        }

        const consumed = await tx.agentEnrollmentToken.updateMany({
          where: { id: token.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now, usedByDeviceId: deviceId },
        });
        if (consumed.count !== 1) {
          throw new ApiError(
            "ENROLLMENT_TOKEN_NOT_AVAILABLE",
            "Token de enrolamiento inválido o no disponible",
            409,
          );
        }
        await tx.auditLog.create({
          data: {
            entity: "agent_device",
            entityId: deviceId,
            action: existing ? "re_enrolled" : "enrolled",
            actorId: token.createdById,
            meta: {
              enrollmentTokenId: token.id,
              machineIdentityRedacted: true,
              secretRedacted: true,
            },
          },
        });
        return { deviceId, nextHeartbeatSeconds: AGENT_HEARTBEAT_SECONDS };
      });
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async authenticateMachine(deviceId: string, secret: string) {
    const device = await prisma.agentDevice.findFirst({
      where: { id: deviceId, deletedAt: null },
      select: { id: true, isActive: true, secretHash: true },
    });
    const expectedHash = device?.secretHash ?? DUMMY_HASH;
    const valid = safeHashEquals(secret, expectedHash);
    if (!device || !device.isActive || !valid) {
      throw new ApiError(
        "AGENT_AUTH_INVALID",
        "Credenciales de agente inválidas",
        401,
      );
    }
    return { id: device.id, secretHash: device.secretHash };
  }

  static async recordHeartbeat(
    deviceId: string,
    expectedSecretHash: string,
    data: MachineHeartbeatRequest,
  ) {
    return runSerializable(async (tx) => {
      const now = new Date();
      const current = await tx.agentDevice.findFirst({
        where: { id: deviceId, isActive: true, deletedAt: null },
        select: { id: true, secretHash: true, updatedAt: true },
      });
      if (
        !current ||
        !safeDigestEquals(expectedSecretHash, current.secretHash)
      ) {
        // Comparación directa posterior al auth: expectedSecretHash y el
        // valor persistido ya son hashes, no secretos. El mensaje permanece
        // uniforme ante revocación/rotación concurrente.
        throw new ApiError("AGENT_AUTH_INVALID", "Credenciales de agente inválidas", 401);
      }
      const primaryIp = usablePrimaryIp(data.ipAddresses);
      const primaryMac = [...new Set(data.macAddresses)][0] ?? null;
      const update = await tx.agentDevice.updateMany({
        where: {
          id: deviceId,
          isActive: true,
          deletedAt: null,
          secretHash: expectedSecretHash,
        },
        data: {
          // Telemetría tiene lastSeenAt propio. Conservar updatedAt evita que
          // cada heartbeat invalide el CAS de acciones humanas de gestión.
          updatedAt: current.updatedAt,
          hostname: data.hostname,
          agentVersion: data.agentVersion,
          osName: data.os.name,
          osVersion: data.os.version ?? data.os.build,
          connState: AgentConnState.ONLINE,
          lastSeenAt: now,
          loggedInUser: data.username ?? null,
          primaryIp,
          primaryMac,
          uptimeSec: data.uptimeSeconds,
          cpuPct: data.cpuPercent ?? null,
          ramUsedMb: mb(data.ram.usedBytes),
          ramTotalMb: mb(data.ram.totalBytes),
          batteryPct: data.battery?.percent ?? null,
          batteryCharging: data.battery?.charging ?? null,
          vncRunning: data.services.vnc.available,
          sshRunning: data.services.ssh.available,
        },
      });
      if (update.count !== 1) {
        throw new ApiError("AGENT_AUTH_INVALID", "Credenciales de agente inválidas", 401);
      }

      const lastMetric = await tx.agentMetricSample.findFirst({
        where: { deviceId },
        select: { sampledAt: true },
        orderBy: { sampledAt: "desc" },
      });
      if (!lastMetric || now.getTime() - lastMetric.sampledAt.getTime() >= METRIC_INTERVAL_MS) {
        await tx.agentMetricSample.create({
          data: {
            deviceId,
            cpuPct: data.cpuPercent ?? null,
            ramUsedMb: mb(data.ram.usedBytes),
            diskUsedPct: diskUsedPct(data.disks),
            batteryPct: data.battery?.percent ?? null,
            sampledAt: now,
          },
        });
      }
      await tx.agentMetricSample.deleteMany({
        where: {
          deviceId,
          sampledAt: { lt: new Date(now.getTime() - METRIC_RETENTION_MS) },
        },
      });

      if (data.inventory) {
        await tx.agentInventorySnapshot.create({
          data: {
            deviceId,
            payload: data.inventory as Prisma.InputJsonValue,
            createdAt: now,
          },
        });
        const excess = await tx.agentInventorySnapshot.findMany({
          where: { deviceId },
          select: { id: true },
          orderBy: { createdAt: "desc" },
          skip: SNAPSHOT_RETENTION,
        });
        if (excess.length) {
          await tx.agentInventorySnapshot.deleteMany({
            where: { id: { in: excess.map((snapshot) => snapshot.id) } },
          });
        }
      }
      return {
        acceptedAt: now.toISOString(),
        nextHeartbeatSeconds: AGENT_HEARTBEAT_SECONDS,
        state: "ONLINE" as const,
      };
    });
  }

  static async startRemoteSession(
    deviceId: string,
    data: StartRemoteSessionRequest,
    actorId: string,
    clientIp: string | null,
  ) {
    return runSerializable(async (tx) => {
      const now = new Date();
      const device = await tx.agentDevice.findFirst({
        where: { id: deviceId, isActive: true, deletedAt: null },
        select: {
          id: true,
          hostname: true,
          primaryIp: true,
          lastSeenAt: true,
          isActive: true,
          sshRunning: true,
          vncRunning: true,
          vncCredential: { select: { vncPort: true } },
        },
      });
      if (!device) {
        throw new ApiError("AGENT_DEVICE_NOT_FOUND", "Dispositivo agente no encontrado", 404);
      }
      if (deriveState(device, now) !== "ONLINE") {
        throw new ApiError(
          "AGENT_DEVICE_NOT_ONLINE",
          "El dispositivo debe estar online para iniciar acceso remoto directo",
          409,
        );
      }
      const isSsh = data.protocol === "SSH";
      if ((isSsh && !device.sshRunning) || (!isSsh && !device.vncRunning)) {
        throw new ApiError(
          "REMOTE_SERVICE_UNAVAILABLE",
          `El servicio ${data.protocol} no fue reportado como disponible`,
          409,
        );
      }
      const target = device.primaryIp && isIP(device.primaryIp)
        ? device.primaryIp
        : device.hostname;
      if (
        !isIP(target) &&
        !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/.test(target)
      ) {
        throw new ApiError(
          "REMOTE_TARGET_INVALID",
          "El dispositivo no tiene un destino remoto seguro",
          409,
        );
      }
      const configuredVncPort = device.vncCredential?.vncPort;
      const vncPort =
        Number.isInteger(configuredVncPort) &&
        configuredVncPort! >= 1 &&
        configuredVncPort! <= 65535
          ? configuredVncPort!
          : 5900;
      const port = isSsh ? 22 : vncPort;
      const kind = isSsh ? RemoteSessionKind.SSH : RemoteSessionKind.VNC;
      const session = await tx.remoteSession.create({
        data: {
          deviceId,
          userId: actorId,
          kind,
          clientIp,
          targetHost: target,
        },
        select: sessionSelect,
      });
      await tx.auditLog.create({
        data: {
          entity: "remote_session",
          entityId: session.id,
          action: "started",
          actorId,
          meta: {
            deviceId,
            protocol: data.protocol,
            targetRedacted: true,
            credentialReturned: false,
            scope: "DIRECT",
          },
        },
      });
      const uri = `${isSsh ? "ssh" : "vnc"}://${formatUriTarget(target)}:${port}`;
      return {
        session: serializeSession(session),
        connection: {
          protocol: data.protocol,
          target,
          port,
          uri,
          scope: "DIRECT" as const,
          requiresNetworkReachability: true,
          warning:
            "Acceso directo: el equipo del operador debe tener alcance de red al destino (LAN o VPN). No se incluyen credenciales.",
        },
      };
    });
  }

  static async closeRemoteSession(sessionId: string, actorId: string) {
    return runSerializable(async (tx) => {
      const current = await tx.remoteSession.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true, endedAt: true },
      });
      if (!current) {
        throw new ApiError("REMOTE_SESSION_NOT_FOUND", "Sesión remota no encontrada", 404);
      }
      if (current.status !== RemoteSessionStatus.ACTIVE || current.endedAt) {
        throw new ApiError(
          "REMOTE_SESSION_ALREADY_CLOSED",
          "La sesión remota ya fue cerrada",
          409,
        );
      }
      const endedAt = new Date();
      const write = await tx.remoteSession.updateMany({
        where: { id: sessionId, status: RemoteSessionStatus.ACTIVE, endedAt: null },
        data: { status: RemoteSessionStatus.CLOSED, endedAt },
      });
      if (write.count !== 1) {
        throw new ApiError(
          "REMOTE_SESSION_ALREADY_CLOSED",
          "La sesión remota ya fue cerrada",
          409,
        );
      }
      const session = await tx.remoteSession.findUnique({
        where: { id: sessionId },
        select: sessionSelect,
      });
      if (!session) {
        throw new ApiError("REMOTE_SESSION_NOT_FOUND", "Sesión remota no encontrada", 404);
      }
      await tx.auditLog.create({
        data: {
          entity: "remote_session",
          entityId: sessionId,
          action: "closed",
          actorId,
          meta: { deviceId: session.deviceId, credentialsReturned: false },
        },
      });
      return serializeSession(session);
    });
  }
}

export default AgentsService;
