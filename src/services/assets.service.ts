import { AssetType, Prisma, UserRole } from "@prisma/client";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import type {
  AssetFilters,
  AssignAssetRequest,
  CreateAssetRequest,
  ReturnAssetRequest,
  UpdateAssetRequest,
} from "../validations/assets";

const actorSelect = { id: true, name: true, email: true } as const;
const departmentSelect = {
  id: true,
  name: true,
  slug: true,
  color: true,
  icon: true,
} as const;
const personSelect = {
  id: true,
  employeeNumber: true,
  firstName: true,
  lastName: true,
  workEmail: true,
  status: true,
  department: { select: departmentSelect },
} as const;
const assignmentInclude = {
  person: { select: personSelect },
  department: { select: departmentSelect },
  assignedBy: { select: actorSelect },
} as const;

const assetListInclude = {
  assignedPerson: { select: personSelect },
  assignedDepartment: { select: departmentSelect },
  createdBy: { select: actorSelect },
  assignments: {
    where: { endAt: null },
    include: assignmentInclude,
    orderBy: { startAt: "desc" as const },
    take: 1,
  },
} as const;

const assetDetailInclude = {
  assignedPerson: { select: personSelect },
  assignedDepartment: { select: departmentSelect },
  createdBy: { select: actorSelect },
  assignments: {
    include: assignmentInclude,
    orderBy: { startAt: "desc" as const },
  },
} as const;

const assetTagPrefixes: Record<AssetType, string> = {
  DESKTOP: "PC",
  NOTEBOOK: "NB",
  PHONE: "PH",
  TABLET: "TB",
  MONITOR: "MN",
  PRINTER: "PR",
  PERIPHERAL: "PE",
  NETWORK_DEVICE: "NET",
  SERVER: "SRV",
  OTHER: "OT",
};

const safeFieldNames = (data: Record<string, unknown>): string[] =>
  Object.keys(data).sort();

const parseDate = (
  value: string | null | undefined,
): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value + "T00:00:00.000Z"
      : value,
  );
};

const specsInput = (
  value: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
};

const isKnownPrismaError = (
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;

const isUniqueFieldError = (error: unknown, field: string): boolean => {
  if (!isKnownPrismaError(error, "P2002")) return false;
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === "string" && target.includes(field);
};

const translateAssetWriteError = (error: unknown): never => {
  if (isUniqueFieldError(error, "assetTag")) {
    throw new ApiError(
      "ASSET_TAG_EXISTS",
      "Ya existe un activo con ese código",
      409,
    );
  }
  if (isUniqueFieldError(error, "serialNumber")) {
    throw new ApiError(
      "SERIAL_NUMBER_EXISTS",
      "Ya existe un activo con ese número de serie",
      409,
    );
  }
  if (isKnownPrismaError(error, "P2003")) {
    throw new ApiError(
      "INVALID_ASSET_REFERENCE",
      "La compra o referencia indicada no existe",
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
          "ASSET_WRITE_CONFLICT",
          "El activo cambió mientras se procesaba la operación",
          409,
        );
      }
    }
  }
  throw new ApiError(
    "ASSET_WRITE_CONFLICT",
    "El activo cambió mientras se procesaba la operación",
    409,
  );
};

const nextAssetTag = async (
  tx: Prisma.TransactionClient,
  type: AssetType,
): Promise<string> => {
  const prefix = assetTagPrefixes[type];
  const existing = await tx.asset.findMany({
    where: { assetTag: { startsWith: prefix + "-" } },
    select: { assetTag: true },
  });
  const pattern = new RegExp("^" + prefix + "-(\\d+)$");
  const max = existing.reduce((current, item) => {
    const match = pattern.exec(item.assetTag);
    if (!match) return current;
    return Math.max(current, Number.parseInt(match[1], 10));
  }, 0);
  return prefix + "-" + String(max + 1).padStart(4, "0");
};

