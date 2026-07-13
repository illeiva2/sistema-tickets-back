import {
  Currency,
  Prisma,
  PurchaseStatus,
  UserRole,
} from "@prisma/client";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import type {
  CancelPurchaseRequest,
  CreatePurchaseRequest,
  PurchaseFilters,
  PurchaseTransitionRequest,
  UpdatePurchaseRequest,
} from "../validations/procurement";

const userPreviewSelect = { id: true, name: true } as const;
const supplierPreviewSelect = {
  id: true,
  name: true,
  categories: true,
  isActive: true,
} as const;
const linkedAssetSelect = {
  id: true,
  assetTag: true,
  type: true,
  status: true,
  brand: true,
  model: true,
  serialNumber: true,
} as const;

const purchaseItemListSelect = {
  id: true,
  description: true,
  quantity: true,
  unitPrice: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { assets: true } },
} as const;

const purchaseItemDetailSelect = {
  id: true,
  description: true,
  quantity: true,
  unitPrice: true,
  createdAt: true,
  updatedAt: true,
  assets: {
    select: linkedAssetSelect,
    orderBy: { assetTag: "asc" as const },
  },
} as const;

const purchaseListSelect = {
  id: true,
  purchaseNumber: true,
  status: true,
  supplierId: true,
  supplier: { select: supplierPreviewSelect },
  currency: true,
  totalAmount: true,
  exchangeRate: true,
  justification: true,
  requestedById: true,
  requestedBy: { select: userPreviewSelect },
  authorizedById: true,
  authorizedBy: { select: userPreviewSelect },
  authorizedAt: true,
  orderedAt: true,
  receivedAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: purchaseItemListSelect,
    orderBy: { createdAt: "asc" as const },
  },
} as const;

const purchaseDetailSelect = {
  id: true,
  purchaseNumber: true,
  status: true,
  supplierId: true,
  supplier: { select: supplierPreviewSelect },
  currency: true,
  totalAmount: true,
  exchangeRate: true,
  justification: true,
  invoiceNumber: true,
  notes: true,
  requestedById: true,
  requestedBy: { select: userPreviewSelect },
  authorizedById: true,
  authorizedBy: { select: userPreviewSelect },
  authorizedAt: true,
  orderedAt: true,
  receivedAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: purchaseItemDetailSelect,
    orderBy: { createdAt: "asc" as const },
  },
} as const;

