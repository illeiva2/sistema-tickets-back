import { EmploymentStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import type {
  CreatePersonRequest,
  PeopleFilters,
  UpdatePersonRequest,
} from "../validations/people";

const departmentSelect = {
  id: true,
  name: true,
  slug: true,
  color: true,
  icon: true,
} as const;

const actorSelect = { id: true, name: true, email: true } as const;

const assetPreviewSelect = {
  id: true,
  assetTag: true,
  type: true,
  status: true,
  brand: true,
  model: true,
  serialNumber: true,
  location: true,
  assignedDepartmentId: true,
  updatedAt: true,
} as const;

const phoneLinePreviewSelect = {
  id: true,
  phoneNumber: true,
  carrier: true,
  carrierOther: true,
  planName: true,
  status: true,
  contractEndsAt: true,
  assetId: true,
  updatedAt: true,
} as const;

const personSafeScalarSelect = {
  id: true,
  employeeNumber: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  workEmail: true,
  workPhone: true,
  status: true,
  startDate: true,
  endDate: true,
  departmentId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const personListSelect = {
  ...personSafeScalarSelect,
  department: { select: departmentSelect },
  assignedAssets: {
    where: { isActive: true },
    select: assetPreviewSelect,
    orderBy: { updatedAt: "desc" as const },
    take: 3,
  },
  _count: {
    select: {
      assignedAssets: { where: { isActive: true } },
    },
  },
} as const;

const personDetailSelect = {
  ...personSafeScalarSelect,
  notes: true,
  department: { select: departmentSelect },
  assignedAssets: {
    where: { isActive: true },
    select: assetPreviewSelect,
    orderBy: { assetTag: "asc" as const },
  },
  phoneLines: {
    where: { isActive: true },
    select: phoneLinePreviewSelect,
    orderBy: { phoneNumber: "asc" as const },
  },
  assetAssignments: {
    select: {
      id: true,
      assetId: true,
      departmentId: true,
      startAt: true,
      endAt: true,
      asset: { select: assetPreviewSelect },
      department: { select: departmentSelect },
      assignedBy: { select: actorSelect },
    },
    orderBy: { startAt: "desc" as const },
    take: 20,
  },
  phoneLineAssignments: {
    select: {
      id: true,
      phoneLineId: true,
      assetId: true,
      assignedAt: true,
      returnedAt: true,
      phoneLine: { select: phoneLinePreviewSelect },
      asset: { select: assetPreviewSelect },
      assignedBy: { select: actorSelect },
    },
    orderBy: { assignedAt: "desc" as const },
    take: 20,
  },
} as const;

const personInternalSelect = {
  ...personSafeScalarSelect,
  notes: true,
} as const;

const auditableFields = [
  "employeeNumber",
  "firstName",
  "lastName",
  "jobTitle",
  "workEmail",
  "workPhone",
  "status",
  "startDate",
  "endDate",
  "departmentId",
  "notes",
] as const;

const redactedAuditFields = new Set(["workEmail", "workPhone", "notes"]);

const normalizeComparable = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
};

const valuesEqual = (left: unknown, right: unknown): boolean =>
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

const buildPersonAudit = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) => {
  const fields: string[] = [];
  const changes: Record<
    string,
    | {
        from: string | number | boolean | null;
        to: string | number | boolean | null;
      }
    | { changed: true; redacted: true }
  > = {};

  for (const field of auditableFields) {
    if (valuesEqual(before[field], after[field])) continue;
    fields.push(field);
    changes[field] =
      redactedAuditFields.has(field)
        ? { changed: true, redacted: true }
        : {
            from: toAuditScalar(before[field]),
            to: toAuditScalar(after[field]),
          };
  }

  return { fields, changes };
};

const parseDate = (
  value: string | null | undefined,
): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(
    isDateOnly ? value + "T00:00:00.000Z" : value,
  );
  if (
    Number.isNaN(parsed.getTime()) ||
    (isDateOnly && parsed.toISOString().slice(0, 10) !== value)
  ) {
    throw new ApiError("PERSON_DATE_INVALID", "Fecha inválida", 400);
  }
  return parsed;
};

const todayUtc = (): Date => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
};

const ensureDateOrder = (candidate: Record<string, unknown>) => {
  const startDate = candidate.startDate as Date | null | undefined;
  const endDate = candidate.endDate as Date | null | undefined;
  if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
    throw new ApiError(
      "PERSON_DATE_RANGE_INVALID",
      "La fecha de egreso no puede ser anterior al ingreso",
      400,
    );
  }
};

