import {
  AssetStatus,
  MaintenanceStatus,
  Prisma,
  UserRole,
} from "@prisma/client";
import { prisma } from "../lib/database";
import { SERIALIZABLE_TX_OPTIONS } from "../lib/txOptions";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import type {
  CreateMaintenanceRequest,
  MaintenanceFilters,
  UpdateMaintenanceRequest,
} from "../validations/maintenances";

const personPreviewSelect = {
  id: true,
  firstName: true,
  lastName: true,
  employeeNumber: true,
} as const;

const departmentPreviewSelect = {
  id: true,
  name: true,
  slug: true,
} as const;

const assetPreviewSelect = {
  id: true,
  assetTag: true,
  type: true,
  status: true,
  brand: true,
  model: true,
  serialNumber: true,
  assignedPersonId: true,
  assignedDepartmentId: true,
  assignedPerson: { select: personPreviewSelect },
  assignedDepartment: { select: departmentPreviewSelect },
} as const;

const userPreviewSelect = {
  id: true,
  name: true,
} as const;

const supplierPreviewSelect = {
  id: true,
  name: true,
  categories: true,
} as const;

const ticketPreviewSelect = {
  id: true,
  ticketNumber: true,
  title: true,
  status: true,
  assetId: true,
} as const;

const maintenanceSafeScalarSelect = {
  id: true,
  assetId: true,
  type: true,
  status: true,
  scheduledAt: true,
  performedAt: true,
  description: true,
  performedById: true,
  supplierId: true,
  costAmount: true,
  currency: true,
  parts: true,
  ticketId: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

const maintenanceListSelect = {
  id: true,
  assetId: true,
  type: true,
  status: true,
  scheduledAt: true,
  performedAt: true,
  description: true,
  performedById: true,
  supplierId: true,
  costAmount: true,
  currency: true,
  ticketId: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  asset: { select: assetPreviewSelect },
  performedBy: { select: userPreviewSelect },
  supplier: { select: supplierPreviewSelect },
} as const;

const maintenanceDetailSelect = {
  ...maintenanceListSelect,
  parts: true,
  createdBy: { select: userPreviewSelect },
  ticket: { select: ticketPreviewSelect },
} as const;

const maintenanceInternalSelect = {
  ...maintenanceSafeScalarSelect,
} as const;

const auditableFields = [
  "assetId",
  "type",
  "status",
  "scheduledAt",
  "performedAt",
  "description",
  "performedById",
  "supplierId",
  "costAmount",
  "currency",
  "parts",
  "ticketId",
] as const;

const redactedAuditFields = new Set(["description", "parts"]);

type MaintenancePart = {
  name: string;
  quantity: number;
  unitCost?: string | null;
};

const sanitizeParts = (value: unknown): MaintenancePart[] | null => {
  if (!Array.isArray(value)) return null;
  const parts: MaintenancePart[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.name !== "string" ||
      !Number.isInteger(candidate.quantity) ||
      (candidate.quantity as number) <= 0
    ) {
      continue;
    }
    const part: MaintenancePart = {
      name: candidate.name,
      quantity: candidate.quantity as number,
    };
    if (
      (typeof candidate.unitCost === "string" &&
        /^\d{1,12}(?:\.\d{1,2})?$/.test(candidate.unitCost)) ||
      (typeof candidate.unitCost === "number" &&
        Number.isFinite(candidate.unitCost) &&
        candidate.unitCost >= 0)
    ) {
      part.unitCost = String(candidate.unitCost);
    }
    parts.push(part);
  }
  return parts;
};

const serializeMaintenance = <T extends Record<string, any>>(
  item: T,
  preview = false,
) => ({
  ...item,
  description:
    preview && item.description.length > 240
      ? `${item.description.slice(0, 237)}...`
      : item.description,
  costAmount:
    item.costAmount === null || item.costAmount === undefined
      ? null
      : String(item.costAmount),
  parts: preview ? undefined : sanitizeParts(item.parts),
});

const parseDate = (
  value: string | null | undefined,
): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (
    Number.isNaN(parsed.getTime()) ||
    (dateOnly && parsed.toISOString().slice(0, 10) !== value)
  ) {
    throw new ApiError("MAINTENANCE_DATE_INVALID", "Fecha inválida", 400);
  }
  return parsed;
};

