import { z } from "zod";

export const PROJECT_STATUSES = [
  "PLANNED",
  "IN_PROGRESS",
  "ON_HOLD",
  "BLOCKED",
  "COMPLETED",
  "CANCELLED",
] as const;

// Acepta string ISO, "" o null para fechas opcionales (vacío = sin fecha).
const dateOrNull = z
  .union([z.string().datetime(), z.string().length(0), z.null()])
  .optional()
  .nullable();

export const createProjectSchema = z.object({
  title: z.string().min(3, "Título muy corto").max(200, "Título muy largo"),
  description: z
    .string()
    .min(1, "Descripción requerida")
    .max(100000, "Descripción demasiado larga"),
  excerpt: z.string().max(500).optional().nullable(),
  status: z.enum(PROJECT_STATUSES).default("PLANNED"),
  progressPercent: z
    .number()
    .int()
    .min(0, "Mínimo 0")
    .max(100, "Máximo 100")
    .optional()
    .nullable(),
  startedAt: dateOrNull,
  expectedEndAt: dateOrNull,
  completedAt: dateOrNull,
  isPublished: z.boolean().default(false),
  isPinned: z.boolean().default(false),
  // ID del lead. Si no se manda, default = current user.
  leadId: z.string().cuid("ID de lead inválido").optional(),
  teamUserIds: z
    .array(z.string().cuid("ID de team inválido"))
    .max(50)
    .optional()
    .default([]),
});

export const updateProjectSchema = createProjectSchema.partial();

export const projectFiltersSchema = z.object({
  q: z.string().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  // Tipo de visibilidad: para ADMIN/AGENT también poder ver drafts.
  includeDrafts: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
});

export type CreateProjectRequest = z.infer<typeof createProjectSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectSchema>;
export type ProjectFilters = z.infer<typeof projectFiltersSchema>;
