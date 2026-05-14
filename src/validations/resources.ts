import { z } from "zod";

export const RESOURCE_CATEGORIES = [
  "HOW_TO",
  "POLICY",
  "FAQ",
  "ANNOUNCEMENT",
  "GLOSSARY",
  "LINK",
  "OTHER",
] as const;

export const createResourceSchema = z.object({
  title: z.string().min(3, "Título muy corto").max(200, "Título muy largo"),
  content: z
    .string()
    .min(1, "Contenido requerido")
    .max(100000, "Contenido demasiado largo"),
  excerpt: z.string().max(500).optional().nullable(),
  category: z
    .enum(RESOURCE_CATEGORIES, {
      errorMap: () => ({ message: "Categoría inválida" }),
    })
    .default("OTHER"),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  isPublished: z.boolean().default(false),
  isPinned: z.boolean().default(false),
  showAsModal: z.boolean().default(false),
  pinExpiresAt: z
    .union([z.string().datetime(), z.literal(""), z.null()])
    .optional()
    .nullable(),
  // Lista de departmentId que pueden ver el recurso. Si está vacío o
  // ausente, es público (visible para todos).
  audienceDepartmentIds: z
    .array(z.string().cuid("ID de sector inválido"))
    .max(20, "Demasiados sectores")
    .optional()
    .default([]),
});

export const updateResourceSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  content: z.string().min(1).max(100000).optional(),
  excerpt: z.string().max(500).optional().nullable(),
  category: z.enum(RESOURCE_CATEGORIES).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  isPublished: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  showAsModal: z.boolean().optional(),
  pinExpiresAt: z
    .union([z.string().datetime(), z.literal(""), z.null()])
    .optional()
    .nullable(),
  audienceDepartmentIds: z
    .array(z.string().cuid("ID de sector inválido"))
    .max(20)
    .optional(),
});

export const pinnedFiltersSchema = z.object({
  category: z.enum(RESOURCE_CATEGORIES).optional(),
  limit: z.coerce.number().min(1).max(20).default(5),
});

export const resourceFiltersSchema = z.object({
  q: z.string().optional(),
  category: z.enum(RESOURCE_CATEGORIES).optional(),
  tag: z.string().optional(),
  includeDrafts: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
});

export const suggestSchema = z.object({
  q: z.string().min(2, "Mínimo 2 caracteres").max(200),
  limit: z.coerce.number().min(1).max(10).default(5),
});

export type CreateResourceRequest = z.infer<typeof createResourceSchema>;
export type UpdateResourceRequest = z.infer<typeof updateResourceSchema>;
export type ResourceFilters = z.infer<typeof resourceFiltersSchema>;
