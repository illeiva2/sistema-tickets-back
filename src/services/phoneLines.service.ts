import {
  Currency,
  PhoneCarrier,
  PhoneLineStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import type {
  AssignPhoneLineRequest,
  CreatePhoneLineRequest,
  CreateSimChangeRequest,
  DeletePhoneLineRequest,
  PhoneLineFilters,
  ReturnPhoneLineRequest,
  SimChangeFilters,
  UpdatePhoneLineRequest,
} from "../validations/phoneLines";

const actorSelect = { id: true, name: true, email: true } as const;

const personPreviewSelect = {
  id: true,
  employeeNumber: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  workEmail: true,
  workPhone: true,
  status: true,
  departmentId: true,
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
  updatedAt: true,
} as const;

// Select explícito de todos los escalares públicos. Deliberadamente no
// contiene pukCipherText, pukIv, pukAuthTag ni pukKeyVersion.
const phoneLineSafeScalarSelect = {
  id: true,
  phoneNumber: true,
  carrier: true,
  carrierOther: true,
  planName: true,
  dataAllowanceGb: true,
  monthlyCost: true,
  currency: true,
  simIccid: true,
  status: true,
  contractEndsAt: true,
  notes: true,
  holderId: true,
  assetId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const phoneLineListScalarSelect = {
  id: true,
  phoneNumber: true,
  carrier: true,
  carrierOther: true,
  planName: true,
  dataAllowanceGb: true,
  monthlyCost: true,
  currency: true,
  simIccid: true,
  status: true,
  contractEndsAt: true,
  holderId: true,
  assetId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const phoneLineListSelect = {
  ...phoneLineListScalarSelect,
  holder: { select: personPreviewSelect },
  asset: { select: assetPreviewSelect },
  _count: { select: { assignments: true, simChanges: true } },
} as const;

const assignmentSelect = {
  id: true,
  phoneLineId: true,
  personId: true,
  assetId: true,
  assignedAt: true,
  returnedAt: true,
  note: true,
  returnNote: true,
  createdAt: true,
  updatedAt: true,
  person: { select: personPreviewSelect },
  asset: { select: assetPreviewSelect },
  assignedBy: { select: actorSelect },
} as const;

const simChangeSelect = {
  id: true,
  phoneLineId: true,
  previousIccid: true,
  newIccid: true,
  changedAt: true,
  reason: true,
  notes: true,
  createdAt: true,
  changedBy: { select: actorSelect },
} as const;

const phoneLineDetailSelect = {
  ...phoneLineSafeScalarSelect,
  holder: { select: personPreviewSelect },
  asset: { select: assetPreviewSelect },
  assignments: {
    select: assignmentSelect,
    orderBy: { assignedAt: "desc" as const },
    take: 50,
  },
  simChanges: {
    select: simChangeSelect,
    orderBy: [{ changedAt: "desc" as const }, { createdAt: "desc" as const }],
    take: 20,
  },
} satisfies Prisma.PhoneLineSelect;

const auditableFields = [
  "phoneNumber",
  "carrier",
  "carrierOther",
  "planName",
  "dataAllowanceGb",
  "monthlyCost",
  "currency",
  "simIccid",
  "status",
  "contractEndsAt",
  "notes",
] as const;

const redactedAuditFields = new Set(["phoneNumber", "simIccid", "notes"]);

type PhoneLineAuditPayload = {
  fields: string[];
  changes: Record<string, Prisma.InputJsonValue>;
};

const normalizeComparable = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value === undefined) return null;
  return value;
};

const valuesEqual = (left: unknown, right: unknown) =>
  normalizeComparable(left) === normalizeComparable(right);

const toAuditScalar = (value: unknown): string | number | boolean | null => {
  const normalized = normalizeComparable(value);
  if (normalized === null) return null;
  if (
    typeof normalized === "string" ||
    typeof normalized === "number" ||
    typeof normalized === "boolean"
  ) {
    return normalized;
  }
  return null;
};

const buildAudit = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): PhoneLineAuditPayload => {
  const fields: string[] = [];
  const changes: Record<string, Prisma.InputJsonValue> = {};
  for (const field of auditableFields) {
    if (valuesEqual(before[field], after[field])) continue;
    fields.push(field);
    changes[field] = redactedAuditFields.has(field)
      ? { changed: true, redacted: true }
      : { from: toAuditScalar(before[field]), to: toAuditScalar(after[field]) };
  }
  return { fields, changes };
};