const parseFilterDate = (value: string, endOfDay: boolean): Date => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = parseDate(value) as Date;
    if (endOfDay) parsed.setUTCHours(23, 59, 59, 999);
    return parsed;
  }
  return parseDate(value) as Date;
};

const jsonInput = (
  value: Array<Record<string, unknown>> | MaintenancePart[] | null | undefined,
) => {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as unknown as Prisma.InputJsonValue;
};

const normalizeComparable = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value === undefined) return null;
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
};

const valuesEqual = (left: unknown, right: unknown): boolean =>
  normalizeComparable(left) === normalizeComparable(right);

const auditScalar = (value: unknown): string | number | boolean | null => {
  const normalized = normalizeComparable(value);
  if (
    normalized === null ||
    typeof normalized === "string" ||
    typeof normalized === "number" ||
    typeof normalized === "boolean"
  ) {
    return normalized as string | number | boolean | null;
  }
  return null;
};

const buildAudit = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) => {
  const fields: string[] = [];
  const changes: Record<string, Prisma.InputJsonValue> = {};
  for (const field of auditableFields) {
    if (valuesEqual(before[field], after[field])) continue;
    fields.push(field);
    changes[field] = (redactedAuditFields.has(field)
      ? { changed: true, redacted: true }
      : {
          from: auditScalar(before[field]),
          to: auditScalar(after[field]),
        }) as Prisma.InputJsonValue;
  }
  return { fields, changes };
};

const isKnownPrismaError = (
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;

const runSerializable = async <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        ...SERIALIZABLE_TX_OPTIONS,
      });
    } catch (error) {
      if (!isKnownPrismaError(error, "P2034")) throw error;
      if (attempt === 2) {
        throw new ApiError(
          "MAINTENANCE_WRITE_CONFLICT",
          "El mantenimiento cambió mientras se procesaba la operación",
          409,
        );
      }
    }
  }
  throw new ApiError(
    "MAINTENANCE_WRITE_CONFLICT",
    "El mantenimiento cambió mientras se procesaba la operación",
    409,
  );
};

const findMaintenance = async (tx: Prisma.TransactionClient, id: string) => {
  const maintenance = await tx.maintenance.findUnique({
    where: { id },
    select: maintenanceInternalSelect,
  });
  if (!maintenance) {
    throw new ApiError(
      "MAINTENANCE_NOT_FOUND",
      "Mantenimiento no encontrado",
      404,
    );
  }
  return maintenance;
};

const findAsset = async (tx: Prisma.TransactionClient, assetId: string) => {
  const asset = await tx.asset.findFirst({
    where: { id: assetId, isActive: true },
    select: {
      id: true,
      status: true,
      assignedPersonId: true,
      assignedDepartmentId: true,
    },
  });
  if (!asset) {
    throw new ApiError("ASSET_NOT_FOUND", "Activo no encontrado", 404);
  }
  return asset;
};

const activeStatuses: MaintenanceStatus[] = [
  MaintenanceStatus.SCHEDULED,
  MaintenanceStatus.IN_PROGRESS,
];

