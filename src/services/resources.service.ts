import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { slugify, ensureUniqueSlug } from "../lib/slug";
import { UserRole } from "@prisma/client";
import type {
  CreateResourceRequest,
  UpdateResourceRequest,
  ResourceFilters,
} from "../validations/resources";

const listSelect = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  category: true,
  tags: true,
  isPublished: true,
  viewCount: true,
  authorId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, email: true } },
} as const;

export class ResourcesService {
  static async list(filters: ResourceFilters, userRole: UserRole) {
    const { q, category, tag, includeDrafts, page, pageSize } = filters;
    const includeDraftsBool =
      includeDrafts === true || includeDrafts === "true";

    const where: any = {};

    // Solo ADMIN puede ver borradores. Para todos los demás, solo publicados.
    if (userRole !== UserRole.ADMIN || !includeDraftsBool) {
      where.isPublished = true;
    }

    if (category) where.category = category;
    if (tag) where.tags = { has: tag };

    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { excerpt: { contains: q, mode: "insensitive" } },
        { content: { contains: q, mode: "insensitive" } },
      ];
    }

    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      prisma.resource.findMany({
        where,
        select: listSelect,
        orderBy: [{ updatedAt: "desc" }],
        skip,
        take: pageSize,
      }),
      prisma.resource.count({ where }),
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

  /**
   * Acepta id (cuid) o slug. Si encuentra, incrementa viewCount.
   * Solo devuelve borradores a admins.
   */
  static async getOne(idOrSlug: string, userRole: UserRole) {
    const looksLikeCuid = /^c[0-9a-z]{24}$/i.test(idOrSlug);

    const resource = await prisma.resource.findFirst({
      where: looksLikeCuid ? { id: idOrSlug } : { slug: idOrSlug },
      include: {
        author: { select: { id: true, name: true, email: true } },
      },
    });

    if (!resource) {
      throw new ApiError("RESOURCE_NOT_FOUND", "Recurso no encontrado", 404);
    }

    if (!resource.isPublished && userRole !== UserRole.ADMIN) {
      // No revelar la existencia del borrador a no-admins.
      throw new ApiError("RESOURCE_NOT_FOUND", "Recurso no encontrado", 404);
    }

    // Incrementar viewCount best-effort. Si falla no rompe la lectura.
    prisma.resource
      .update({
        where: { id: resource.id },
        data: { viewCount: { increment: 1 } },
      })
      .catch((err) => {
        logger.warn({ err }, "Failed to increment resource viewCount");
      });

    return resource;
  }

  static async create(authorId: string, data: CreateResourceRequest) {
    const baseSlug = slugify(data.title);
    const slug = await ensureUniqueSlug(baseSlug, async (s) => {
      const existing = await prisma.resource.findUnique({
        where: { slug: s },
        select: { id: true },
      });
      return !!existing;
    });

    const resource = await prisma.resource.create({
      data: {
        slug,
        title: data.title,
        content: data.content,
        excerpt: data.excerpt ?? null,
        category: data.category,
        tags: data.tags,
        isPublished: data.isPublished,
        authorId,
      },
      include: {
        author: { select: { id: true, name: true, email: true } },
      },
    });

    logger.info(
      { resourceId: resource.id, authorId },
      "Resource created",
    );
    return resource;
  }

  static async update(id: string, data: UpdateResourceRequest) {
    const existing = await prisma.resource.findUnique({ where: { id } });
    if (!existing) {
      throw new ApiError("RESOURCE_NOT_FOUND", "Recurso no encontrado", 404);
    }

    // Si cambia el título, regenerar el slug (preservando unicidad).
    let nextSlug: string | undefined;
    if (data.title && data.title !== existing.title) {
      const base = slugify(data.title);
      nextSlug = await ensureUniqueSlug(base, async (s) => {
        if (s === existing.slug) return false; // su propio slug actual
        const found = await prisma.resource.findUnique({
          where: { slug: s },
          select: { id: true },
        });
        return !!found;
      });
    }

    const resource = await prisma.resource.update({
      where: { id },
      data: {
        ...data,
        ...(nextSlug ? { slug: nextSlug } : {}),
      },
      include: {
        author: { select: { id: true, name: true, email: true } },
      },
    });

    logger.info({ resourceId: id }, "Resource updated");
    return resource;
  }

  static async remove(id: string) {
    const existing = await prisma.resource.findUnique({ where: { id } });
    if (!existing) {
      throw new ApiError("RESOURCE_NOT_FOUND", "Recurso no encontrado", 404);
    }
    await prisma.resource.delete({ where: { id } });
    logger.info({ resourceId: id }, "Resource deleted");
  }

  /**
   * Sugerencias contextuales. Pensado para invocar desde NewTicket
   * mientras el usuario tipea el título: si hay artículos relevantes
   * se los muestra antes de que abra el ticket.
   *
   * Estrategia simple: split del query en palabras, scoring por matches
   * en title (peso 3), excerpt (2), tags (2), content (1).
   */
  static async suggest(q: string, limit: number) {
    const terms = q
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 6);

    if (terms.length === 0) return [];

    // Trae candidatos que matcheen al menos una palabra. El scoring lo
    // hacemos en memoria sobre un subset acotado.
    const candidates = await prisma.resource.findMany({
      where: {
        isPublished: true,
        OR: terms.flatMap((term) => [
          { title: { contains: term, mode: "insensitive" as const } },
          { excerpt: { contains: term, mode: "insensitive" as const } },
          { content: { contains: term, mode: "insensitive" as const } },
          { tags: { has: term } },
        ]),
      },
      select: {
        id: true,
        slug: true,
        title: true,
        excerpt: true,
        category: true,
        tags: true,
        content: true,
      },
      take: 50,
    });

    const scored = candidates.map((r) => {
      const titleLower = r.title.toLowerCase();
      const excerptLower = (r.excerpt ?? "").toLowerCase();
      const contentLower = r.content.toLowerCase();
      const tagsLower = r.tags.map((t) => t.toLowerCase());

      let score = 0;
      for (const term of terms) {
        if (titleLower.includes(term)) score += 3;
        if (excerptLower.includes(term)) score += 2;
        if (tagsLower.some((t) => t.includes(term))) score += 2;
        if (contentLower.includes(term)) score += 1;
      }

      return { resource: r, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ resource }) => ({
        id: resource.id,
        slug: resource.slug,
        title: resource.title,
        excerpt: resource.excerpt,
        category: resource.category,
        tags: resource.tags,
      }));
  }
}