const isKnownPrismaError = (
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;

const uniqueTargetIncludes = (error: unknown, field: string): boolean => {
  if (!isKnownPrismaError(error, "P2002")) return false;
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === "string" && target.includes(field);
};

const translateWriteError = (error: unknown): never => {
  if (uniqueTargetIncludes(error, "phoneNumber")) {
    throw new ApiError(
      "PHONE_LINE_NUMBER_EXISTS",
      "Ya existe una línea con ese número",
      409,
    );
  }
  if (
    uniqueTargetIncludes(error, "simIccid") ||
    uniqueTargetIncludes(error, "newIccid")
  ) {
    throw new ApiError(
      "PHONE_LINE_ICCID_EXISTS",
      "Ese ICCID ya está registrado en otra línea",
      409,
    );
  }
  if (
    isKnownPrismaError(error, "P2002") &&
    (String(error.meta?.target || "").includes("one_open_per_line") ||
      uniqueTargetIncludes(error, "phoneLineId"))
  ) {
    throw new ApiError(
      "PHONE_LINE_ASSIGNMENT_CONFLICT",
      "La línea ya tiene una asignación vigente",
      409,
    );
  }
  if (isKnownPrismaError(error, "P2003")) {
    throw new ApiError(
      "PHONE_LINE_REFERENCE_INVALID",
      "La persona, el activo o el operador indicado ya no existe",
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
      if (!isKnownPrismaError(error, "P2034")) throw error;
      if (attempt === 2) {
        throw new ApiError(
          "PHONE_LINE_WRITE_CONFLICT",
          "La línea cambió mientras se procesaba la operación",
          409,
        );
      }
    }
  }
  throw new ApiError(
    "PHONE_LINE_WRITE_CONFLICT",
    "La línea cambió mientras se procesaba la operación",
    409,
  );
};

const parseNullableDate = (
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
    throw new ApiError("PHONE_LINE_DATE_INVALID", "Fecha inválida", 400);
  }
  return parsed;
};

const ensureCarrierCoherence = (carrier: PhoneCarrier, carrierOther: string | null) => {
  if (carrier === PhoneCarrier.OTHER && !carrierOther) {
    throw new ApiError(
      "PHONE_LINE_CARRIER_OTHER_REQUIRED",
      "Indicá el nombre de la operadora",
      400,
    );
  }
  if (carrier !== PhoneCarrier.OTHER && carrierOther) {
    throw new ApiError(
      "PHONE_LINE_CARRIER_OTHER_INVALID",
      "carrierOther sólo corresponde a la operadora OTHER",
      400,
    );
  }
};

const findCurrent = async (tx: Prisma.TransactionClient, id: string) => {
  const line = await tx.phoneLine.findFirst({
    where: { id, isActive: true, deletedAt: null },
    select: phoneLineSafeScalarSelect,
  });
  if (!line) {
    throw new ApiError("PHONE_LINE_NOT_FOUND", "Línea no encontrada", 404);
  }
  return line;
};

const ensureExpectedVersion = (
  currentUpdatedAt: Date,
  expectedUpdatedAt: string,
) => {
  if (currentUpdatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
    throw new ApiError(
      "PHONE_LINE_VERSION_CONFLICT",
      "La línea fue modificada por otro usuario",
      409,
    );
  }
};

const findDetail = async (tx: Prisma.TransactionClient, id: string) => {
  const line = await tx.phoneLine.findFirst({
    where: { id, isActive: true, deletedAt: null },
    select: phoneLineDetailSelect,
  });
  if (!line) {
    throw new ApiError("PHONE_LINE_NOT_FOUND", "Línea no encontrada", 404);
  }
  return line;
};

