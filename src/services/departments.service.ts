import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { slugify, ensureUniqueSlug } from "../lib/slug";
import type {
  CreateDepartmentRequest,
  UpdateDepartmentRequest,
} from "../validations/departments";

const departmentSelect = {
  id: true,
  name: true,
  slug: true,
  color: true,
  icon: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { users: true } },
} as const;

export class DepartmentsService {
  static async list() {
    return prisma.department.findMany({
      select: departmentSelect,
      orderBy: { name: "asc" },
    });
  }

  static async getOne(id: string) {
    const dep = await prisma.department.findUnique({
      where: { id },
      select: departmentSelect,
    });
    if (!dep) {
      throw new ApiError("DEPARTMENT_NOT_FOUND", "Sector no encontrado", 404);
    }
    return dep;
  }

  static async create(data: CreateDepartmentRequest) {
    const baseSlug = slugify(data.name);
    const slug = await ensureUniqueSlug(baseSlug || "sector", async (s) => {
      const found = await prisma.department.findUnique({
        where: { slug: s },
        select: { id: true },
      });
      return !!found;
    });

    // Validar nombre unico (case-insensitive seria ideal pero el unique
    // del schema ya cubre exact match; un check extra ayuda al UX).
    const existsByName = await prisma.department.findFirst({
      where: { name: { equals: data.name, mode: "insensitive" } },
      select: { id: true },
    });
    if (existsByName) {
      throw new ApiError(
        "DEPARTMENT_DUPLICATE",
        "Ya existe un sector con ese nombre",
        409,
      );
    }

    const created = await prisma.department.create({
      data: {
        name: data.name.trim(),
        slug,
        color: data.color ?? null,
        icon: data.icon ?? null,
      },
      select: departmentSelect,
    });
    logger.info({ departmentId: created.id }, "Department created");
    return created;
  }

  static async update(id: string, data: UpdateDepartmentRequest) {
    const existing = await prisma.department.findUnique({ where: { id } });
    if (!existing) {
      throw new ApiError("DEPARTMENT_NOT_FOUND", "Sector no encontrado", 404);
    }

    // Si cambia el nombre, regenerar slug (preservando unicidad) y
    // chequear que el nuevo nombre no choque con otro sector.
    let nextSlug: string | undefined;
    if (data.name && data.name !== existing.name) {
      const dup = await prisma.department.findFirst({
        where: {
          name: { equals: data.name, mode: "insensitive" },
          NOT: { id },
        },
        select: { id: true },
      });
      if (dup) {
        throw new ApiError(
          "DEPARTMENT_DUPLICATE",
          "Ya existe un sector con ese nombre",
          409,
        );
      }
      const base = slugify(data.name);
      nextSlug = await ensureUniqueSlug(base || "sector", async (s) => {
        if (s === existing.slug) return false;
        const found = await prisma.department.findUnique({
          where: { slug: s },
          select: { id: true },
        });
        return !!found;
      });
    }

    const updated = await prisma.department.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(nextSlug ? { slug: nextSlug } : {}),
        ...(Object.prototype.hasOwnProperty.call(data, "color")
          ? { color: data.color ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(data, "icon")
          ? { icon: data.icon ?? null }
          : {}),
      },
      select: departmentSelect,
    });
    logger.info({ departmentId: id }, "Department updated");
    return updated;
  }

  // Hard delete. Por onDelete: SetNull en User.departmentId, los usuarios
  // del sector quedan con department=null automáticamente.
  static async remove(id: string) {
    const existing = await prisma.department.findUnique({ where: { id } });
    if (!existing) {
      throw new ApiError("DEPARTMENT_NOT_FOUND", "Sector no encontrado", 404);
    }
    await prisma.department.delete({ where: { id } });
    logger.info({ departmentId: id }, "Department deleted");
  }
}

export default DepartmentsService;
