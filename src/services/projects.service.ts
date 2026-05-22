import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { slugify, ensureUniqueSlug } from "../lib/slug";
import { UserRole } from "@prisma/client";
import type {
  CreateProjectRequest,
  UpdateProjectRequest,
  ProjectFilters,
} from "../validations/projects";

const projectInclude = {
  lead: { select: { id: true, name: true, email: true } },
  team: { select: { id: true, name: true, email: true } },
} as const;

// Acepta string ISO, "" o null y devuelve Date | null | undefined.
const parseDate = (value: unknown): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return undefined;
};

// Determina si un user puede editar el proyecto:
// - ADMIN siempre.
// - AGENT solo si es lead o está en team.
// - USER nunca.
const canEditProject = (
  project: { leadId: string; team: { id: string }[] },
  userId: string,
  userRole: UserRole,
): boolean => {
  if (userRole === UserRole.ADMIN) return true;
  if (userRole === UserRole.AGENT) {
    if (project.leadId === userId) return true;
    return project.team.some((t) => t.id === userId);
  }
  return false;
};

export class ProjectsService {
  static async list(filters: ProjectFilters, userRole: UserRole) {
    const { q, status, includeDrafts, page, pageSize } = filters;
    const includeDraftsBool =
      includeDrafts === true || includeDrafts === "true";
    const isStaff = userRole === UserRole.ADMIN || userRole === UserRole.AGENT;

    const where: any = {};

    // USER solo ve publicados. Staff puede ver drafts si los pide
    // explícitamente; sino, también solo publicados.
    if (!isStaff || !includeDraftsBool) {
      where.isPublished = true;
    }

    if (status) where.status = status;

    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { excerpt: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }

    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      prisma.project.findMany({
        where,
        include: projectInclude,
        // Pinned arriba, después por último update.
        orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
        skip,
        take: pageSize,
      }),
      prisma.project.count({ where }),
    ]);

    return {
      data: items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  static async getOne(idOrSlug: string, userRole: UserRole) {
    const looksLikeCuid = /^c[0-9a-z]{24}$/i.test(idOrSlug);
    const project = await prisma.project.findFirst({
      where: looksLikeCuid ? { id: idOrSlug } : { slug: idOrSlug },
      include: projectInclude,
    });
    if (!project) {
      throw new ApiError("PROJECT_NOT_FOUND", "Proyecto no encontrado", 404);
    }
    if (!project.isPublished && userRole !== UserRole.ADMIN && userRole !== UserRole.AGENT) {
      throw new ApiError("PROJECT_NOT_FOUND", "Proyecto no encontrado", 404);
    }
    return project;
  }

  // Para la card del dashboard: solo IN_PROGRESS publicados, ordenados por
  // pinned + updatedAt. Limit chico.
  static async getInProgress(limit = 5) {
    return prisma.project.findMany({
      where: {
        status: "IN_PROGRESS",
        isPublished: true,
      },
      include: projectInclude,
      orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
      take: limit,
    });
  }

  static async create(
    data: CreateProjectRequest,
    actorId: string,
    actorRole: UserRole,
  ) {
    if (actorRole !== UserRole.ADMIN && actorRole !== UserRole.AGENT) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo ADMIN o AGENT pueden crear proyectos",
        403,
      );
    }

    const baseSlug = slugify(data.title);
    const slug = await ensureUniqueSlug(baseSlug, async (s) => {
      const found = await prisma.project.findUnique({
        where: { slug: s },
        select: { id: true },
      });
      return !!found;
    });

    // Lead default = el que crea, salvo que se especifique otro (solo ADMIN).
    let leadId = actorId;
    if (data.leadId && data.leadId !== actorId) {
      if (actorRole !== UserRole.ADMIN) {
        throw new ApiError(
          "FORBIDDEN",
          "Solo ADMIN puede asignar otro lead",
          403,
        );
      }
      // Verificamos que exista y sea staff.
      const target = await prisma.user.findUnique({
        where: { id: data.leadId },
        select: { id: true, role: true, isActive: true },
      });
      if (!target || !target.isActive || target.role === UserRole.USER) {
        throw new ApiError(
          "INVALID_LEAD",
          "El lead debe ser un AGENT o ADMIN activo",
          400,
        );
      }
      leadId = data.leadId;
    }

    const teamIds = (data.teamUserIds ?? []).filter((id) => id !== leadId);
    if (teamIds.length > 0) {
      const validTeam = await prisma.user.findMany({
        where: {
          id: { in: teamIds },
          isActive: true,
          role: { in: [UserRole.ADMIN, UserRole.AGENT] },
        },
        select: { id: true },
      });
      if (validTeam.length !== teamIds.length) {
        throw new ApiError(
          "INVALID_TEAM",
          "Algún miembro del team no existe o no es staff",
          400,
        );
      }
    }

    const project = await prisma.project.create({
      data: {
        slug,
        title: data.title,
        description: data.description,
        excerpt: data.excerpt ?? null,
        status: data.status,
        progressPercent: data.progressPercent ?? null,
        startedAt: parseDate(data.startedAt) ?? null,
        expectedEndAt: parseDate(data.expectedEndAt) ?? null,
        completedAt: parseDate(data.completedAt) ?? null,
        isPublished: data.isPublished,
        isPinned: data.isPinned,
        leadId,
        team:
          teamIds.length > 0
            ? { connect: teamIds.map((id) => ({ id })) }
            : undefined,
      },
      include: projectInclude,
    });

    logger.info({ projectId: project.id, actorId }, "Project created");
    return project;
  }

  static async update(
    id: string,
    data: UpdateProjectRequest,
    actorId: string,
    actorRole: UserRole,
  ) {
    const existing = await prisma.project.findUnique({
      where: { id },
      include: { team: { select: { id: true } } },
    });
    if (!existing) {
      throw new ApiError("PROJECT_NOT_FOUND", "Proyecto no encontrado", 404);
    }
    if (!canEditProject(existing, actorId, actorRole)) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo el lead, miembros del team o un ADMIN pueden editar este proyecto",
        403,
      );
    }

    // Solo ADMIN puede reasignar lead o cambiar team libremente.
    if (data.leadId && data.leadId !== existing.leadId && actorRole !== UserRole.ADMIN) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo ADMIN puede reasignar el lead del proyecto",
        403,
      );
    }

    // Si cambia el título, regenerar slug.
    let nextSlug: string | undefined;
    if (data.title && data.title !== existing.title) {
      const base = slugify(data.title);
      nextSlug = await ensureUniqueSlug(base, async (s) => {
        if (s === existing.slug) return false;
        const found = await prisma.project.findUnique({
          where: { slug: s },
          select: { id: true },
        });
        return !!found;
      });
    }

    // Procesar fechas.
    const updateData: any = { ...data };
    delete updateData.teamUserIds;
    if (Object.prototype.hasOwnProperty.call(data, "startedAt")) {
      updateData.startedAt = parseDate(data.startedAt) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "expectedEndAt")) {
      updateData.expectedEndAt = parseDate(data.expectedEndAt) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "completedAt")) {
      updateData.completedAt = parseDate(data.completedAt) ?? null;
    }

    // Si vino teamUserIds, reemplazamos el set entero (set= reset).
    if (data.teamUserIds !== undefined) {
      const teamIds = data.teamUserIds.filter(
        (uid) => uid !== (data.leadId ?? existing.leadId),
      );
      if (teamIds.length > 0) {
        const validTeam = await prisma.user.findMany({
          where: {
            id: { in: teamIds },
            isActive: true,
            role: { in: [UserRole.ADMIN, UserRole.AGENT] },
          },
          select: { id: true },
        });
        if (validTeam.length !== teamIds.length) {
          throw new ApiError(
            "INVALID_TEAM",
            "Algún miembro del team no existe o no es staff",
            400,
          );
        }
      }
      updateData.team = {
        set: teamIds.map((tid: string) => ({ id: tid })),
      };
    }

    const project = await prisma.project.update({
      where: { id },
      data: {
        ...updateData,
        ...(nextSlug ? { slug: nextSlug } : {}),
      },
      include: projectInclude,
    });

    logger.info({ projectId: id, actorId }, "Project updated");
    return project;
  }

  static async remove(id: string, actorRole: UserRole) {
    if (actorRole !== UserRole.ADMIN) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo ADMIN puede eliminar proyectos",
        403,
      );
    }
    const existing = await prisma.project.findUnique({ where: { id } });
    if (!existing) {
      throw new ApiError("PROJECT_NOT_FOUND", "Proyecto no encontrado", 404);
    }
    await prisma.project.delete({ where: { id } });
    logger.info({ projectId: id }, "Project deleted");
  }
}

export default ProjectsService;
