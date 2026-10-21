import { z } from "zod";
import { MANUAL_PARAM_BY_CODE } from "../lib/labAnalysisColumns";
import {
  CENIZAS,
  HUMEDAD_ESTUFA,
  cenizasBaseSeca,
  humedadEstufa,
  humedadParaCenizas,
  normalizarDecimal,
  tieneDatos,
  type CapsulaTexto,
  type CenizasTexto,
  type ManualInput,
} from "../lib/labManual";

/**
 * Un análisis cargado a mano: valores sueltos por código (los del catálogo de
 * análisis manuales), las determinaciones por cápsula de humedad en estufa y de
 * cenizas en mufla y, opcionalmente, cuándo se hizo.
 *
 * Los números llegan como texto, tal como se tipearon ("14,30"), para no perder
 * los decimales; también se aceptan números, que es lo que manda el formulario
 * anterior. Vacío o null = no se midió (no es un cero). Una cápsula puede
 * quedar a medio cargar: los pesos de la balanza primero y el final cuando sale
 * de la estufa o la mufla.
 */

const decimal = z
  .union([z.string().max(24), z.number()])
  .nullish()
  .transform((v, ctx) => {
    const n = normalizarDecimal(v);
    if (n === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Tiene que ser un número" });
      return z.NEVER;
    }
    return n ?? undefined;
  });

const capsula = z.object({
  capsula: z
    .string()
    .trim()
    .max(12, "Hasta 12 caracteres")
    .nullish()
    .transform((v) => v || undefined),
  vacia: decimal,
  muestra: decimal,
  final: decimal,
});

const cenizas = capsula.extend({ humedad: decimal });

/** Los pesos de una cápsula: gramos, con márgenes amplios (hay cápsulas de más de 70 g). */
const RANGOS_PESO: [keyof CapsulaTexto, number, number][] = [
  ["vacia", 0, 500],
  ["muestra", 0, 100],
  ["final", 0, 500],
];

const dosDecimales = (x: number) => x.toFixed(2).replace(".", ",");

const cuerpo = z
  .object({
    analyzedAt: z
      .string()
      .min(1)
      .refine((s) => !Number.isNaN(new Date(s).getTime()), "fecha inválida")
      .optional(),
    values: z.record(z.string().max(40), decimal).default({}),
    humedad: capsula.nullish(),
    cenizas: cenizas.nullish(),
  })
  .superRefine((b, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    let alguno = false;
    for (const [code, v] of Object.entries(b.values)) {
      const def = MANUAL_PARAM_BY_CODE.get(code);
      if (!def) {
        issue(["values", code], `"${code}" no es un análisis manual conocido`);
        continue;
      }
      if (v === undefined) continue;
      alguno = true;
      const n = Number(v);
      if (n < def.min || n > def.max) issue(["values", code], `${def.label}: entre ${def.min} y ${def.max}`);
    }

    for (const [bloque, datos] of [
      ["humedad", b.humedad],
      ["cenizas", b.cenizas],
    ] as const) {
      if (!datos || !tieneDatos(datos)) continue;
      alguno = true;
      for (const [campo, min, max] of RANGOS_PESO) {
        const v = datos[campo];
        if (v === undefined) continue;
        const n = Number(v);
        if (!(n > min && n <= max)) issue([bloque, campo], `Entre ${min} y ${max} g`);
      }
    }
    const humedadCenizas = b.cenizas?.humedad;
    if (humedadCenizas !== undefined && !(Number(humedadCenizas) >= 0 && Number(humedadCenizas) < 100)) {
      issue(["cenizas", "humedad"], "Entre 0 y 100 %");
    }

    // Las cuentas tienen que dar algo posible: si no, hay un peso mal tipeado.
    const humedad = humedadEstufa(b.humedad ?? undefined);
    if (humedad !== null && !(humedad >= 0 && humedad < 100)) {
      issue(["humedad", "final"], `La humedad da ${dosDecimales(humedad)} %: revisá los pesos`);
    }
    const ceniza = cenizasBaseSeca(
      b.cenizas ?? undefined,
      humedadParaCenizas({ humedad: b.humedad ?? undefined, cenizas: b.cenizas ?? undefined }),
    );
    if (ceniza !== null && !(ceniza >= 0 && ceniza <= 100)) {
      issue(["cenizas", "final"], `Las cenizas dan ${dosDecimales(ceniza)} %: revisá los pesos`);
    }

    if (!alguno) issue([], "Cargá al menos un valor");
  })
  .transform((b): { analyzedAt?: string; input: ManualInput } => {
    const values: Record<string, string> = {};
    for (const [code, v] of Object.entries(b.values)) if (v !== undefined) values[code] = v;
    const limpio = <T extends CenizasTexto>(c: T | null | undefined): T | undefined => {
      if (!c || !tieneDatos(c)) return undefined;
      return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as T;
    };
    const humedad = limpio(b.humedad);
    let cenizasTexto = limpio(b.cenizas);
    // Lo calculado con las cápsulas manda: no se guarda además un resultado
    // tipeado para lo mismo, ni la humedad de cenizas si hay humedad de estufa.
    if (humedadEstufa(humedad) !== null) {
      delete values[HUMEDAD_ESTUFA];
      if (cenizasTexto?.humedad !== undefined) cenizasTexto = limpio({ ...cenizasTexto, humedad: undefined });
    }
    if (cenizasBaseSeca(cenizasTexto, humedadParaCenizas({ humedad, cenizas: cenizasTexto })) !== null) {
      delete values[CENIZAS];
    }
    return {
      analyzedAt: b.analyzedAt,
      input: {
        v: 1,
        values,
        ...(humedad ? { humedad } : {}),
        ...(cenizasTexto ? { cenizas: cenizasTexto } : {}),
      },
    };
  });

const conId = z.object({ id: z.string().min(1) });

export const createManualSchema = z.object({ params: conId, body: cuerpo });
export const updateManualSchema = z.object({ params: conId, body: cuerpo });

export type ManualBody = z.infer<typeof cuerpo>;