const purchaseInternalSelect = {
  id: true,
  purchaseNumber: true,
  status: true,
  supplierId: true,
  currency: true,
  totalAmount: true,
  exchangeRate: true,
  justification: true,
  invoiceNumber: true,
  notes: true,
  requestedById: true,
  authorizedById: true,
  authorizedAt: true,
  orderedAt: true,
  receivedAt: true,
  updatedAt: true,
  items: {
    select: {
      id: true,
      description: true,
      quantity: true,
      unitPrice: true,
      _count: { select: { assets: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

const serializeItem = (item: Record<string, any>, detail: boolean) => {
  const { _count, assets, ...safe } = item;
  return {
    ...safe,
    unitPrice: String(item.unitPrice),
    linkedAssetsCount: detail ? assets?.length ?? 0 : _count?.assets ?? 0,
    ...(detail ? { linkedAssets: assets ?? [] } : {}),
  };
};

const serializePurchase = (
  purchase: Record<string, any>,
  detail = false,
) => {
  const safe = { ...purchase };
  if (!detail) delete safe.notes;
  return {
    ...safe,
    justification:
      !detail && purchase.justification.length > 240
        ? `${purchase.justification.slice(0, 237)}...`
        : purchase.justification,
    totalAmount: String(purchase.totalAmount),
    exchangeRate:
      purchase.exchangeRate === null || purchase.exchangeRate === undefined
        ? null
        : String(purchase.exchangeRate),
    items: purchase.items.map((item: Record<string, any>) =>
      serializeItem(item, detail),
    ),
  };
};

const calculateTotal = (
  items: Array<{ quantity?: number; unitPrice?: string }>,
): Prisma.Decimal => {
  const total = items.reduce(
    (total, item) => {
      if (!item.quantity || item.unitPrice === undefined) {
        throw new ApiError(
          "PURCHASE_ITEM_INVALID",
          "Todos los ítems deben tener cantidad y precio",
          400,
        );
      }
      return total.plus(new Prisma.Decimal(item.unitPrice).mul(item.quantity));
    },
    new Prisma.Decimal(0),
  );
  if (total.gt(new Prisma.Decimal("999999999999.99"))) {
    throw new ApiError(
      "PURCHASE_TOTAL_TOO_LARGE",
      "El total excede el máximo permitido",
      400,
    );
  }
  return total;
};

const ensureStoredTotal = (purchase: {
  items: Array<{ quantity: number; unitPrice: Prisma.Decimal }>;
  totalAmount: Prisma.Decimal;
}) => {
  if (purchase.items.length === 0) {
    throw new ApiError(
      "PURCHASE_ITEMS_REQUIRED",
      "La compra debe tener al menos un ítem",
      409,
    );
  }
  const recalculated = calculateTotal(
    purchase.items.map((item) => ({
      quantity: item.quantity,
      unitPrice: item.unitPrice.toString(),
    })),
  );
  if (!recalculated.equals(purchase.totalAmount)) {
    throw new ApiError(
      "PURCHASE_TOTAL_INCONSISTENT",
      "El total almacenado no coincide con los ítems",
      409,
    );
  }
};

const normalizeItems = (items: Array<Record<string, any>>) =>
  items.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unitPrice: String(item.unitPrice),
  }));

const comparable = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (Array.isArray(value)) return JSON.stringify(normalizeItems(value));
  return JSON.stringify(value ?? null);
};

const redactedFields = new Set(["justification", "notes", "items"]);
const cancellationStart = "\n\n--- CANCELACIÓN ---\n";
const cancellationEnd = "--- FIN CANCELACIÓN ---";

const cancellationBlock = (reason: string) =>
  `${cancellationStart}Motivo: ${reason}\n${cancellationEnd}`;

const preserveCancellationBlock = (
  proposedNotes: string | null,
  currentNotes: string | null,
) => {
  const start = currentNotes?.lastIndexOf(cancellationStart) ?? -1;
  if (start < 0) return proposedNotes;
  const preserved = currentNotes!.slice(start);
  const base = proposedNotes?.trim() ?? "";
  const proposedStart = base.lastIndexOf(cancellationStart);
  const cleanBase =
    proposedStart >= 0 ? base.slice(0, proposedStart).trim() : base;
  return `${cleanBase}${preserved}`;
};

const buildAudit = (
  before: Record<string, any>,
  after: Record<string, any>,
) => {
  const fields: string[] = [];
  const changes: Record<string, unknown> = {};
  const auditable = [
    "supplierId",
    "currency",
    "exchangeRate",
    "justification",
    "invoiceNumber",
    "notes",
    "items",
    "totalAmount",
  ];
  for (const field of auditable) {
    if (comparable(before[field]) === comparable(after[field])) continue;
    fields.push(field);
    changes[field] = redactedFields.has(field)
      ? { changed: true, redacted: true }
      : {
          from:
            before[field] instanceof Prisma.Decimal
              ? before[field].toString()
              : before[field] ?? null,
          to:
            after[field] instanceof Prisma.Decimal
              ? after[field].toString()
              : after[field] ?? null,
        };
  }
  return { fields, changes };
};

const knownError = (
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
      });
    } catch (error) {
      if (!knownError(error, "P2034")) throw error;
      if (attempt === 2) {
        throw new ApiError(
          "PURCHASE_WRITE_CONFLICT",
          "La compra cambió mientras se procesaba la operación",
          409,
        );
      }
    }
  }
  throw new ApiError(
    "PURCHASE_WRITE_CONFLICT",
    "La compra cambió mientras se procesaba la operación",
    409,
  );
};

const findPurchase = async (tx: Prisma.TransactionClient, id: string) => {
  const purchase = await tx.purchase.findUnique({
    where: { id },
    select: purchaseInternalSelect,
  });
  if (!purchase) {
    throw new ApiError("PURCHASE_NOT_FOUND", "Compra no encontrada", 404);
  }
  return purchase;
};

const ensureVersion = (updatedAt: Date, expectedUpdatedAt: string) => {
  if (updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
    throw new ApiError(
      "PURCHASE_VERSION_CONFLICT",
      "La compra fue modificada por otro usuario",
      409,
    );
  }
};

const ensureActiveSupplier = async (
  tx: Prisma.TransactionClient,
  supplierId: string | null | undefined,
) => {
  if (!supplierId) return;
  const supplier = await tx.supplier.findFirst({
    where: { id: supplierId, isActive: true, deletedAt: null },
    select: { id: true },
  });
  if (!supplier) {
    throw new ApiError(
      "SUPPLIER_NOT_AVAILABLE",
      "El proveedor no existe o está inactivo",
      400,
    );
  }
};

