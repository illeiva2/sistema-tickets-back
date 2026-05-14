import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { slugify, ensureUniqueSlug } from "../lib/slug";
import { UserRole } from "@prisma/client";
import cloudinary from "../lib/cloudinary";
import streamifier from "streamifier";
import type {
  CreateResourceRequest,
  UpdateResourceRequest,
  ResourceFilters,
} from "../validations/resources";

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const listSelect = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  category: true,
  tags: true,
  isPublished: true,
  isPinned: true,
  showAsModal: true,
  pinExpiresAt: true,
  viewCount: true,
  authorId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, email: true } },
  audienceDepartments: {
    select: { id: true, name: true, color: true, icon: true },
  },
} as const;

// Construye el fragmento de where que filtra por audiencia segun el rol
// del usuario. Reglas:
// - ADMIN y AGENT: sin restriccion (ven todos los recursos).
// - USER con departmentId: ve los publicos (audiencia vacia) + los de su
//   sector.
// - USER sin departmentId: solo ve los publicos.
const buildAudienceWhere = (
  userRole: UserRole,
  userDepartmentId: string | null | undefined,
): any => {
  if (userRole === UserRole.ADMIN || userRole === UserRole.AGENT) return {};
  // USER
  if (userDepartmentId) {
    return {
      OR: [
        { audienceDepartments: { none: {} } },
        {
          audienceDepartments: {
            some: { id: userDepartmentId },
          },
        },
      ],
    };
  }
  return { audienceDepartments: { none: {} } };
};

// Helper: chequea si un recurso es visible para el usuario segun audiencia.
// Lo usamos post-fetch en getOne (donde el lookup es por id/slug y no
// queremos colar audiencia en la query).
const isResourceVisible = (
  resource: { audienceDepartments?: Array<{ id: string }> },
  userRole: UserRole,
  userDepartmentId: string | null | undefined,
): boolean => {
  if (userRole === UserRole.ADMIN || userRole === UserRole.AGENT) return true;
  const audience = resource.audienceDepartments ?? [];
  if (audience.length === 0) return true; // publico
  if (!userDepartmentId) return false;
  return audience.some((d) => d.id === userDepartmentId);
};

