import { z } from "zod";

// Hex color: "#RGB", "#RRGGBB" o "#RRGGBBAA" (opcional).
const hexColorRegex = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

export const createDepartmentSchema = z.object({
  name: z
    .string()
    .min(2, "Nombre muy corto")
    .max(60, "Nombre muy largo"),
  color: z
    .string()
    .regex(hexColorRegex, "Color debe ser un hex válido (#RGB / #RRGGBB)")
    .optional()
    .nullable(),
  icon: z.string().max(40).optional().nullable(),
});

export const updateDepartmentSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  color: z
    .string()
    .regex(hexColorRegex, "Color debe ser un hex válido (#RGB / #RRGGBB)")
    .optional()
    .nullable(),
  icon: z.string().max(40).optional().nullable(),
});

export type CreateDepartmentRequest = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentRequest = z.infer<typeof updateDepartmentSchema>;
