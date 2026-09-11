import { z } from "zod";

/**
 * Asistente de laboratorio. Dos poblaciones: usuarios (preguntan) y el relé
 * del molino (trae los turnos del modelo). Lo que viene del relé se acota en
 * forma y tamaño aunque sea "nuestro": un modelo puede devolver cualquier cosa.
 */

export const askSchema = z.object({
  body: z.object({
    question: z.string().trim().min(2, "Escribí una pregunta").max(1000),
    /** Turnos anteriores de la misma conversación, limpios (sin herramientas). */
    history: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
      .max(12)
      .optional(),
  }),
});

export const nextJobSchema = z.object({
  query: z.object({
    /** Segundos de long-poll. El backend corta a los 25 aunque pidan más. */
    wait: z.coerce.number().int().min(0).max(25).optional(),
    model: z.string().max(80).optional(),
    version: z.string().max(40).optional(),
    gpu: z.enum(["0", "1", "true", "false"]).optional(),
  }),
});

const toolCall = z.object({
  function: z.object({
    name: z.string().min(1).max(60),
    arguments: z.union([z.record(z.string(), z.unknown()), z.string().max(4000)]),
  }),
});

export const jobResultSchema = z.object({
  params: z.object({ id: z.string().min(1).max(40) }),
  body: z
    .object({
      message: z
        .object({
          role: z.string().max(20).optional(),
          content: z.string().max(20_000).nullish(),
          tool_calls: z.array(toolCall).max(10).optional(),
        })
        .optional(),
      error: z.string().max(2000).optional(),
      model: z.string().max(80).optional(),
      durationMs: z.number().int().nonnegative().optional(),
      doneReason: z.string().max(40).optional(),
      usage: z
        .object({
          promptTokens: z.number().int().nullish(),
          completionTokens: z.number().int().nullish(),
        })
        .optional(),
    })
    .refine((b) => b.message !== undefined || b.error !== undefined, {
      message: "Hace falta message o error",
    }),
});

export type AskBody = z.infer<typeof askSchema>["body"];
export type JobResultBodyInput = z.infer<typeof jobResultSchema>["body"];
