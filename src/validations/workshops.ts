import { z } from "zod";

export const importWorkshopsSchema = z.object({
  sheetUrl: z
    .string()
    .url("La URL del sheet es inválida")
    .refine(
      (v) => v.includes("docs.google.com/spreadsheets"),
      "Debe ser una URL de Google Sheets",
    ),
  mode: z.enum(["weekly", "monthly", "upcoming"]),
  dryRun: z.boolean().optional().default(false),
});

export const createRuleSchema = z.object({
  departmentId: z.string().cuid("ID de sector inválido"),
  mercadoEquals: z.string().max(120).optional().nullable(),
  keywords: z
    .array(z.string().min(1).max(120))
    .max(50, "Demasiadas keywords")
    .default([]),
  whyText: z.string().max(500).optional().nullable(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(0),
});

export const updateRuleSchema = createRuleSchema.partial();

export type ImportWorkshopsRequest = z.infer<typeof importWorkshopsSchema>;
export type CreateRuleRequest = z.infer<typeof createRuleSchema>;
export type UpdateRuleRequest = z.infer<typeof updateRuleSchema>;