const buildCandidate = (
  before: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> => {
  const candidate = { ...before };
  for (const [field, value] of Object.entries(changes)) {
    candidate[field] =
      field === "startDate" || field === "endDate"
        ? parseDate(value as string | null)
        : value;
  }

  const hasExplicitEndDate =
    Object.prototype.hasOwnProperty.call(changes, "endDate") &&
    changes.endDate !== null &&
    changes.endDate !== "";
  if (
    hasExplicitEndDate &&
    candidate.status !== EmploymentStatus.TERMINATED
  ) {
    throw new ApiError(
      "PERSON_END_DATE_STATUS_INVALID",
      "La fecha de egreso sólo corresponde a personal desvinculado",
      400,
    );
  }

  if (candidate.status === EmploymentStatus.TERMINATED) {
    candidate.endDate =
      candidate.endDate ||
      (before.status === EmploymentStatus.TERMINATED && before.endDate
        ? before.endDate
        : todayUtc());
  } else {
    candidate.endDate = null;
  }
  ensureDateOrder(candidate);
  return candidate;
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

const translatePersonWriteError = (error: unknown): never => {
  if (uniqueTargetIncludes(error, "employeeNumber")) {
    throw new ApiError(
      "PERSON_EMPLOYEE_NUMBER_EXISTS",
      "Ya existe una persona con ese legajo",
      409,
    );
  }
  if (uniqueTargetIncludes(error, "workEmail")) {
    throw new ApiError(
      "PERSON_WORK_EMAIL_EXISTS",
      "Ya existe una persona con ese email laboral",
      409,
    );
  }
  const foreignKeyField = isKnownPrismaError(error, "P2003")
    ? error.meta?.field_name
    : undefined;
  if (
    isKnownPrismaError(error, "P2003") &&
    typeof foreignKeyField === "string" &&
    foreignKeyField.toLowerCase().includes("department")
  ) {
    throw new ApiError(
      "PERSON_DEPARTMENT_NOT_FOUND",
      "El sector indicado no existe",
      400,
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
          "PERSON_WRITE_CONFLICT",
          "La persona cambió mientras se procesaba la operación",
          409,
        );
      }
    }
  }
  throw new ApiError(
    "PERSON_WRITE_CONFLICT",
    "La persona cambió mientras se procesaba la operación",
    409,
  );
};

const findCurrent = async (tx: Prisma.TransactionClient, id: string) => {
  const person = await tx.person.findFirst({
    where: { id, isActive: true },
    select: personInternalSelect,
  });
  if (!person) {
    throw new ApiError("PERSON_NOT_FOUND", "Persona no encontrada", 404);
  }
  return person;
};

