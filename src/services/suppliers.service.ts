import { Prisma, PurchaseStatus } from "@prisma/client";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import type {
  CreateSupplierRequest,
  SupplierFilters,
  UpdateSupplierRequest,
} from "../validations/procurement";

const blockingPurchaseStatuses: PurchaseStatus[] = [
  PurchaseStatus.REQUESTED,
  PurchaseStatus.APPROVED,
  PurchaseStatus.ORDERED,
];

const supplierListSelect = {
  id: true,
  name: true,
  cuit: true,
  contactName: true,
  email: true,
  phone: true,
  categories: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      purchases: true,
      maintenances: true,
    },
  },
} as const;

const supplierDetailSelect = {
  id: true,
  name: true,
  cuit: true,
  contactName: true,
  email: true,
  phone: true,
  website: true,
  address: true,
  categories: true,
  notes: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { purchases: true, maintenances: true } },
  purchases: {
    select: {
      id: true,
      purchaseNumber: true,
      status: true,
      currency: true,
      totalAmount: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" as const },
    take: 20,
  },
} as const;

const supplierInternalSelect = {
  id: true,
  name: true,
  cuit: true,
  contactName: true,
  email: true,
  phone: true,
  website: true,
  address: true,
  categories: true,
  notes: true,
  isActive: true,
  updatedAt: true,
} as const;

const sensitiveFields = new Set([
  "contactName",
  "email",
  "phone",
  "address",
  "notes",
]);

const normalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return [...value].sort();
  return value ?? null;
};

const serializeListSupplier = (
  supplier: Record<string, any>,
  activePurchasesCount = 0,
) => {
  const { _count, ...safe } = supplier;
  return {
    ...safe,
    purchasesCount: _count?.purchases ?? 0,
    maintenancesCount: _count?.maintenances ?? 0,
    activePurchasesCount,
  };
};

const serializeDetailSupplier = (
  supplier: Record<string, any>,
  activePurchasesCount = 0,
) => {
  const { _count, purchases, ...safe } = supplier;
  return {
    ...safe,
    purchasesCount: _count?.purchases ?? 0,
    maintenancesCount: _count?.maintenances ?? 0,
    activePurchasesCount,
    recentPurchases: purchases.map((purchase: Record<string, any>) => ({
      ...purchase,
      totalAmount: String(purchase.totalAmount),
    })),
  };
};

const knownError = (
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;

const uniqueField = (error: unknown, field: string): boolean => {
  if (!knownError(error, "P2002")) return false;
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.includes(field)
    : typeof target === "string" && target.includes(field);
};

const translateWriteError = (error: unknown): never => {
  if (uniqueField(error, "name")) {
    throw new ApiError(
      "SUPPLIER_NAME_EXISTS",
      "Ya existe un proveedor con ese nombre",
      409,
    );
  }
  if (uniqueField(error, "cuit")) {
    throw new ApiError(
      "SUPPLIER_CUIT_EXISTS",
      "Ya existe un proveedor con ese CUIT",
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
          "SUPPLIER_WRITE_CONFLICT",
          "El proveedor cambió mientras se procesaba la operación",
          409,
        );
      }
    }
  }
  throw new ApiError(
    "SUPPLIER_WRITE_CONFLICT",
    "El proveedor cambió mientras se procesaba la operación",
    409,
  );
};

const ensureUniqueName = async (
  tx: Prisma.TransactionClient,
  name: string,
  excludingId?: string,
) => {
  const duplicate = await tx.supplier.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(excludingId ? { id: { not: excludingId } } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new ApiError(
      "SUPPLIER_NAME_EXISTS",
      "Ya existe un proveedor con ese nombre",
      409,
    );
  }
};

const buildAudit = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) => {
  const fields: string[] = [];
  const changes: Record<string, unknown> = {};
  for (const field of Object.keys(after)) {
    if (field === "id" || field === "updatedAt") continue;
    if (JSON.stringify(normalize(before[field])) === JSON.stringify(normalize(after[field]))) {
      continue;
    }
    fields.push(field);
    changes[field] = sensitiveFields.has(field)
      ? { changed: true, redacted: true }
      : { from: normalize(before[field]), to: normalize(after[field]) };
  }
  return { fields, changes };
};

