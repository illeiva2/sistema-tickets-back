import { z } from "zod";

/**
 * Preferencias de interfaz del propio usuario. Lo que se guarda es JSON que
 * escribe el navegador, así que se acota en cantidad y tamaño: sin límites,
 * cualquiera podría dejar un blob de megas en su fila.
 */

/** Clave de vista: "lab.analysis-grid". Minúsculas, dígitos, puntos y guiones. */
const viewKey = z.string().regex(/^[a-z][a-z0-9.-]{1,60}$/, "clave de vista inválida");

/** Id de columna: "accession", "f:empresa", "a:NIR|Proteína DryBasis". */
const columnId = z.string().min(1).max(120);

export const savedViewConfigSchema = z
  .object({
    /** Columnas visibles, en orden. */
    columns: z.array(columnId).min(1).max(80),
    sort: z.array(z.object({ id: columnId, desc: z.boolean() })).max(3).optional(),
    widths: z.record(columnId, z.number().int().min(40).max(1200)).optional(),
    density: z.enum(["compact", "normal"]).optional(),
  })
  .strict();

export const saveViewSchema = z.object({
  params: z.object({ viewKey }),
  body: z.object({ config: savedViewConfigSchema }),
});

export const viewKeySchema = z.object({
  params: z.object({ viewKey }),
});

export type SavedViewConfig = z.infer<typeof savedViewConfigSchema>;