export class PhoneLinesService {
  static async list(filters: PhoneLineFilters) {
    const { q, status, carrier, holderId, assetId, page, pageSize } = filters;
    const where: Prisma.PhoneLineWhereInput = {
      isActive: true,
      deletedAt: null,
      ...(status ? { status } : {}),
      ...(carrier ? { carrier } : {}),
      ...(holderId ? { holderId } : {}),
      ...(assetId ? { assetId } : {}),
      ...(q
        ? {
            OR: [
              { phoneNumber: { contains: q, mode: "insensitive" as const } },
              { planName: { contains: q, mode: "insensitive" as const } },
              { carrierOther: { contains: q, mode: "insensitive" as const } },
              { simIccid: { contains: q, mode: "insensitive" as const } },
              {
                holder: {
                  is: {
                    OR: [
                      { firstName: { contains: q, mode: "insensitive" as const } },
                      { lastName: { contains: q, mode: "insensitive" as const } },
                      { employeeNumber: { contains: q, mode: "insensitive" as const } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await prisma.$transaction([
      prisma.phoneLine.findMany({
        where,
        select: phoneLineListSelect,
        orderBy: [{ status: "asc" }, { phoneNumber: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.phoneLine.count({ where }),
    ]);

    const items = rows.map(({ _count, ...line }) => ({
      ...line,
      assignmentsCount: _count.assignments,
      simChangesCount: _count.simChanges,
    }));
    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      },
    };
  }

  static async getOne(id: string) {
    const line = await prisma.phoneLine.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: phoneLineDetailSelect,
    });
    if (!line) {
      throw new ApiError("PHONE_LINE_NOT_FOUND", "Línea no encontrada", 404);
    }
    return line;
  }

  static async create(data: CreatePhoneLineRequest, actorId: string) {
    ensureCarrierCoherence(
      data.carrier as PhoneCarrier,
      data.carrierOther ?? null,
    );
    try {
      const result = await runSerializable(async (tx) => {
        const existing = await tx.phoneLine.findUnique({
          where: { phoneNumber: data.phoneNumber },
          select: { ...phoneLineSafeScalarSelect, deletedAt: true },
        });
        const writeData: Prisma.PhoneLineUncheckedCreateInput = {
          phoneNumber: data.phoneNumber,
          carrier: data.carrier as PhoneCarrier,
          carrierOther: data.carrierOther,
          planName: data.planName,
          dataAllowanceGb: data.dataAllowanceGb,
          monthlyCost: data.monthlyCost,
          currency: data.currency as Currency,
          simIccid: data.simIccid,
          status: data.status as PhoneLineStatus,
          contractEndsAt: parseNullableDate(data.contractEndsAt),
          notes: data.notes,
        };

        if (existing) {
          if (
            existing.status !== PhoneLineStatus.CANCELLED ||
            existing.isActive ||
            !existing.deletedAt
          ) {
            throw new ApiError(
              "PHONE_LINE_NUMBER_EXISTS",
              "Ya existe una línea con ese número",
              409,
            );
          }
          const openAssignment = await tx.phoneLineAssignment.findFirst({
            where: { phoneLineId: existing.id, returnedAt: null },
            select: { id: true },
          });
          if (openAssignment) {
            throw new ApiError(
              "PHONE_LINE_ASSIGNMENT_CONFLICT",
              "La línea dada de baja conserva una asignación vigente",
              409,
            );
          }
          const reactivated = await tx.phoneLine.update({
            where: { id: existing.id },
            data: {
              ...writeData,
              isActive: true,
              deletedAt: null,
              holderId: null,
              assetId: null,
              pukCipherText: null,
              pukIv: null,
              pukAuthTag: null,
            },
            select: phoneLineDetailSelect,
          });
          await tx.auditLog.create({
            data: {
              entity: "phone_line",
              entityId: existing.id,
              action: "reactivated",
              actorId,
              meta: {
                ...buildAudit(
                  existing as unknown as Record<string, unknown>,
                  reactivated as unknown as Record<string, unknown>,
                ),
                fieldsAdditionallyChanged: [
                  "isActive",
                  "deletedAt",
                  "holderId",
                  "assetId",
                  "puk",
                ],
                pukCleared: true,
              },
            },
          });
          return { line: reactivated, reactivated: true };
        }

        const created = await tx.phoneLine.create({
          data: writeData,
          select: phoneLineDetailSelect,
        });
        await tx.auditLog.create({
          data: {
            entity: "phone_line",
            entityId: created.id,
            action: "created",
            actorId,
            meta: buildAudit({}, created as unknown as Record<string, unknown>),
          },
        });
        return { line: created, reactivated: false };
      });
      logger.info(
        { phoneLineId: result.line.id, actorId, reactivated: result.reactivated },
        result.reactivated ? "Phone line reactivated" : "Phone line created",
      );
      return result.line;
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async update(
    id: string,
    data: UpdatePhoneLineRequest,
    actorId: string,
  ) {
    const { expectedUpdatedAt, ...changes } = data;
    const expected = new Date(expectedUpdatedAt);
    try {
      const result = await runSerializable(async (tx) => {
        const current = await findCurrent(tx, id);
        if (current.updatedAt.getTime() !== expected.getTime()) {
          throw new ApiError(
            "PHONE_LINE_VERSION_CONFLICT",
            "La línea fue modificada por otro usuario",
            409,
          );
        }

        if (
          Object.prototype.hasOwnProperty.call(changes, "simIccid") &&
          changes.simIccid !== current.simIccid
        ) {
          throw new ApiError(
            "PHONE_LINE_SIM_CHANGE_REQUIRED",
            "Usá el registro de cambio de chip para modificar el ICCID",
            409,
          );
        }
        if (
          current.holderId &&
          changes.status !== undefined &&
          changes.status !== PhoneLineStatus.ACTIVE
        ) {
          throw new ApiError(
            "PHONE_LINE_STATUS_MANAGED",
            "Devolvé la línea antes de cambiar su estado",
            409,
          );
        }
        if (
          !current.holderId &&
          changes.status === PhoneLineStatus.ACTIVE
        ) {
          throw new ApiError(
            "PHONE_LINE_STATUS_MANAGED",
            "Usá el endpoint de asignación para activar una línea",
            409,
          );
        }

        const candidate: Record<string, unknown> = {
          ...current,
          ...changes,
          contractEndsAt: Object.prototype.hasOwnProperty.call(changes, "contractEndsAt")
            ? parseNullableDate(changes.contractEndsAt)
            : current.contractEndsAt,
        };
        if (
          Object.prototype.hasOwnProperty.call(changes, "monthlyCost") &&
          changes.monthlyCost !== null &&
          changes.monthlyCost !== undefined
        ) {
          candidate.monthlyCost = new Prisma.Decimal(changes.monthlyCost);
        }
        const candidateCarrier = candidate.carrier as PhoneCarrier;
        let candidateCarrierOther = (candidate.carrierOther ?? null) as string | null;
        if (
          candidateCarrier !== PhoneCarrier.OTHER &&
          Object.prototype.hasOwnProperty.call(changes, "carrierOther") &&
          changes.carrierOther
        ) {
          throw new ApiError(
            "PHONE_LINE_CARRIER_OTHER_INVALID",
            "carrierOther sólo corresponde a la operadora OTHER",
            400,
          );
        }
        if (candidateCarrier !== PhoneCarrier.OTHER) candidateCarrierOther = null;
        candidate.carrierOther = candidateCarrierOther;
        ensureCarrierCoherence(candidateCarrier, candidateCarrierOther);

        const audit = buildAudit(
          current as unknown as Record<string, unknown>,
          candidate,
        );
        if (audit.fields.length === 0) {
          return { line: await findDetail(tx, id), changed: false };
        }

        const updateData: Prisma.PhoneLineUncheckedUpdateInput = {};
        const fields = new Set(audit.fields);
        if (fields.has("phoneNumber")) updateData.phoneNumber = candidate.phoneNumber as string;
        if (fields.has("carrier")) updateData.carrier = candidateCarrier;
        if (fields.has("carrierOther")) updateData.carrierOther = candidateCarrierOther;
        if (fields.has("planName")) updateData.planName = candidate.planName as string | null;
        if (fields.has("dataAllowanceGb")) updateData.dataAllowanceGb = candidate.dataAllowanceGb as number | null;
        if (fields.has("monthlyCost")) updateData.monthlyCost = candidate.monthlyCost as string | null;
        if (fields.has("currency")) updateData.currency = candidate.currency as Currency;
        if (fields.has("status")) updateData.status = candidate.status as PhoneLineStatus;
        if (fields.has("contractEndsAt")) updateData.contractEndsAt = candidate.contractEndsAt as Date | null;
        if (fields.has("notes")) updateData.notes = candidate.notes as string | null;

        const write = await tx.phoneLine.updateMany({
          where: { id, isActive: true, deletedAt: null, updatedAt: expected },
          data: updateData,
        });
        if (write.count !== 1) {
          throw new ApiError(
            "PHONE_LINE_VERSION_CONFLICT",
            "La línea fue modificada por otro usuario",
            409,
          );
        }
        const updated = await findDetail(tx, id);
        await tx.auditLog.create({
          data: {
            entity: "phone_line",
            entityId: id,
            action: "updated",
            actorId,
            meta: audit,
          },
        });
        return { line: updated, changed: true };
      });
      logger.info(
        { phoneLineId: id, actorId, changed: result.changed },
        result.changed ? "Phone line updated" : "Phone line update skipped",
      );
      return result.line;
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async delete(
    id: string,
    data: DeletePhoneLineRequest,
    actorId: string,
  ) {
    const expected = new Date(data.expectedUpdatedAt);
    try {
      const result = await runSerializable(async (tx) => {
        const current = await findCurrent(tx, id);
        if (current.updatedAt.getTime() !== expected.getTime()) {
          throw new ApiError(
            "PHONE_LINE_VERSION_CONFLICT",
            "La línea fue modificada por otro usuario",
            409,
          );
        }
        const openAssignment = await tx.phoneLineAssignment.findFirst({
          where: { phoneLineId: id, returnedAt: null },
          select: { id: true },
        });
        if (current.holderId || openAssignment) {
          throw new ApiError(
            "PHONE_LINE_ASSIGNED",
            "Devolvé la línea antes de eliminarla",
            409,
          );
        }
        const deletedAt = new Date();
        const write = await tx.phoneLine.updateMany({
          where: { id, isActive: true, deletedAt: null, updatedAt: expected },
          data: {
            isActive: false,
            deletedAt,
            status: PhoneLineStatus.CANCELLED,
            holderId: null,
            assetId: null,
            pukCipherText: null,
            pukIv: null,
            pukAuthTag: null,
          },
        });
        if (write.count !== 1) {
          throw new ApiError(
            "PHONE_LINE_VERSION_CONFLICT",
            "La línea fue modificada por otro usuario",
            409,
          );
        }
        await tx.auditLog.create({
          data: {
            entity: "phone_line",
            entityId: id,
            action: "deleted",
            actorId,
            meta: {
              fields: ["isActive", "deletedAt", "status", "assetId"],
              phoneNumberRedacted: true,
              hadSimIccid: Boolean(current.simIccid),
            },
          },
        });
        return { id, deleted: true as const };
      });
      logger.info({ phoneLineId: id, actorId }, "Phone line deleted");
      return result;
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async assign(
    id: string,
    data: AssignPhoneLineRequest,
    actorId: string,
  ) {
    try {
      const line = await runSerializable(async (tx) => {
        const current = await findCurrent(tx, id);
        ensureExpectedVersion(current.updatedAt, data.expectedUpdatedAt);
        if (current.status !== PhoneLineStatus.AVAILABLE) {
          throw new ApiError(
            "PHONE_LINE_NOT_AVAILABLE",
            "La línea debe estar disponible antes de asignarla",
            409,
          );
        }
        const openAssignment = await tx.phoneLineAssignment.findFirst({
          where: { phoneLineId: id, returnedAt: null },
          select: { id: true },
        });
        if (current.holderId || openAssignment) {
          throw new ApiError(
            "PHONE_LINE_ALREADY_ASSIGNED",
            "La línea ya está asignada; devolvela antes de reasignarla",
            409,
          );
        }

        const person = await tx.person.findFirst({
          where: {
            id: data.personId,
            isActive: true,
            deletedAt: null,
            status: "ACTIVE",
          },
          select: { id: true },
        });
        if (!person) {
          throw new ApiError(
            "PHONE_LINE_PERSON_NOT_AVAILABLE",
            "La persona no existe o no está activa",
            409,
          );
        }

        if (data.assetId) {
          const asset = await tx.asset.findFirst({
            where: {
              id: data.assetId,
              isActive: true,
              deletedAt: null,
              type: "PHONE",
              status: { notIn: ["IN_REPAIR", "RETIRED", "LOST"] },
            },
            select: { id: true, assignedPersonId: true },
          });
          if (!asset) {
            throw new ApiError(
              "PHONE_LINE_ASSET_NOT_AVAILABLE",
              "El activo no existe o no es un celular disponible",
              409,
            );
          }
          if (asset.assignedPersonId && asset.assignedPersonId !== data.personId) {
            throw new ApiError(
              "PHONE_LINE_ASSET_PERSON_MISMATCH",
              "El activo está asignado a otra persona",
              409,
            );
          }
          const lineUsingAsset = await tx.phoneLine.findFirst({
            where: {
              id: { not: id },
              assetId: data.assetId,
              holderId: { not: null },
              isActive: true,
              deletedAt: null,
            },
            select: { id: true },
          });
          if (lineUsingAsset) {
            throw new ApiError(
              "PHONE_LINE_ASSET_IN_USE",
              "El activo ya porta otra línea asignada",
              409,
            );
          }
        }

        const assignment = await tx.phoneLineAssignment.create({
          data: {
            phoneLineId: id,
            personId: data.personId,
            assetId: data.assetId ?? null,
            assignedById: actorId,
            note: data.note,
          },
          select: { id: true },
        });
        await tx.phoneLine.update({
          where: { id },
          data: {
            holderId: data.personId,
            assetId: data.assetId ?? null,
            status: PhoneLineStatus.ACTIVE,
          },
        });
        await tx.auditLog.create({
          data: {
            entity: "phone_line",
            entityId: id,
            action: "assigned",
            actorId,
            meta: {
              assignmentId: assignment.id,
              personId: data.personId,
              assetId: data.assetId ?? null,
              fields: ["holderId", "assetId", "status", "assignedAt", "note"],
              noteRedacted: Boolean(data.note),
            },
          },
        });
        return findDetail(tx, id);
      });
      logger.info({ phoneLineId: id, actorId }, "Phone line assigned");
      return line;
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async returnLine(
    id: string,
    data: ReturnPhoneLineRequest,
    actorId: string,
  ) {
    try {
      const line = await runSerializable(async (tx) => {
        const current = await findCurrent(tx, id);
        ensureExpectedVersion(current.updatedAt, data.expectedUpdatedAt);
        const assignment = await tx.phoneLineAssignment.findFirst({
          where: { phoneLineId: id, returnedAt: null },
          orderBy: { assignedAt: "desc" },
          select: { id: true, personId: true, assetId: true },
        });
        if (!assignment || !current.holderId) {
          throw new ApiError(
            "PHONE_LINE_NOT_ASSIGNED",
            "La línea no tiene una asignación vigente",
            409,
          );
        }
        const returnedAt = new Date();
        const closed = await tx.phoneLineAssignment.updateMany({
          where: { id: assignment.id, returnedAt: null },
          data: { returnedAt, returnNote: data.returnNote },
        });
        if (closed.count !== 1) {
          throw new ApiError(
            "PHONE_LINE_ASSIGNMENT_CONFLICT",
            "La asignación ya había sido devuelta",
            409,
          );
        }
        await tx.phoneLine.update({
          where: { id },
          data: {
            holderId: null,
            assetId: null,
            status: PhoneLineStatus.AVAILABLE,
          },
        });
        await tx.auditLog.create({
          data: {
            entity: "phone_line",
            entityId: id,
            action: "returned",
            actorId,
            meta: {
              assignmentId: assignment.id,
              personId: assignment.personId,
              assetId: assignment.assetId,
              fields: ["holderId", "assetId", "status", "returnedAt", "returnNote"],
              returnNoteRedacted: Boolean(data.returnNote),
            },
          },
        });
        return findDetail(tx, id);
      });
      logger.info({ phoneLineId: id, actorId }, "Phone line returned");
      return line;
    } catch (error) {
      translateWriteError(error);
    }
  }

  static async listSimChanges(id: string, filters: SimChangeFilters) {
    const exists = await prisma.phoneLine.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!exists) {
      throw new ApiError("PHONE_LINE_NOT_FOUND", "Línea no encontrada", 404);
    }
    const { page, pageSize } = filters;
    const where: Prisma.PhoneLineSimChangeWhereInput = { phoneLineId: id };
    const [items, total] = await prisma.$transaction([
      prisma.phoneLineSimChange.findMany({
        where,
        select: simChangeSelect,
        orderBy: [{ changedAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.phoneLineSimChange.count({ where }),
    ]);
    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      },
    };
  }

  static async createSimChange(
    id: string,
    data: CreateSimChangeRequest,
    actorId: string,
  ) {
    try {
      const result = await runSerializable(async (tx) => {
        const current = await findCurrent(tx, id);
        ensureExpectedVersion(current.updatedAt, data.expectedUpdatedAt);
        if (current.simIccid === data.newIccid) {
          throw new ApiError(
            "PHONE_LINE_SIM_UNCHANGED",
            "El nuevo ICCID coincide con el actual",
            409,
          );
        }
        const changedAt = data.changedAt ? new Date(data.changedAt) : new Date();
        if (changedAt.getTime() > Date.now() + 5 * 60 * 1000) {
          throw new ApiError(
            "PHONE_LINE_SIM_DATE_IN_FUTURE",
            "La fecha del cambio de chip no puede estar en el futuro",
            400,
          );
        }
        const latestChange = await tx.phoneLineSimChange.findFirst({
          where: { phoneLineId: id },
          orderBy: [{ changedAt: "desc" }, { createdAt: "desc" }],
          select: { changedAt: true },
        });
        if (latestChange && changedAt.getTime() < latestChange.changedAt.getTime()) {
          throw new ApiError(
            "PHONE_LINE_SIM_DATE_OUT_OF_ORDER",
            "La fecha del cambio no puede ser anterior al último cambio registrado",
            409,
          );
        }
        const collision = await tx.phoneLine.findFirst({
          where: {
            id: { not: id },
            simIccid: data.newIccid,
          },
          select: { id: true },
        });
        if (collision) {
          throw new ApiError(
            "PHONE_LINE_ICCID_EXISTS",
            "Ese ICCID ya está registrado en otra línea",
            409,
          );
        }
        const change = await tx.phoneLineSimChange.create({
          data: {
            phoneLineId: id,
            previousIccid: current.simIccid,
            newIccid: data.newIccid,
            changedAt,
            reason: data.reason,
            notes: data.notes,
            changedById: actorId,
          },
          select: simChangeSelect,
        });
        await tx.phoneLine.update({
          where: { id },
          data: { simIccid: data.newIccid },
        });
        await tx.auditLog.create({
          data: {
            entity: "phone_line",
            entityId: id,
            action: "sim_swapped",
            actorId,
            meta: {
              simChangeId: change.id,
              fields: ["simIccid", "changedAt", "reason", "notes"],
              previousIccidRedacted: Boolean(current.simIccid),
              newIccidRedacted: true,
              changedAt: changedAt.toISOString(),
              reasonPresent: Boolean(data.reason),
              notesRedacted: Boolean(data.notes),
            },
          },
        });
        return change;
      });
      logger.info({ phoneLineId: id, actorId }, "Phone line SIM changed");
      return result;
    } catch (error) {
      translateWriteError(error);
    }
  }
}

export default PhoneLinesService;