export class SuppliersService {
  static async list(filters: SupplierFilters) {
    const { q, category, isActive, page, pageSize } = filters;
    const where: Prisma.SupplierWhereInput = {
      deletedAt: null,
      ...(isActive !== undefined ? { isActive } : {}),
      ...(category ? { categories: { has: category } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { cuit: { contains: q } },
              { categories: { has: q } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.supplier.findMany({
        where,
        select: supplierListSelect,
        orderBy: { name: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.supplier.count({ where }),
    ]);
    const grouped =
      items.length > 0
        ? ((await prisma.purchase.groupBy({
            by: ["supplierId"],
            where: {
              supplierId: { in: items.map((item) => item.id) },
              status: { in: blockingPurchaseStatuses },
            },
            _count: { _all: true },
          })) ?? [])
        : [];
    const activeCounts = new Map(
      grouped.map((row) => [row.supplierId, row._count._all]),
    );
    return {
      items: items.map((item) =>
        serializeListSupplier(item, activeCounts.get(item.id) ?? 0),
      ),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  static async getOne(id: string) {
    const supplier = await prisma.supplier.findFirst({
      where: { id, deletedAt: null },
      select: supplierDetailSelect,
    });
    if (!supplier) {
      throw new ApiError("SUPPLIER_NOT_FOUND", "Proveedor no encontrado", 404);
    }
    const activePurchasesCount = await prisma.purchase.count({
      where: {
        supplierId: id,
        status: { in: blockingPurchaseStatuses },
      },
    });
    return serializeDetailSupplier(supplier, activePurchasesCount);
  }

  static async create(data: CreateSupplierRequest, actorId: string) {
    try {
      const supplier = await runSerializable(async (tx) => {
        await ensureUniqueName(tx, data.name);
        const created = await tx.supplier.create({
          data: {
            name: data.name,
            cuit: data.cuit,
            contactName: data.contactName,
            email: data.email,
            phone: data.phone,
            website: data.website,
            address: data.address,
            categories: data.categories,
            notes: data.notes,
          },
          select: supplierDetailSelect,
        });
        await tx.auditLog.create({
          data: {
            entity: "supplier",
            entityId: created.id,
            action: "created",
            actorId,
            meta: {
              fields: ["name", "cuit", "categories"],
              contactDataProvided: Boolean(
                data.contactName || data.email || data.phone || data.address,
              ),
              notesProvided: Boolean(data.notes),
            },
          },
        });
        const activePurchasesCount = await tx.purchase.count({
          where: {
            supplierId: created.id,
            status: { in: blockingPurchaseStatuses },
          },
        });
        return { created, activePurchasesCount };
      });
      logger.info({ supplierId: supplier.created.id, actorId }, "Supplier created");
      return serializeDetailSupplier(
        supplier.created,
        supplier.activePurchasesCount,
      );
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async update(
    id: string,
    data: UpdateSupplierRequest,
    actorId: string,
  ) {
    const { expectedUpdatedAt, ...changes } = data;
    const expectedVersion = new Date(expectedUpdatedAt);
    try {
      const result = await runSerializable(async (tx) => {
        const current = await tx.supplier.findFirst({
          where: { id, deletedAt: null },
          select: supplierInternalSelect,
        });
        if (!current) {
          throw new ApiError("SUPPLIER_NOT_FOUND", "Proveedor no encontrado", 404);
        }
        if (current.updatedAt.getTime() !== expectedVersion.getTime()) {
          throw new ApiError(
            "SUPPLIER_VERSION_CONFLICT",
            "El proveedor fue modificado por otro usuario",
            409,
          );
        }
        if (
          changes.name !== undefined &&
          changes.name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()
        ) {
          await ensureUniqueName(tx, changes.name, id);
        }
        if (changes.isActive === false && current.isActive) {
          const blocking = await tx.purchase.count({
            where: {
              supplierId: id,
              status: { in: [...blockingPurchaseStatuses] },
            },
          });
          if (blocking > 0) {
            throw new ApiError(
              "SUPPLIER_HAS_OPEN_PURCHASES",
              "No se puede desactivar un proveedor con compras abiertas",
              409,
              { count: blocking },
            );
          }
        }
        const candidate = { ...current, ...changes };
        const audit = buildAudit(current, candidate);
        if (audit.fields.length === 0) {
          const unchanged = await tx.supplier.findFirst({
            where: { id, deletedAt: null },
            select: supplierDetailSelect,
          });
          if (!unchanged) {
            throw new ApiError("SUPPLIER_NOT_FOUND", "Proveedor no encontrado", 404);
          }
          const activePurchasesCount = await tx.purchase.count({
            where: {
              supplierId: id,
              status: { in: blockingPurchaseStatuses },
            },
          });
          return { supplier: unchanged, changed: false, activePurchasesCount };
        }
        const write = await tx.supplier.updateMany({
          where: { id, deletedAt: null, updatedAt: expectedVersion },
          data: changes,
        });
        if (write.count !== 1) {
          throw new ApiError(
            "SUPPLIER_VERSION_CONFLICT",
            "El proveedor fue modificado por otro usuario",
            409,
          );
        }
        const updated = await tx.supplier.findFirst({
          where: { id, deletedAt: null },
          select: supplierDetailSelect,
        });
        if (!updated) {
          throw new ApiError("SUPPLIER_NOT_FOUND", "Proveedor no encontrado", 404);
        }
        await tx.auditLog.create({
          data: {
            entity: "supplier",
            entityId: id,
            action: "updated",
            actorId,
            meta: audit as Prisma.InputJsonValue,
          },
        });
        const activePurchasesCount = await tx.purchase.count({
          where: {
            supplierId: id,
            status: { in: blockingPurchaseStatuses },
          },
        });
        return { supplier: updated, changed: true, activePurchasesCount };
      });
      logger.info(
        { supplierId: id, actorId, changed: result.changed },
        result.changed ? "Supplier updated" : "Supplier update skipped",
      );
      return serializeDetailSupplier(
        result.supplier,
        result.activePurchasesCount,
      );
    } catch (error) {
      translateWriteError(error);
    }
  }
}

export default SuppliersService;