const validateReferences = async (
  tx: Prisma.TransactionClient,
  candidate: Record<string, any>,
  validate: {
    performer?: boolean;
    supplier?: boolean;
    ticket?: boolean;
  } = { performer: true, supplier: true, ticket: true },
) => {
  const asset = await findAsset(tx, candidate.assetId);
  if (
    activeStatuses.includes(candidate.status) &&
    (asset.status === AssetStatus.RETIRED || asset.status === AssetStatus.LOST)
  ) {
    throw new ApiError(
      "ASSET_NOT_MAINTAINABLE",
      "No se puede abrir un mantenimiento sobre un activo retirado o perdido",
      409,
    );
  }

  if (validate.performer && candidate.performedById) {
    const performer = await tx.user.findFirst({
      where: {
        id: candidate.performedById,
        isActive: true,
        deletedAt: null,
        role: { in: [UserRole.AGENT, UserRole.ADMIN] },
      },
      select: { id: true },
    });
    if (!performer) {
      throw new ApiError(
        "MAINTENANCE_PERFORMER_NOT_FOUND",
        "Técnico activo no encontrado",
        404,
      );
    }
  }

  if (validate.supplier && candidate.supplierId) {
    const supplier = await tx.supplier.findFirst({
      where: {
        id: candidate.supplierId,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!supplier) {
      throw new ApiError(
        "MAINTENANCE_SUPPLIER_NOT_FOUND",
        "Proveedor activo no encontrado",
        404,
      );
    }
  }

  if (validate.ticket && candidate.ticketId) {
    const ticket = await tx.ticket.findUnique({
      where: { id: candidate.ticketId },
      select: { id: true, assetId: true },
    });
    if (!ticket) {
      throw new ApiError("MAINTENANCE_TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }
    if (ticket.assetId && ticket.assetId !== candidate.assetId) {
      throw new ApiError(
        "MAINTENANCE_TICKET_ASSET_MISMATCH",
        "El ticket está vinculado a otro activo",
        409,
      );
    }
  }

  return asset;
};

const validateStatusDates = (candidate: Record<string, any>) => {
  if (candidate.status === MaintenanceStatus.SCHEDULED && !candidate.scheduledAt) {
    throw new ApiError(
      "MAINTENANCE_SCHEDULE_REQUIRED",
      "Un mantenimiento programado requiere fecha programada",
      400,
    );
  }
  if (candidate.status === MaintenanceStatus.COMPLETED && !candidate.performedAt) {
    throw new ApiError(
      "MAINTENANCE_PERFORMED_AT_REQUIRED",
      "Un mantenimiento completado requiere fecha de ejecución",
      400,
    );
  }
  if (
    candidate.status === MaintenanceStatus.COMPLETED &&
    !candidate.performedById &&
    !candidate.supplierId
  ) {
    throw new ApiError(
      "MAINTENANCE_PERFORMER_REQUIRED",
      "Un mantenimiento completado requiere técnico y/o proveedor",
      400,
    );
  }
  if (
    candidate.status !== MaintenanceStatus.COMPLETED &&
    candidate.performedAt
  ) {
    throw new ApiError(
      "MAINTENANCE_PERFORMED_AT_STATUS_INVALID",
      "La fecha de ejecución sólo corresponde a un mantenimiento completado",
      400,
    );
  }
};

const allowedTransitions: Record<MaintenanceStatus, MaintenanceStatus[]> = {
  SCHEDULED: [
    MaintenanceStatus.SCHEDULED,
    MaintenanceStatus.IN_PROGRESS,
    MaintenanceStatus.COMPLETED,
    MaintenanceStatus.CANCELLED,
  ],
  IN_PROGRESS: [
    MaintenanceStatus.IN_PROGRESS,
    MaintenanceStatus.COMPLETED,
    MaintenanceStatus.CANCELLED,
  ],
  COMPLETED: [MaintenanceStatus.COMPLETED],
  CANCELLED: [MaintenanceStatus.CANCELLED],
};

const assertTransition = (
  before: MaintenanceStatus,
  after: MaintenanceStatus,
) => {
  if (!allowedTransitions[before].includes(after)) {
    throw new ApiError(
      "MAINTENANCE_STATUS_TRANSITION_INVALID",
      "La transición de estado solicitada no está permitida",
      409,
      { from: before, to: after },
    );
  }
};

const ensureNoOtherInProgress = async (
  tx: Prisma.TransactionClient,
  assetId: string,
  excludeId?: string,
) => {
  const other = await tx.maintenance.findFirst({
    where: {
      assetId,
      status: MaintenanceStatus.IN_PROGRESS,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (other) {
    throw new ApiError(
      "ASSET_MAINTENANCE_IN_PROGRESS",
      "El activo ya tiene un mantenimiento en curso",
      409,
    );
  }
};

const assertAssetCanStartRepair = (asset: {
  status: AssetStatus;
}) => {
  if (asset.status === AssetStatus.IN_REPAIR) {
    throw new ApiError(
      "ASSET_ALREADY_IN_REPAIR",
      "El activo ya estaba en reparación fuera de este mantenimiento",
      409,
    );
  }
  if (
    asset.status !== AssetStatus.IN_STOCK &&
    asset.status !== AssetStatus.ASSIGNED
  ) {
    throw new ApiError(
      "ASSET_NOT_MAINTAINABLE",
      "El activo no está disponible para iniciar el mantenimiento",
      409,
    );
  }
};

const startAssetRepair = async (
  tx: Prisma.TransactionClient,
  maintenanceId: string,
  asset: {
    id: string;
    status: AssetStatus;
    assignedPersonId: string | null;
    assignedDepartmentId: string | null;
  },
  actorId: string,
) => {
  assertAssetCanStartRepair(asset);
  const changed = await tx.asset.updateMany({
    where: { id: asset.id, isActive: true, status: asset.status },
    data: { status: AssetStatus.IN_REPAIR },
  });
  if (changed.count !== 1) {
    throw new ApiError(
      "ASSET_MAINTENANCE_STATE_CONFLICT",
      "El estado del activo cambió mientras se iniciaba el mantenimiento",
      409,
    );
  }
  await tx.auditLog.create({
    data: {
      entity: "asset",
      entityId: asset.id,
      action: "maintenance_started",
      actorId,
      meta: {
        maintenanceId,
        status: { from: asset.status, to: AssetStatus.IN_REPAIR },
      },
    },
  });
};

const finishAssetRepair = async (
  tx: Prisma.TransactionClient,
  maintenanceId: string,
  assetId: string,
  actorId: string,
) => {
  await ensureNoOtherInProgress(tx, assetId, maintenanceId);
  const asset = await findAsset(tx, assetId);
  if (asset.status !== AssetStatus.IN_REPAIR) {
    throw new ApiError(
      "ASSET_MAINTENANCE_STATE_CONFLICT",
      "El activo dejó de estar en reparación; no se sobrescribió su estado",
      409,
    );
  }
  const assignment = await tx.assetAssignment.findFirst({
    where: { assetId, endAt: null },
    orderBy: { startAt: "desc" },
    select: { id: true, personId: true, departmentId: true },
  });
  const hasHolder = Boolean(assignment?.personId || assignment?.departmentId);
  const restoredStatus = hasHolder
    ? AssetStatus.ASSIGNED
    : AssetStatus.IN_STOCK;
  const changed = await tx.asset.updateMany({
    where: { id: assetId, isActive: true, status: AssetStatus.IN_REPAIR },
    data: {
      status: restoredStatus,
      assignedPersonId: assignment?.personId ?? null,
      assignedDepartmentId: assignment?.departmentId ?? null,
    },
  });
  if (changed.count !== 1) {
    throw new ApiError(
      "ASSET_MAINTENANCE_STATE_CONFLICT",
      "El estado del activo cambió mientras se cerraba el mantenimiento",
      409,
    );
  }
  await tx.auditLog.create({
    data: {
      entity: "asset",
      entityId: assetId,
      action: "maintenance_finished",
      actorId,
      meta: {
        maintenanceId,
        assignmentId: assignment?.id ?? null,
        status: { from: AssetStatus.IN_REPAIR, to: restoredStatus },
      },
    },
  });
};

const makeCreateCandidate = (data: CreateMaintenanceRequest) => ({
  ...data,
  scheduledAt: parseDate(data.scheduledAt),
  performedAt: parseDate(data.performedAt),
  parts: data.parts ?? null,
  costAmount: data.costAmount ?? null,
  performedById: data.performedById ?? null,
  supplierId: data.supplierId ?? null,
  ticketId: data.ticketId ?? null,
});

const makeUpdateCandidate = (
  current: Record<string, any>,
  changes: Record<string, any>,
) => {
  const candidate = { ...current };
  for (const [field, value] of Object.entries(changes)) {
    if (field === "scheduledAt" || field === "performedAt") {
      candidate[field] = parseDate(value as string | null);
    } else {
      candidate[field] = value;
    }
  }
  return candidate;
};

export class MaintenancesService {
  static async list(filters: MaintenanceFilters) {
    const {
      q,
      type,
      status,
      assetId,
      supplierId,
      scheduledFrom,
      scheduledTo,
      page,
      pageSize,
    } = filters;
    const where: Prisma.MaintenanceWhereInput = {};
    if (type) where.type = type;
    if (status) where.status = status;
    if (assetId) where.assetId = assetId;
    if (supplierId) where.supplierId = supplierId;
    if (scheduledFrom || scheduledTo) {
      where.scheduledAt = {
        ...(scheduledFrom
          ? { gte: parseFilterDate(scheduledFrom, false) }
          : {}),
        ...(scheduledTo ? { lte: parseFilterDate(scheduledTo, true) } : {}),
      };
    }
    if (q) {
      where.OR = [
        { description: { contains: q, mode: "insensitive" } },
        { asset: { is: { assetTag: { contains: q, mode: "insensitive" } } } },
        { asset: { is: { brand: { contains: q, mode: "insensitive" } } } },
        { asset: { is: { model: { contains: q, mode: "insensitive" } } } },
        { supplier: { is: { name: { contains: q, mode: "insensitive" } } } },
        { performedBy: { is: { name: { contains: q, mode: "insensitive" } } } },
        { ticket: { is: { title: { contains: q, mode: "insensitive" } } } },
      ];
    }

    const orderBy: Prisma.MaintenanceOrderByWithRelationInput[] =
      status === MaintenanceStatus.SCHEDULED
        ? [{ scheduledAt: "asc" }, { createdAt: "desc" }]
        : status === MaintenanceStatus.COMPLETED
          ? [{ performedAt: "desc" }, { createdAt: "desc" }]
          : [{ createdAt: "desc" }];

    const [items, total] = await prisma.$transaction([
      prisma.maintenance.findMany({
        where,
        select: maintenanceListSelect,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.maintenance.count({ where }),
    ]);

    return {
      items: items.map((item) => serializeMaintenance(item, true)),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      },
    };
  }

  static async getOne(id: string) {
    const maintenance = await prisma.maintenance.findUnique({
      where: { id },
      select: maintenanceDetailSelect,
    });
    if (!maintenance) {
      throw new ApiError(
        "MAINTENANCE_NOT_FOUND",
        "Mantenimiento no encontrado",
        404,
      );
    }
    return serializeMaintenance(maintenance);
  }

  static async lookups() {
    const [suppliers, performers, tickets] = await Promise.all([
      prisma.supplier.findMany({
        where: { isActive: true, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.user.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          role: { in: [UserRole.AGENT, UserRole.ADMIN] },
        },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.ticket.findMany({
        select: {
          id: true,
          ticketNumber: true,
          title: true,
          status: true,
          assetId: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);
    return { suppliers, performers, tickets };
  }

  static async create(data: CreateMaintenanceRequest, actorId: string) {
    const candidate = makeCreateCandidate(data);
    validateStatusDates(candidate);

    const maintenance = await runSerializable(async (tx) => {
      const asset = await validateReferences(tx, candidate);
      if (candidate.status === MaintenanceStatus.IN_PROGRESS) {
        await ensureNoOtherInProgress(tx, candidate.assetId);
        assertAssetCanStartRepair(asset);
      }

      const created = await tx.maintenance.create({
        data: {
          assetId: candidate.assetId,
          type: candidate.type,
          status: candidate.status,
          scheduledAt: candidate.scheduledAt,
          performedAt: candidate.performedAt,
          description: candidate.description,
          performedById: candidate.performedById,
          supplierId: candidate.supplierId,
          costAmount: candidate.costAmount,
          currency: candidate.currency,
          parts: jsonInput(candidate.parts),
          ticketId: candidate.ticketId,
          createdById: actorId,
        },
        select: maintenanceDetailSelect,
      });

      if (candidate.status === MaintenanceStatus.IN_PROGRESS) {
        await startAssetRepair(tx, created.id, asset, actorId);
      }
      await tx.auditLog.create({
        data: {
          entity: "maintenance",
          entityId: created.id,
          action: "created",
          actorId,
          meta: {
            fields: auditableFields.filter(
              (field) => candidate[field] !== null && candidate[field] !== undefined,
            ),
            description: { stored: true, redacted: true },
            parts: candidate.parts
              ? { stored: true, redacted: true, count: candidate.parts.length }
              : null,
          },
        },
      });
      return created;
    });

    logger.info(
      { maintenanceId: maintenance.id, actorId },
      "Maintenance created",
    );
    return serializeMaintenance(maintenance);
  }

  static async update(
    id: string,
    data: UpdateMaintenanceRequest,
    actorId: string,
  ) {
    const { expectedUpdatedAt, ...changes } = data;
    const expectedVersion = new Date(expectedUpdatedAt);

    const result = await runSerializable(async (tx) => {
      const current = await findMaintenance(tx, id);
      if (current.updatedAt.getTime() !== expectedVersion.getTime()) {
        throw new ApiError(
          "MAINTENANCE_VERSION_CONFLICT",
          "El mantenimiento fue modificado por otro usuario",
          409,
        );
      }
      if (changes.assetId && changes.assetId !== current.assetId) {
        throw new ApiError(
          "MAINTENANCE_ASSET_IMMUTABLE",
          "No se puede cambiar el activo de un mantenimiento existente",
          409,
        );
      }

      const candidate = makeUpdateCandidate(current, changes);
      assertTransition(current.status, candidate.status);
      validateStatusDates(candidate);
      const enteringCompleted =
        current.status !== MaintenanceStatus.COMPLETED &&
        candidate.status === MaintenanceStatus.COMPLETED;
      const asset = await validateReferences(tx, candidate, {
        performer:
          enteringCompleted ||
          (Object.prototype.hasOwnProperty.call(changes, "performedById") &&
            changes.performedById !== current.performedById),
        supplier:
          enteringCompleted ||
          (Object.prototype.hasOwnProperty.call(changes, "supplierId") &&
            changes.supplierId !== current.supplierId),
        ticket:
          enteringCompleted ||
          (Object.prototype.hasOwnProperty.call(changes, "ticketId") &&
            changes.ticketId !== current.ticketId),
      });
      const enteringProgress =
        current.status !== MaintenanceStatus.IN_PROGRESS &&
        candidate.status === MaintenanceStatus.IN_PROGRESS;
      const leavingProgress =
        current.status === MaintenanceStatus.IN_PROGRESS &&
        (candidate.status === MaintenanceStatus.COMPLETED ||
          candidate.status === MaintenanceStatus.CANCELLED);
      if (enteringProgress) {
        await ensureNoOtherInProgress(tx, candidate.assetId, id);
        assertAssetCanStartRepair(asset);
      }

      const audit = buildAudit(current, candidate);
      if (audit.fields.length === 0) {
        const unchanged = await tx.maintenance.findUnique({
          where: { id },
          select: maintenanceDetailSelect,
        });
        if (!unchanged) {
          throw new ApiError(
            "MAINTENANCE_NOT_FOUND",
            "Mantenimiento no encontrado",
            404,
          );
        }
        return { maintenance: unchanged, changed: false };
      }

      if (enteringProgress) {
        await startAssetRepair(tx, id, asset, actorId);
      } else if (leavingProgress) {
        await finishAssetRepair(tx, id, current.assetId, actorId);
      }

      const updateData: Prisma.MaintenanceUncheckedUpdateManyInput = {};
      const fields = new Set(audit.fields);
      if (fields.has("type")) updateData.type = candidate.type;
      if (fields.has("status")) updateData.status = candidate.status;
      if (fields.has("scheduledAt")) updateData.scheduledAt = candidate.scheduledAt;
      if (fields.has("performedAt")) updateData.performedAt = candidate.performedAt;
      if (fields.has("description")) updateData.description = candidate.description;
      if (fields.has("performedById")) updateData.performedById = candidate.performedById;
      if (fields.has("supplierId")) updateData.supplierId = candidate.supplierId;
      if (fields.has("costAmount")) updateData.costAmount = candidate.costAmount;
      if (fields.has("currency")) updateData.currency = candidate.currency;
      if (fields.has("parts")) updateData.parts = jsonInput(candidate.parts);
      if (fields.has("ticketId")) updateData.ticketId = candidate.ticketId;

      const write = await tx.maintenance.updateMany({
        where: { id, updatedAt: expectedVersion },
        data: updateData,
      });
      if (write.count !== 1) {
        throw new ApiError(
          "MAINTENANCE_VERSION_CONFLICT",
          "El mantenimiento fue modificado por otro usuario",
          409,
        );
      }
      const updated = await tx.maintenance.findUnique({
        where: { id },
        select: maintenanceDetailSelect,
      });
      if (!updated) {
        throw new ApiError(
          "MAINTENANCE_NOT_FOUND",
          "Mantenimiento no encontrado",
          404,
        );
      }
      await tx.auditLog.create({
        data: {
          entity: "maintenance",
          entityId: id,
          action: "updated",
          actorId,
          meta: audit as Prisma.InputJsonValue,
        },
      });
      return { maintenance: updated, changed: true };
    });

    logger.info(
      { maintenanceId: id, actorId, changed: result.changed },
      result.changed ? "Maintenance updated" : "Maintenance update skipped",
    );
    return serializeMaintenance(result.maintenance);
  }
}

export default MaintenancesService;