export class PurchasesService {
  static async list(filters: PurchaseFilters) {
    const {
      q,
      status,
      supplierId,
      requestedById,
      currency,
      page,
      pageSize,
    } = filters;
    const where: Prisma.PurchaseWhereInput = {
      ...(status ? { status } : {}),
      ...(supplierId ? { supplierId } : {}),
      ...(requestedById ? { requestedById } : {}),
      ...(currency ? { currency } : {}),
    };
    if (q) {
      const numericText =
        /^OC-(\d+)$/i.exec(q)?.[1] ?? (/^\d+$/.test(q) ? q : null);
      const parsedNumber = numericText ? Number(numericText) : null;
      const purchaseNumber =
        parsedNumber !== null &&
        Number.isSafeInteger(parsedNumber) &&
        parsedNumber >= 1 &&
        parsedNumber <= 2_147_483_647
          ? parsedNumber
          : null;
      where.OR = [
        ...(purchaseNumber ? [{ purchaseNumber }] : []),
        { invoiceNumber: { contains: q, mode: "insensitive" } },
        { supplier: { is: { name: { contains: q, mode: "insensitive" } } } },
        { requestedBy: { is: { name: { contains: q, mode: "insensitive" } } } },
        { items: { some: { description: { contains: q, mode: "insensitive" } } } },
      ];
    }
    const [items, total] = await Promise.all([
      prisma.purchase.findMany({
        where,
        select: purchaseListSelect,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.purchase.count({ where }),
    ]);
    return {
      items: items.map((item) => serializePurchase(item)),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  static async getOne(id: string) {
    const purchase = await prisma.purchase.findUnique({
      where: { id },
      select: purchaseDetailSelect,
    });
    if (!purchase) {
      throw new ApiError("PURCHASE_NOT_FOUND", "Compra no encontrada", 404);
    }
    return serializePurchase(purchase, true);
  }

  static async lookups() {
    const suppliers = await prisma.supplier.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, name: true, categories: true },
      orderBy: { name: "asc" },
      take: 500,
    });
    return { suppliers };
  }

  static async create(data: CreatePurchaseRequest, actorId: string) {
    const purchase = await runSerializable(async (tx) => {
      await ensureActiveSupplier(tx, data.supplierId);
      const totalAmount = calculateTotal(data.items);
      const created = await tx.purchase.create({
        data: {
          supplierId: data.supplierId,
          currency: data.currency,
          totalAmount,
          exchangeRate:
            data.exchangeRate === undefined || data.exchangeRate === null
              ? null
              : new Prisma.Decimal(data.exchangeRate),
          justification: data.justification,
          invoiceNumber: data.invoiceNumber,
          notes: data.notes,
          requestedById: actorId,
          items: {
            create: data.items.map((item) => ({
              description: item.description,
              quantity: item.quantity,
              unitPrice: new Prisma.Decimal(item.unitPrice),
            })),
          },
        },
        select: purchaseDetailSelect,
      });
      await tx.auditLog.create({
        data: {
          entity: "purchase",
          entityId: created.id,
          action: "created",
          actorId,
          meta: {
            status: "REQUESTED",
            currency: data.currency,
            totalAmount: totalAmount.toString(),
            itemCount: data.items.length,
            supplierId: data.supplierId ?? null,
            justification: { redacted: true },
            notesProvided: Boolean(data.notes),
            items: { redacted: true },
          },
        },
      });
      return created;
    });
    logger.info({ purchaseId: purchase.id, actorId }, "Purchase created");
    return serializePurchase(purchase, true);
  }

  static async update(
    id: string,
    data: UpdatePurchaseRequest,
    actorId: string,
  ) {
    const { expectedUpdatedAt, ...changes } = data;
    const result = await runSerializable(async (tx) => {
      const current = await findPurchase(tx, id);
      ensureVersion(current.updatedAt, expectedUpdatedAt);

      if (
        current.status === PurchaseStatus.REQUESTED &&
        current.requestedById !== actorId
      ) {
        throw new ApiError(
          "PURCHASE_REQUESTER_EDIT_REQUIRED",
          "Solo quien solicitó la compra puede editarla antes de la aprobación",
          403,
        );
      }

      const requestedOnlyFields = [
        "supplierId",
        "currency",
        "exchangeRate",
        "justification",
        "items",
      ];
      const forbidden = requestedOnlyFields.filter(
        (field) => (changes as Record<string, unknown>)[field] !== undefined,
      );
      if (current.status !== PurchaseStatus.REQUESTED && forbidden.length > 0) {
        throw new ApiError(
          "PURCHASE_FIELDS_LOCKED",
          "Después de aprobar solo se pueden corregir factura y notas",
          409,
          { fields: forbidden },
        );
      }

      const nextCurrency = changes.currency ?? current.currency;
      const nextExchangeRate =
        changes.exchangeRate !== undefined
          ? changes.exchangeRate
          : current.exchangeRate;
      if (nextCurrency === Currency.ARS && nextExchangeRate !== null && nextExchangeRate !== undefined) {
        throw new ApiError(
          "PURCHASE_EXCHANGE_RATE_NOT_APPLICABLE",
          "La cotización solo corresponde a compras en USD",
          400,
        );
      }
      if (changes.supplierId !== undefined) {
        await ensureActiveSupplier(tx, changes.supplierId);
      }
      const nextItems = changes.items ?? normalizeItems(current.items);
      const totalAmount =
        changes.items !== undefined
          ? calculateTotal(changes.items)
          : current.totalAmount;
      const nextNotes =
        current.status === PurchaseStatus.CANCELLED &&
        changes.notes !== undefined
          ? preserveCancellationBlock(changes.notes, current.notes)
          : changes.notes;
      const candidate = {
        ...current,
        ...changes,
        ...(changes.notes !== undefined ? { notes: nextNotes } : {}),
        exchangeRate:
          changes.exchangeRate === undefined
            ? current.exchangeRate
            : changes.exchangeRate === null
              ? null
              : new Prisma.Decimal(changes.exchangeRate),
        items: nextItems,
        totalAmount,
      };
      const audit = buildAudit(current, candidate);
      if (audit.fields.length === 0) {
        const unchanged = await tx.purchase.findUnique({
          where: { id },
          select: purchaseDetailSelect,
        });
        if (!unchanged) {
          throw new ApiError("PURCHASE_NOT_FOUND", "Compra no encontrada", 404);
        }
        return { purchase: unchanged, changed: false };
      }

      const updateData: Prisma.PurchaseUncheckedUpdateManyInput = {
        ...(changes.supplierId !== undefined ? { supplierId: changes.supplierId } : {}),
        ...(changes.currency !== undefined ? { currency: changes.currency } : {}),
        ...(changes.exchangeRate !== undefined
          ? {
              exchangeRate:
                changes.exchangeRate === null
                  ? null
                  : new Prisma.Decimal(changes.exchangeRate),
            }
          : {}),
        ...(changes.justification !== undefined
          ? { justification: changes.justification }
          : {}),
        ...(changes.invoiceNumber !== undefined
          ? { invoiceNumber: changes.invoiceNumber }
          : {}),
        ...(changes.notes !== undefined ? { notes: nextNotes } : {}),
        ...(changes.items !== undefined ? { totalAmount } : {}),
      };
      const write = await tx.purchase.updateMany({
        where: {
          id,
          status: current.status,
          updatedAt: new Date(expectedUpdatedAt),
        },
        data: updateData,
      });
      if (write.count !== 1) {
        throw new ApiError(
          "PURCHASE_VERSION_CONFLICT",
          "La compra fue modificada por otro usuario",
          409,
        );
      }
      if (changes.items !== undefined) {
        if (current.items.some((item) => item._count.assets > 0)) {
          throw new ApiError(
            "PURCHASE_ITEMS_ALREADY_LINKED",
            "No se pueden reemplazar ítems que ya tienen activos vinculados",
            409,
          );
        }
        await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });
        await tx.purchaseItem.createMany({
          data: changes.items.map((item) => ({
            purchaseId: id,
            description: item.description,
            quantity: item.quantity,
            unitPrice: new Prisma.Decimal(item.unitPrice),
          })),
        });
      }
      const updated = await tx.purchase.findUnique({
        where: { id },
        select: purchaseDetailSelect,
      });
      if (!updated) {
        throw new ApiError("PURCHASE_NOT_FOUND", "Compra no encontrada", 404);
      }
      await tx.auditLog.create({
        data: {
          entity: "purchase",
          entityId: id,
          action: "updated",
          actorId,
          meta: audit as Prisma.InputJsonValue,
        },
      });
      return { purchase: updated, changed: true };
    });
    logger.info(
      { purchaseId: id, actorId, changed: result.changed },
      result.changed ? "Purchase updated" : "Purchase update skipped",
    );
    return serializePurchase(result.purchase, true);
  }

  private static async transition(
    id: string,
    data: PurchaseTransitionRequest,
    actorId: string,
    expectedStatus: PurchaseStatus,
    nextStatus: PurchaseStatus,
    extra: Prisma.PurchaseUncheckedUpdateManyInput,
  ) {
    const purchase = await runSerializable(async (tx) => {
      const current = await findPurchase(tx, id);
      ensureVersion(current.updatedAt, data.expectedUpdatedAt);
      if (current.status === PurchaseStatus.CANCELLED || current.status === PurchaseStatus.RECEIVED) {
        throw new ApiError(
          "PURCHASE_TERMINAL",
          "Una compra recibida o cancelada no puede reabrirse",
          409,
        );
      }
      if (current.status !== expectedStatus) {
        throw new ApiError(
          "PURCHASE_INVALID_TRANSITION",
          `La compra debe estar en estado ${expectedStatus}`,
          409,
          { currentStatus: current.status, expectedStatus },
        );
      }
      if (
        nextStatus === PurchaseStatus.APPROVED ||
        nextStatus === PurchaseStatus.ORDERED
      ) {
        if (!current.supplierId) {
          throw new ApiError(
            "PURCHASE_SUPPLIER_REQUIRED",
            "Debe seleccionar un proveedor antes de aprobar",
            400,
          );
        }
        await ensureActiveSupplier(tx, current.supplierId);
      }
      const write = await tx.purchase.updateMany({
        where: {
          id,
          status: expectedStatus,
          updatedAt: new Date(data.expectedUpdatedAt),
        },
        data: { status: nextStatus, ...extra },
      });
      if (write.count !== 1) {
        throw new ApiError(
          "PURCHASE_VERSION_CONFLICT",
          "La compra fue modificada por otro usuario",
          409,
        );
      }
      const updated = await tx.purchase.findUnique({
        where: { id },
        select: purchaseDetailSelect,
      });
      if (!updated) {
        throw new ApiError("PURCHASE_NOT_FOUND", "Compra no encontrada", 404);
      }
      await tx.auditLog.create({
        data: {
          entity: "purchase",
          entityId: id,
          action: nextStatus.toLowerCase(),
          actorId,
          meta: {
            fromStatus: expectedStatus,
            toStatus: nextStatus,
            totalAmount: current.totalAmount.toString(),
            currency: current.currency,
          },
        },
      });
      return updated;
    });
    logger.info(
      { purchaseId: id, actorId, status: nextStatus },
      "Purchase transitioned",
    );
    return serializePurchase(purchase, true);
  }

  static async approve(
    id: string,
    data: PurchaseTransitionRequest,
    actorId: string,
  ) {
    const purchase = await runSerializable(async (tx) => {
      const current = await findPurchase(tx, id);
      ensureVersion(current.updatedAt, data.expectedUpdatedAt);
      if (current.status === PurchaseStatus.CANCELLED || current.status === PurchaseStatus.RECEIVED) {
        throw new ApiError(
          "PURCHASE_TERMINAL",
          "Una compra recibida o cancelada no puede reabrirse",
          409,
        );
      }
      if (current.status !== PurchaseStatus.REQUESTED) {
        throw new ApiError(
          "PURCHASE_INVALID_TRANSITION",
          "La compra debe estar en estado REQUESTED",
          409,
          { currentStatus: current.status, expectedStatus: "REQUESTED" },
        );
      }
      const actor = await tx.user.findFirst({
        where: {
          id: actorId,
          role: UserRole.ADMIN,
          isActive: true,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!actor) {
        throw new ApiError(
          "FORBIDDEN",
          "Se requiere una cuenta ADMIN activa para autorizar",
          403,
        );
      }
      if (current.requestedById === actorId) {
        throw new ApiError(
          "PURCHASE_SELF_APPROVAL_FORBIDDEN",
          "Quien solicita una compra no puede autorizarla",
          403,
        );
      }
      if (!current.supplierId) {
        throw new ApiError(
          "PURCHASE_SUPPLIER_REQUIRED",
          "Debe seleccionar un proveedor antes de aprobar",
          400,
        );
      }
      await ensureActiveSupplier(tx, current.supplierId);
      ensureStoredTotal(current);
      const now = new Date();
      const write = await tx.purchase.updateMany({
        where: {
          id,
          status: PurchaseStatus.REQUESTED,
          updatedAt: new Date(data.expectedUpdatedAt),
        },
        data: {
          status: PurchaseStatus.APPROVED,
          authorizedById: actorId,
          authorizedAt: now,
        },
      });
      if (write.count !== 1) {
        throw new ApiError(
          "PURCHASE_VERSION_CONFLICT",
          "La compra fue modificada por otro usuario",
          409,
        );
      }
      const updated = await tx.purchase.findUnique({
        where: { id },
        select: purchaseDetailSelect,
      });
      if (!updated) {
        throw new ApiError("PURCHASE_NOT_FOUND", "Compra no encontrada", 404);
      }
      await tx.auditLog.create({
        data: {
          entity: "purchase",
          entityId: id,
          action: "approved",
          actorId,
          meta: {
            fromStatus: "REQUESTED",
            toStatus: "APPROVED",
            totalAmount: current.totalAmount.toString(),
            currency: current.currency,
          },
        },
      });
      return updated;
    });
    logger.info({ purchaseId: id, actorId }, "Purchase approved");
    return serializePurchase(purchase, true);
  }

  static async order(
    id: string,
    data: PurchaseTransitionRequest,
    actorId: string,
  ) {
    return this.transition(
      id,
      data,
      actorId,
      PurchaseStatus.APPROVED,
      PurchaseStatus.ORDERED,
      { orderedAt: new Date() },
    );
  }

  static async receive(
    id: string,
    data: PurchaseTransitionRequest,
    actorId: string,
  ) {
    return this.transition(
      id,
      data,
      actorId,
      PurchaseStatus.ORDERED,
      PurchaseStatus.RECEIVED,
      { receivedAt: new Date() },
    );
  }

  static async cancel(
    id: string,
    data: CancelPurchaseRequest,
    actorId: string,
    actorRole: UserRole,
  ) {
    const purchase = await runSerializable(async (tx) => {
      const current = await findPurchase(tx, id);
      ensureVersion(current.updatedAt, data.expectedUpdatedAt);
      if (current.status === PurchaseStatus.CANCELLED || current.status === PurchaseStatus.RECEIVED) {
        throw new ApiError(
          "PURCHASE_TERMINAL",
          "Una compra recibida o cancelada no puede cambiar de estado",
          409,
        );
      }
      if (current.status !== PurchaseStatus.REQUESTED && actorRole !== UserRole.ADMIN) {
        throw new ApiError(
          "FORBIDDEN",
          "Solo ADMIN puede cancelar una compra ya aprobada",
          403,
        );
      }
      if (current.status !== PurchaseStatus.REQUESTED) {
        const actor = await tx.user.findFirst({
          where: {
            id: actorId,
            role: UserRole.ADMIN,
            isActive: true,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!actor) {
          throw new ApiError(
            "FORBIDDEN",
            "Se requiere una cuenta ADMIN activa para cancelar esta compra",
            403,
          );
        }
      }
      const notes = `${current.notes?.trim() ?? ""}${cancellationBlock(data.reason)}`;
      const write = await tx.purchase.updateMany({
        where: {
          id,
          status: current.status,
          updatedAt: new Date(data.expectedUpdatedAt),
        },
        data: { status: PurchaseStatus.CANCELLED, notes },
      });
      if (write.count !== 1) {
        throw new ApiError(
          "PURCHASE_VERSION_CONFLICT",
          "La compra fue modificada por otro usuario",
          409,
        );
      }
      const updated = await tx.purchase.findUnique({
        where: { id },
        select: purchaseDetailSelect,
      });
      if (!updated) {
        throw new ApiError("PURCHASE_NOT_FOUND", "Compra no encontrada", 404);
      }
      await tx.auditLog.create({
        data: {
          entity: "purchase",
          entityId: id,
          action: "cancelled",
          actorId,
          meta: {
            fromStatus: current.status,
            toStatus: "CANCELLED",
            totalAmount: current.totalAmount.toString(),
            currency: current.currency,
            reason: { redacted: true },
            notes: { changed: true, redacted: true },
          },
        },
      });
      return updated;
    });
    logger.info({ purchaseId: id, actorId }, "Purchase cancelled");
    return serializePurchase(purchase, true);
  }
}

export default PurchasesService;