export class PeopleService {
  static async list(filters: PeopleFilters) {
    const { q, status, departmentId, page, pageSize } = filters;
    const where: Prisma.PersonWhereInput = { isActive: true };
    if (status) where.status = status;
    if (departmentId) where.departmentId = departmentId;
    if (q) {
      where.OR = [
        { employeeNumber: { contains: q, mode: "insensitive" } },
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { jobTitle: { contains: q, mode: "insensitive" } },
        { workEmail: { contains: q, mode: "insensitive" } },
        { workPhone: { contains: q, mode: "insensitive" } },
      ];
    }

    const [people, total] = await prisma.$transaction([
      prisma.person.findMany({
        where,
        select: personListSelect,
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.person.count({ where }),
    ]);

    const items = people.map(({ _count, assignedAssets, ...person }) => ({
      ...person,
      assignedAssetsCount: _count.assignedAssets,
      assignedAssetsPreview: assignedAssets,
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
    const person = await prisma.person.findFirst({
      where: { id, isActive: true },
      select: personDetailSelect,
    });
    if (!person) {
      throw new ApiError("PERSON_NOT_FOUND", "Persona no encontrada", 404);
    }
    return person;
  }

  static async create(data: CreatePersonRequest, actorId: string) {
    const candidate = buildCandidate({}, data);
    const createData: Prisma.PersonUncheckedCreateInput = {
      employeeNumber: candidate.employeeNumber as string | null | undefined,
      firstName: candidate.firstName as string,
      lastName: candidate.lastName as string,
      jobTitle: candidate.jobTitle as string | null | undefined,
      workEmail: candidate.workEmail as string | null | undefined,
      workPhone: candidate.workPhone as string | null | undefined,
      status: candidate.status as EmploymentStatus,
      startDate: candidate.startDate as Date | null | undefined,
      endDate: candidate.endDate as Date | null,
      departmentId: candidate.departmentId as string | null | undefined,
      notes: candidate.notes as string | null | undefined,
    };

    try {
      const person = await runSerializable(async (tx) => {
        const created = await tx.person.create({
          data: createData,
          select: personDetailSelect,
        });
        await tx.auditLog.create({
          data: {
            entity: "person",
            entityId: created.id,
            action: "created",
            actorId,
            meta: buildPersonAudit(
              {},
              created as unknown as Record<string, unknown>,
            ),
          },
        });
        return created;
      });
      logger.info({ personId: person.id, actorId }, "Person created");
      return person;
    } catch (error) {
      translatePersonWriteError(error);
    }
  }

  static async update(
    id: string,
    data: UpdatePersonRequest,
    actorId: string,
  ) {
    const { expectedUpdatedAt, ...changes } = data;
    const expectedVersion = new Date(expectedUpdatedAt);

    try {
      const result = await runSerializable(async (tx) => {
        const current = await findCurrent(tx, id);
        if (current.updatedAt.getTime() !== expectedVersion.getTime()) {
          throw new ApiError(
            "PERSON_VERSION_CONFLICT",
            "La persona fue modificada por otro usuario",
            409,
          );
        }

        const candidate = buildCandidate(
          current as unknown as Record<string, unknown>,
          changes,
        );
        const audit = buildPersonAudit(
          current as unknown as Record<string, unknown>,
          candidate,
        );

        const terminatesNow =
          current.status !== EmploymentStatus.TERMINATED &&
          candidate.status === EmploymentStatus.TERMINATED;
        if (terminatesNow) {
          const [assignedAssets, assignedPhoneLines] = await Promise.all([
            tx.asset.count({
              where: { assignedPersonId: id, isActive: true },
            }),
            tx.phoneLine.count({
              where: { holderId: id, isActive: true },
            }),
          ]);
          if (assignedAssets > 0 || assignedPhoneLines > 0) {
            throw new ApiError(
              "PERSON_HAS_CURRENT_HOLDINGS",
              "La persona conserva equipos o líneas que deben devolverse antes de la baja",
              409,
              { assignedAssets, assignedPhoneLines },
            );
          }
        }

        if (audit.fields.length === 0) {
          const unchanged = await tx.person.findFirst({
            where: { id, isActive: true },
            select: personDetailSelect,
          });
          if (!unchanged) {
            throw new ApiError(
              "PERSON_NOT_FOUND",
              "Persona no encontrada",
              404,
            );
          }
          return { person: unchanged, changed: false };
        }

        const fields = new Set(audit.fields);
        const updateData: Prisma.PersonUncheckedUpdateInput = {};
        if (fields.has("employeeNumber")) {
          updateData.employeeNumber = candidate.employeeNumber as string | null;
        }
        if (fields.has("firstName")) {
          updateData.firstName = candidate.firstName as string;
        }
        if (fields.has("lastName")) {
          updateData.lastName = candidate.lastName as string;
        }
        if (fields.has("jobTitle")) {
          updateData.jobTitle = candidate.jobTitle as string | null;
        }
        if (fields.has("workEmail")) {
          updateData.workEmail = candidate.workEmail as string | null;
        }
        if (fields.has("workPhone")) {
          updateData.workPhone = candidate.workPhone as string | null;
        }
        if (fields.has("status")) {
          updateData.status = candidate.status as EmploymentStatus;
        }
        if (fields.has("startDate")) {
          updateData.startDate = candidate.startDate as Date | null;
        }
        if (fields.has("endDate")) {
          updateData.endDate = candidate.endDate as Date | null;
        }
        if (fields.has("departmentId")) {
          updateData.departmentId = candidate.departmentId as string | null;
        }
        if (fields.has("notes")) {
          updateData.notes = candidate.notes as string | null;
        }

        const write = await tx.person.updateMany({
          where: { id, isActive: true, updatedAt: expectedVersion },
          data: updateData,
        });
        if (write.count !== 1) {
          throw new ApiError(
            "PERSON_VERSION_CONFLICT",
            "La persona fue modificada por otro usuario",
            409,
          );
        }

        const updated = await tx.person.findFirst({
          where: { id, isActive: true },
          select: personDetailSelect,
        });
        if (!updated) {
          throw new ApiError("PERSON_NOT_FOUND", "Persona no encontrada", 404);
        }
        await tx.auditLog.create({
          data: {
            entity: "person",
            entityId: id,
            action: "updated",
            actorId,
            meta: audit,
          },
        });
        return { person: updated, changed: true };
      });

      logger.info(
        { personId: id, actorId, changed: result.changed },
        result.changed ? "Person updated" : "Person update skipped",
      );
      return result.person;
    } catch (error) {
      translatePersonWriteError(error);
    }
  }
}

export default PeopleService;
