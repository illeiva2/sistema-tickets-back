import { z } from "zod";
import { MODULE_KEYS, MODULE_LEVELS } from "../lib/modules";

/**
 * Cuerpo de PUT /api/modules/grants/:userId
 *
 * Se manda el conjunto COMPLETO de modulos que el usuario debe tener. Lo que no
 * viene en la lista queda revocado. Es idempotente: mandar dos veces lo mismo
 * no cambia nada ni pierde la fecha original de la concesion.
 */
export const setUserGrantsSchema = z.object({
  body: z.object({
    modules: z
      .array(
        z.object({
          moduleKey: z.enum(MODULE_KEYS as [string, ...string[]]),
          level: z.enum(MODULE_LEVELS).default("VIEWER"),
        }),
      )
      .max(50),
  }),
  params: z.object({
    userId: z.string().min(1, "userId requerido"),
  }),
});

export type SetUserGrantsBody = z.infer<typeof setUserGrantsSchema>["body"];
