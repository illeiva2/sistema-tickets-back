import { z } from "zod";

/**
 * Registro de muestras. Los valores de la ficha (`fields`) NO se validan acá:
 * su esquema vive en la base (LabSampleFieldDef, configurable por tipo), así
 * que zod solo garantiza la forma del sobre y el service valida el contenido
 * contra las definiciones vigentes.
 */

const siteEnum = z.enum(["MOLINO", "ACOPIO"]);
const fieldTypeEnum = z.enum(["TEXT", "NUMBER", "SELECT", "DATETIME", "BOOLEAN"]);

/** Clave estable de un campo: snake_case, empieza con letra. Se guarda en el JSON de cada muestra. */
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "clave inválida (snake_case, 2 a 40 caracteres)");

const fieldsRecord = z.record(z.string().max(40), z.unknown());

export const createSampleSchema = z.object({
  body: z.object({
    kindId: z.string().min(1).max(40),
    site: siteEnum,
    /** Momento de la toma. Ausente = ahora. */
    sampledAt: z.string().datetime({ offset: true }).optional(),
    fields: fieldsRecord.default({}),
    notes: z.string().max(2000).nullish(),
  }),
});

export const updateSampleSchema = z.object({
  params: z.object({ id: z.string().min(1).max(40) }),
  body: z.object({
    sampledAt: z.string().datetime({ offset: true }).optional(),
    /** Reemplaza el juego completo de valores: el formulario siempre manda todos. */
    fields: fieldsRecord.optional(),
    notes: z.string().max(2000).nullish(),
  }),
});

const fieldDefBase = {
  label: z.string().min(1).max(80),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(80)).max(100).optional(),
  inName: z.boolean().optional(),
  namePrefix: z.string().max(20).nullish(),
  placeholder: z.string().max(80).nullish(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  /** El campo describe una alteración de la muestra: presente = advertencia. */
  isCondition: z.boolean().optional(),
  /** Para listas: qué opciones cuentan como alteración. null = cualquier valor. */
  conditionValues: z.array(z.string().min(1).max(80)).max(100).nullish(),
  /** Se pide solo cuando otro campo del tipo vale alguna de estas opciones. null = siempre. */
  visibleWhen: z
    .object({ field: fieldKey, values: z.array(z.string().min(1).max(80)).min(1).max(30) })
    .nullish(),
  /** TEXT: regex anclada que debe cumplir el valor. Tiene que compilar. */
  pattern: z
    .string()
    .max(200)
    .nullish()
    .refine(
      (p) => {
        if (!p) return true;
        try {
          new RegExp(p, "u");
          return true;
        } catch {
          return false;
        }
      },
      { message: "expresión regular inválida" },
    ),
  patternHint: z.string().max(120).nullish(),
  /** BOOLEAN: al marcarse pide un porcentaje. */
  withPercent: z.boolean().optional(),
  /** TEXT: sugerir valores ya cargados. */
  suggest: z.boolean().optional(),
  /** TEXT: guardar en mayúsculas. */
  uppercase: z.boolean().optional(),
};

export const createFieldDefSchema = z.object({
  params: z.object({ kindId: z.string().min(1).max(40) }),
  body: z.object({
    key: fieldKey,
    type: fieldTypeEnum,
    ...fieldDefBase,
  }),
});

/**
 * `key` y `type` no se editan: las muestras ya cargadas guardan valores bajo esa
 * clave y con ese tipo. Para cambiar de tipo se desactiva el campo y se crea otro.
 */
export const updateFieldDefSchema = z.object({
  params: z.object({ id: z.string().min(1).max(40) }),
  body: z.object({
    ...fieldDefBase,
    isActive: z.boolean().optional(),
  }),
});

export type CreateSampleBody = z.infer<typeof createSampleSchema>["body"];
export type UpdateSampleBody = z.infer<typeof updateSampleSchema>["body"];
export type CreateFieldDefBody = z.infer<typeof createFieldDefSchema>["body"];
export type UpdateFieldDefBody = z.infer<typeof updateFieldDefSchema>["body"];
