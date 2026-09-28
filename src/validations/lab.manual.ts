import { z } from "zod";
import { MANUAL_PARAM_BY_CODE } from "../lib/labAnalysisColumns";

/**
 * Un análisis cargado a mano: valores por código (los del catálogo de análisis
 * manuales) y, opcionalmente, cuándo se hizo. Un valor null = no se midió.
 */

const valores = z
  .record(z.string().max(40), z.number().finite().nullable())
  .superRefine((obj, ctx) => {
    let alguno = false;
    for (const [code, v] of Object.entries(obj)) {
      const def = MANUAL_PARAM_BY_CODE.get(code);
      if (!def) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [code], message: `"${code}" no es un análisis manual conocido` });
        continue;
      }
      if (v === null) continue;
      alguno = true;
      if (v < def.min || v > def.max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [code], message: `${def.label}: entre ${def.min} y ${def.max}` });
      }
    }
    if (!alguno) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Cargá al menos un valor" });
  });

const cuerpo = z.object({
  analyzedAt: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(new Date(s).getTime()), "fecha inválida")
    .optional(),
  values: valores,
});

const conId = z.object({ id: z.string().min(1) });

export const createManualSchema = z.object({ params: conId, body: cuerpo });
export const updateManualSchema = z.object({ params: conId, body: cuerpo });

export type ManualBody = z.infer<typeof cuerpo>;