// Helper: parsea un valor del payload a Date | null para pinExpiresAt.
// Acepta ISO string, "" o null para "sin vencimiento".
const parsePinExpiresAt = (value: unknown): Date | null | undefined => {
  if (value === undefined) return undefined; // no se toca
  if (value === null || value === "") return null;
  if (typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return undefined;
};

export class ResourcesService {
  static async list(
    filters: ResourceFilters,
    userRole: UserRole,
    userDepartmentId: string | null | undefined,
  ) {
    const { q, category, tag, includeDrafts, page, pageSize } = filters;
    const includeDraftsBool =
      includeDrafts === true || includeDrafts === "true";

    // Construimos como AND para no chocar entre OR de busqueda (q) y OR
    // de audiencia.
    const andConditions: any[] = [];

    // Solo ADMIN puede ver borradores. Para todos los demás, solo publicados.
    if (userRole !== UserRole.ADMIN || !includeDraftsBool) {
      andConditions.push({ isPublished: true });
    }

    if (category) andConditions.push({ category });
    if (tag) andConditions.push({ tags: { has: tag } });

    if (q) {
      andConditions.push({
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { excerpt: { contains: q, mode: "insensitive" } },
          { content: { contains: q, mode: "insensitive" } },
        ],
      });
    }

    const audienceWhere = buildAudienceWhere(userRole, userDepartmentId);
    if (Object.keys(audienceWhere).length > 0) {
      andConditions.push(audienceWhere);
    }

    const where = andConditions.length > 0 ? { AND: andConditions } : {};

    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      prisma.resource.findMany({
        where,
        select: listSelect,
        // Pinned arriba, despues por ultima actualizacion.
        orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
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
   * Solo devuelve borradores a admins. Aplica filtro de audiencia: si el
   * recurso tiene audiencia y el usuario no es de un sector incluido (y
   * no es ADMIN/AGENT), devolvemos 404 (no revelamos existencia).
   */
  static async getOne(
    idOrSlug: string,
    userRole: UserRole,
    userDepartmentId: string | null | undefined,
  ) {
    const looksLikeCuid = /^c[0-9a-z]{24}$/i.test(idOrSlug);

    const resource = await prisma.resource.findFirst({
      where: looksLikeCuid ? { id: idOrSlug } : { slug: idOrSlug },
      include: {
        author: { select: { id: true, name: true, email: true } },
        audienceDepartments: {
          select: { id: true, name: true, color: true, icon: true },
        },
      },
    });

    if (!resource) {
      throw new ApiError("RESOURCE_NOT_FOUND", "Recurso no encontrado", 404);
    }

    if (!resource.isPublished && userRole !== UserRole.ADMIN) {
      // No revelar la existencia del borrador a no-admins.
      throw new ApiError("RESOURCE_NOT_FOUND", "Recurso no encontrado", 404);
    }

    if (!isResourceVisible(resource, userRole, userDepartmentId)) {
      // No revelar existencia: el USER no es del sector que puede ver esto.
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

    const audienceIds = data.audienceDepartmentIds ?? [];

    const resource = await prisma.resource.create({
      data: {
        slug,
        title: data.title,
        content: data.content,
        excerpt: data.excerpt ?? null,
        category: data.category,
        tags: data.tags,
        isPublished: data.isPublished,
        isPinned: data.isPinned,
        showAsModal: data.showAsModal ?? false,
        pinExpiresAt: parsePinExpiresAt(data.pinExpiresAt) ?? null,
        authorId,
        ...(audienceIds.length > 0
          ? {
              audienceDepartments: {
                connect: audienceIds.map((id) => ({ id })),
              },
            }
          : {}),
      },
      include: {
        author: { select: { id: true, name: true, email: true } },
        audienceDepartments: {
          select: { id: true, name: true, color: true, icon: true },
        },
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

    // Normalizar pinExpiresAt si vino en el payload.
    const { audienceDepartmentIds: rawAudience, ...rest } = data as any;
    const updateData: any = { ...rest };
    if (Object.prototype.hasOwnProperty.call(data, "pinExpiresAt")) {
      const parsed = parsePinExpiresAt(data.pinExpiresAt);
      if (parsed !== undefined) updateData.pinExpiresAt = parsed;
    }
    // Si vino audienceDepartmentIds, hacemos un `set` (reemplazo total).
    // Si es undefined, no tocamos la audiencia.
    if (Array.isArray(rawAudience)) {
      updateData.audienceDepartments = {
        set: rawAudience.map((aid: string) => ({ id: aid })),
      };
    }

    const resource = await prisma.resource.update({
      where: { id },
      data: {
        ...updateData,
        ...(nextSlug ? { slug: nextSlug } : {}),
      },
      include: {
        author: { select: { id: true, name: true, email: true } },
        audienceDepartments: {
          select: { id: true, name: true, color: true, icon: true },
        },
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
   * Sube una imagen a Cloudinary para que sea referenciada desde el markdown
   * de un recurso. No persistimos nada en DB en este MVP — la imagen vive
   * solo en Cloudinary y se referencia por URL desde el contenido.
   *
   * Valida MIME estricto (jpeg/png/webp/gif). El size limit lo hace multer.
   */
  static async uploadImage(
    buffer: Buffer,
    mimetype: string,
    originalName: string,
  ): Promise<{ url: string; publicId: string }> {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimetype)) {
      throw new ApiError(
        "INVALID_FILE_TYPE",
        `Tipo de archivo no soportado: ${mimetype}. Solo se aceptan JPEG, PNG, WEBP y GIF.`,
        400,
      );
    }

    const publicId = buildImagePublicId(originalName);

    const uploaded = await new Promise<{
      secure_url: string;
      public_id: string;
    }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "resources",
          resource_type: "image",
          public_id: publicId,
        },
        (error, result) => {
          if (error) return reject(error);
          if (!result) return reject(new Error("Cloudinary devolvió un resultado vacío"));
          resolve({
            secure_url: result.secure_url,
            public_id: result.public_id,
          });
        },
      );
      streamifier.createReadStream(buffer).pipe(stream);
    }).catch((err) => {
      const message = (err as Error)?.message ?? String(err);
      logger.error({ err, originalName, mimetype }, "Cloudinary image upload failed");
      throw new ApiError(
        "IMAGE_UPLOAD_FAILED",
        `No se pudo subir la imagen: ${message}`,
        502,
      );
    });

    logger.info(
      { publicId: uploaded.public_id, mimetype },
      "Resource image uploaded",
    );
    return { url: uploaded.secure_url, publicId: uploaded.public_id };
  }

  /**
   * Devuelve los recursos publicados y pineados que NO son modal y cuyo
   * pin no esta vencido. Pensado para el banner del dashboard.
   * Si se pasa `category`, filtra (ej: solo ANNOUNCEMENT). Acepta `limit`.
   */
  static async getPinned(
    category: string | undefined,
    limit: number,
    userRole: UserRole,
    userDepartmentId: string | null | undefined,
  ) {
    const now = new Date();
    const audienceWhere = buildAudienceWhere(userRole, userDepartmentId);
    const andConditions: any[] = [
      {
        isPinned: true,
        isPublished: true,
        showAsModal: false,
        // pinExpiresAt = null (no vence) o > ahora (todavia activo)
        OR: [{ pinExpiresAt: null }, { pinExpiresAt: { gt: now } }],
      },
    ];
    if (category) andConditions.push({ category: category as any });
    if (Object.keys(audienceWhere).length > 0) andConditions.push(audienceWhere);

    return prisma.resource.findMany({
      where: { AND: andConditions },
      select: listSelect,
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
    });
  }

  /**
   * Devuelve los recursos pineados que deben mostrarse como modal flotante
   * al entrar a la app. Filtra publicados, pinned activos (no vencidos) y
   * con showAsModal=true. Orden: mas recientes primero.
   */
  /**
   * Devuelve recursos dirigidos específicamente al sector del usuario
   * (su departmentId aparece en audienceDepartments). Excluye públicos
   * (esos ya aparecen en banners/listados generales) y modales (esos
   * tienen su propio canal). Pensado para el panel "Para tu sector" del
   * dashboard.
   *
   * Si el usuario no tiene sector asignado, devuelve [].
   */
  static async getForMyDepartment(
    userDepartmentId: string | null | undefined,
    limit: number = 5,
  ) {
    if (!userDepartmentId) return [];
    const now = new Date();
    return prisma.resource.findMany({
      where: {
        isPublished: true,
        showAsModal: false,
        // El pin (si tiene) no debe estar vencido. Si no es pinned, ignora.
        OR: [
          { isPinned: false },
          { pinExpiresAt: null },
          { pinExpiresAt: { gt: now } },
        ],
        audienceDepartments: {
          some: { id: userDepartmentId },
        },
      },
      select: listSelect,
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
    });
  }

  static async getModalPinned(
    userRole: UserRole,
    userDepartmentId: string | null | undefined,
    limit: number = 10,
  ) {
    const now = new Date();
    const audienceWhere = buildAudienceWhere(userRole, userDepartmentId);
    const andConditions: any[] = [
      {
        isPinned: true,
        isPublished: true,
        showAsModal: true,
        OR: [{ pinExpiresAt: null }, { pinExpiresAt: { gt: now } }],
      },
    ];
    if (Object.keys(audienceWhere).length > 0) andConditions.push(audienceWhere);

    return prisma.resource.findMany({
      where: { AND: andConditions },
      select: listSelect,
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
    });
  }

  /**
   * Sugerencias contextuales. Pensado para invocar desde NewTicket
   * mientras el usuario tipea el título: si hay artículos relevantes
   * se los muestra antes de que abra el ticket.
   *
   * Estrategia simple: split del query en palabras, scoring por matches
   * en title (peso 3), excerpt (2), tags (2), content (1).
   */
  static async suggest(
    q: string,
    limit: number,
    userRole: UserRole,
    userDepartmentId: string | null | undefined,
  ) {
    const terms = q
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 6);

    if (terms.length === 0) return [];

    // Trae candidatos que matcheen al menos una palabra. El scoring lo
    // hacemos en memoria sobre un subset acotado.
    const audienceWhere = buildAudienceWhere(userRole, userDepartmentId);
    const andConditions: any[] = [
      { isPublished: true },
      {
        OR: terms.flatMap((term) => [
          { title: { contains: term, mode: "insensitive" as const } },
          { excerpt: { contains: term, mode: "insensitive" as const } },
          { content: { contains: term, mode: "insensitive" as const } },
          { tags: { has: term } },
        ]),
      },
    ];
    if (Object.keys(audienceWhere).length > 0) andConditions.push(audienceWhere);

    const candidates = await prisma.resource.findMany({
      where: { AND: andConditions },
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

// Construye un public_id seguro para Cloudinary a partir del filename
// original (mismo criterio que AttachmentsService.buildCloudinaryPublicId,
// pero sin la dependencia para mantener bajo acoplamiento entre modulos).
function buildImagePublicId(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  const base = lastDot > 0 ? fileName.substring(0, lastDot) : fileName;

  // Quitar diacriticos.
  const decomposed = base.normalize("NFD").replace(/[̀-ͯ]/g, "");

  let slug = decomposed.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_");
  slug = slug.replace(/^_+|_+$/g, "");
  if (!slug) slug = "imagen";
  if (slug.length > 80) slug = slug.substring(0, 80);

  return `${Date.now()}-${slug}`;
}
