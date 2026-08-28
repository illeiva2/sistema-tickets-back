import { z } from "zod";

const sourceEnum = z.enum(["GLUTOMATIC", "NIR", "FN"]);

const parameterSchema = z.object({
  code: z.string().min(1).max(40),
  value: z.number().finite(),
  unit: z.string().max(16).nullish(),
});

const measurementSchema = z.object({
  /** PK del registro en el origen. Es la identidad; nunca se deriva de la fecha. */
  sourceId: z.string().min(1).max(60),
  instrumentSerial: z.string().max(64).nullish(),
  productCode: z.string().max(40).nullish(),
  sampleRef: z.string().max(80).nullish(),
  analyzedAt: z.string().datetime({ offset: true }),
  params: z.array(parameterSchema).max(40),
});

/**
 * Lote acotado a 500: con ~20-40 mediciones por día el caso normal son unidades,
 * y el tope solo importa durante el backfill histórico. Un lote más grande
 * arriesga el timeout de Render sin ganar nada.
 */
export const ingestBatchSchema = z.object({
  body: z.object({
    source: sourceEnum,
    measurements: z.array(measurementSchema).min(1).max(500),
    /** Cursor del origen hasta donde llega este lote. Se avanza recién al terminar bien. */
    cursorId: z.string().max(60).optional(),
  }),
});

export const heartbeatSchema = z.object({
  body: z.object({
    source: sourceEnum,
    /** false = el agente vive pero no puede leer el SQL de la planta. */
    sqlReachable: z.boolean(),
    agentVersion: z.string().max(40).nullish(),
    lastSourceRowAt: z.string().datetime({ offset: true }).nullish(),
    pendingCount: z.number().int().min(0).max(1_000_000).optional(),
    lastErrorCode: z.string().max(60).nullish(),
    cursorId: z.string().max(60).nullish(),
  }),
});

/**
 * Resumen diario calculado en el origen. 60 días es holgado para cubrir el
 * horizonte en que una corrección retroactiva sigue siendo plausible.
 */
export const reconcileSchema = z.object({
  body: z.object({
    source: sourceEnum,
    days: z
      .array(
        z.object({
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          count: z.number().int().min(0),
          valueSum: z.number().finite(),
        }),
      )
      .min(1)
      .max(60),
  }),
});

export type IngestBatchBody = z.infer<typeof ingestBatchSchema>["body"];
export type HeartbeatBody = z.infer<typeof heartbeatSchema>["body"];