const findActiveAsset = async (
  tx: Prisma.TransactionClient,
  id: string,
) => {
  const asset = await tx.asset.findFirst({
    where: { id, isActive: true },
    select: {
      id: true,
      assetTag: true,
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

export class AssetsService {
  static async list(filters: AssetFilters) {
    const {
      q,
      type,
      status,
      assignedPersonId,
      assignedDepartmentId,
      page,
      pageSize,
    } = filters;
    const where: Prisma.AssetWhereInput = { isActive: true };

    if (type) where.type = type;
    if (status) where.status = status;
    if (assignedPersonId) where.assignedPersonId = assignedPersonId;
    if (assignedDepartmentId) {
      where.assignedDepartmentId = assignedDepartmentId;
    }
    if (q) {
      where.OR = [
        { assetTag: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
        { model: { contains: q, mode: "insensitive" } },
        { serialNumber: { contains: q, mode: "insensitive" } },
        { location: { contains: q, mode: "insensitive" } },
        {
          assignedPerson: {
            is: {
              OR: [
                { firstName: { contains: q, mode: "insensitive" } },
                { lastName: { contains: q, mode: "insensitive" } },
                { workEmail: { contains: q, mode: "insensitive" } },
              ],
            },
          },
        },
        {
          assignedDepartment: {
            is: { name: { contains: q, mode: "insensitive" } },
          },
        },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        include: assetListInclude,
        orderBy: { assetTag: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.asset.count({ where }),
    ]);

    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  static async getOne(id: string) {
    const asset = await prisma.asset.findFirst({
      where: { id, isActive: true },
      include: assetDetailInclude,
    });
    if (!asset) {
      throw new ApiError("ASSET_NOT_FOUND", "Activo no encontrado", 404);
    }
    return asset;
  }

  static async create(data: CreateAssetRequest, actorId: string) {
    const generatedTag = !data.assetTag;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const asset = await runSerializable(async (tx) => {
          const assetTag =
            data.assetTag ?? (await nextAssetTag(tx, data.type as AssetType));
          const created = await tx.asset.create({
            data: {
              assetTag,
              type: data.type,
              status: data.status,
              brand: data.brand,
              model: data.model,
              serialNumber: data.serialNumber,
              specs: specsInput(data.specs),
              notes: data.notes,
              secretsRef: data.secretsRef,
              location: data.location,
              warrantyUntil: parseDate(data.warrantyUntil),
              purchaseItemId: data.purchaseItemId,
              retirementReason: data.retirementReason,
              retiredAt: data.status === "RETIRED" ? new Date() : undefined,
              createdById: actorId,
            },
            include: assetListInclude,
          });

          await tx.auditLog.create({
            data: {
              entity: "asset",
              entityId: created.id,
              action: "created",
              actorId,
              meta: {
                fields: safeFieldNames({
                  ...data,
                  assetTag: undefined,
                }),
                assetTagGenerated: generatedTag,
              },
            },
          });
          return created;
        });

        logger.info({ assetId: asset.id, actorId }, "Asset created");
        return asset;
      } catch (error) {
        if (
          generatedTag &&
          isUniqueFieldError(error, "assetTag") &&
          attempt < 4
        ) {
          continue;
        }
        translateAssetWriteError(error);
      }
    }

    throw new ApiError(
      "ASSET_TAG_CONFLICT",
      "No se pudo reservar un código de activo",
      409,
    );
  }

  static async update(
    id: string,
    data: UpdateAssetRequest,
    actorId: string,
    actorRole: UserRole,
  ) {
    try {
      const asset = await runSerializable(async (tx) => {
        const current = await findActiveAsset(tx, id);
        const changesAssetTag =
          data.assetTag !== undefined &&
          data.assetTag.toUpperCase() !== current.assetTag.toUpperCase();
        if (
          changesAssetTag &&
          actorRole !== UserRole.ADMIN
        ) {
          throw new ApiError(
            "FORBIDDEN",
            "Solo ADMIN puede modificar el código de activo",
            403,
          );
        }
        if (
          data.status === "ASSIGNED" &&
          current.status !== "ASSIGNED"
        ) {
          throw new ApiError(
            "ASSET_STATUS_MANAGED",
            "Usá el endpoint de asignación para marcar un activo como asignado",
            400,
          );
        }
        if (
          data.status !== undefined &&
          data.status !== current.status
        ) {
          const activeAssignment = await tx.assetAssignment.findFirst({
            where: { assetId: id, endAt: null },
            select: { id: true },
          });
          if (activeAssignment) {
            throw new ApiError(
              "ASSET_HAS_ACTIVE_ASSIGNMENT",
              "Devolvé el activo antes de cambiar su estado",
              409,
            );
          }
          if (
            current.status === "ASSIGNED" ||
            current.assignedPersonId ||
            current.assignedDepartmentId
          ) {
            throw new ApiError(
              "ASSET_HAS_ACTIVE_ASSIGNMENT",
              "Devolvé el activo antes de cambiar su estado",
              409,
            );
          }
        }

        const updateData: Prisma.AssetUncheckedUpdateInput = {
          assetTag:
            actorRole === UserRole.ADMIN ||
            changesAssetTag
              ? data.assetTag
              : undefined,
          type: data.type,
          status: data.status,
          brand: data.brand,
          model: data.model,
          serialNumber: data.serialNumber,
          specs: specsInput(data.specs),
          notes: data.notes,
          secretsRef: data.secretsRef,
          location: data.location,
          warrantyUntil: parseDate(data.warrantyUntil),
          purchaseItemId: data.purchaseItemId,
          retirementReason: data.retirementReason,
        };
        if (data.status === "RETIRED") {
          updateData.retiredAt = new Date();
        } else if (
          data.status !== undefined &&
          current.status === "RETIRED"
        ) {
          updateData.retiredAt = null;
          if (data.retirementReason === undefined) {
            updateData.retirementReason = null;
          }
        }

        const updated = await tx.asset.update({
          where: { id },
          data: updateData,
          include: assetListInclude,
        });
        await tx.auditLog.create({
          data: {
            entity: "asset",
            entityId: id,
            action: "updated",
            actorId,
            meta: { fields: safeFieldNames(data) },
          },
        });
        return updated;
      });

      logger.info({ assetId: id, actorId }, "Asset updated");
      return asset;
    } catch (error) {
      translateAssetWriteError(error);
    }
  }

  static async assign(
    id: string,
    data: AssignAssetRequest,
    actorId: string,
  ) {
    const asset = await runSerializable(async (tx) => {
      const current = await findActiveAsset(tx, id);
      const activeAssignment = await tx.assetAssignment.findFirst({
        where: { assetId: id, endAt: null },
        select: { id: true },
      });
      if (
        activeAssignment ||
        current.status === "ASSIGNED" ||
        current.assignedPersonId ||
        current.assignedDepartmentId
      ) {
        throw new ApiError(
          "ASSET_ALREADY_ASSIGNED",
          "El activo ya tiene una asignación vigente",
          409,
        );
      }
      if (current.status !== "IN_STOCK") {
        throw new ApiError(
          "ASSET_NOT_ASSIGNABLE",
          "Solo se pueden asignar activos disponibles en stock",
          409,
        );
      }

      if (data.personId) {
        const person = await tx.person.findFirst({
          where: {
            id: data.personId,
            isActive: true,
            status: "ACTIVE",
          },
          select: { id: true },
        });
        if (!person) {
          throw new ApiError(
            "PERSON_NOT_FOUND",
            "Persona activa no encontrada",
            404,
          );
        }
      }
      if (data.departmentId) {
        const department = await tx.department.findUnique({
          where: { id: data.departmentId },
          select: { id: true },
        });
        if (!department) {
          throw new ApiError(
            "DEPARTMENT_NOT_FOUND",
            "Sector no encontrado",
            404,
          );
        }
      }

      const assignment = await tx.assetAssignment.create({
        data: {
          assetId: id,
          personId: data.personId,
          departmentId: data.departmentId,
          assignedById: actorId,
          note: data.note,
        },
        select: { id: true },
      });
      const updated = await tx.asset.update({
        where: { id },
        data: {
          status: "ASSIGNED",
          assignedPersonId: data.personId ?? null,
          assignedDepartmentId: data.departmentId ?? null,
        },
        include: assetListInclude,
      });
      await tx.auditLog.create({
        data: {
          entity: "asset",
          entityId: id,
          action: "assigned",
          actorId,
          meta: {
            assignmentId: assignment.id,
            personId: data.personId ?? null,
            departmentId: data.departmentId ?? null,
            fields: [
              "assignedPersonId",
              "assignedDepartmentId",
              "status",
            ],
          },
        },
      });
      return updated;
    });

    logger.info({ assetId: id, actorId }, "Asset assigned");
    return asset;
  }

  static async returnAsset(
    id: string,
    data: ReturnAssetRequest,
    actorId: string,
  ) {
    const asset = await runSerializable(async (tx) => {
      await findActiveAsset(tx, id);
      const assignment = await tx.assetAssignment.findFirst({
        where: { assetId: id, endAt: null },
        orderBy: { startAt: "desc" },
        select: {
          id: true,
          personId: true,
          departmentId: true,
        },
      });
      if (!assignment) {
        throw new ApiError(
          "ASSET_NOT_ASSIGNED",
          "El activo no tiene una asignación vigente",
          409,
        );
      }

      const closed = await tx.assetAssignment.updateMany({
        where: { id: assignment.id, endAt: null },
        data: {
          endAt: new Date(),
          returnNote: data.returnNote,
        },
      });
      if (closed.count !== 1) {
        throw new ApiError(
          "ASSET_ASSIGNMENT_CONFLICT",
          "La asignación ya había sido devuelta",
          409,
        );
      }

      const updated = await tx.asset.update({
        where: { id },
        data: {
          status: "IN_STOCK",
          assignedPersonId: null,
          assignedDepartmentId: null,
        },
        include: assetListInclude,
      });
      await tx.auditLog.create({
        data: {
          entity: "asset",
          entityId: id,
          action: "returned",
          actorId,
          meta: {
            assignmentId: assignment.id,
            personId: assignment.personId,
            departmentId: assignment.departmentId,
            fields: [
              "assignedPersonId",
              "assignedDepartmentId",
              "status",
              "endAt",
              "returnNote",
            ],
          },
        },
      });
      return updated;
    });

    logger.info({ assetId: id, actorId }, "Asset returned");
    return asset;
  }
}

export default AssetsService;
