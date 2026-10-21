/**
 * Análisis manual con el esquema de la planilla del laboratorio ("R.GCA Análisis
 * Fisico-quimicos"): humedad en estufa y cenizas en mufla, cada una con su
 * cápsula, más los valores sueltos (termobalanza, colorímetro, PMG).
 *
 * Lo tipeado se guarda TAL CUAL en `lab_measurements.manualInput`: los decimales
 * como texto, con los ceros del final, y el número de cápsula. Así la ficha lo
 * muestra y el formulario lo vuelve a abrir sin redondear. Los resultados van
 * además como parámetros numéricos, que es lo que usan la grilla, el reporte
 * diario y el asistente.
 *
 * Las cuentas son las de la planilla:
 *   humedad (%) = (cápsula vacía + muestra − cápsula final) / muestra × 100
 *   cenizas (%, base seca) = (cápsula final − cápsula vacía) / muestra × 100 × 100 / (100 − humedad)
 * La humedad de las cenizas es la de la estufa del mismo análisis; si no hubo
 * estufa, la que se cargue a mano en el bloque de cenizas.
 */

export const HUMEDAD_ESTUFA = "Humedad estufa";
/** Código histórico del resultado de cenizas: ya había cargas con él antes de las cápsulas. */
export const CENIZAS = "Cenizas estufa";

/** Una determinación por cápsula. Los pesos, en gramos y como texto decimal con punto. */
export interface CapsulaTexto {
  /** Número o letra de la cápsula, como la rotulan ("D", "101", "ISO"). */
  capsula?: string;
  /** Cápsula vacía. */
  vacia?: string;
  /** Gramos de muestra pesados. */
  muestra?: string;
  /** Cápsula al salir de la estufa (con la muestra seca) o de la mufla (con las cenizas). */
  final?: string;
}

export interface CenizasTexto extends CapsulaTexto {
  /** % de humedad para la base seca: solo cuenta si no hay humedad de estufa en el análisis. */
  humedad?: string;
}

export interface ManualInput {
  v: 1;
  /** Valores sueltos por código ("Color L" → "89.52"). */
  values: Record<string, string>;
  humedad?: CapsulaTexto;
  cenizas?: CenizasTexto;
}

const DECIMAL = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/;

/**
 * Texto decimal normalizado: sin espacios, con punto, con el cero de adelante
 * si faltaba y sin un punto suelto al final. Conserva los ceros del final
 * ("14,30" → "14.30"): son los decimales con que se midió. Vacío → null; lo que
 * no es un número → undefined. Acepta números por compatibilidad con el
 * formulario anterior, que mandaba números.
 */
export function normalizarDecimal(raw: string | number | null | undefined): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : undefined;
  const t = raw.replace(/\s+/g, "");
  if (t === "") return null;
  if (!DECIMAL.test(t)) return undefined;
  let s = t.replace(",", ".").replace(/^\+/, "");
  if (s.startsWith(".")) s = `0${s}`;
  else if (s.startsWith("-.")) s = `-0${s.slice(1)}`;
  if (s.endsWith(".")) s = s.slice(0, -1);
  return s;
}

const num = (s: string | undefined): number | null => (s === undefined || s === "" ? null : Number(s));

const pesos = (c: CapsulaTexto | undefined) => {
  const vacia = num(c?.vacia);
  const muestra = num(c?.muestra);
  const final = num(c?.final);
  if (vacia === null || muestra === null || final === null || !(muestra > 0)) return null;
  return { vacia, muestra, final };
};

/** Humedad en estufa (%), o null mientras falte algún peso (por ejemplo, el final). */
export function humedadEstufa(c: CapsulaTexto | undefined): number | null {
  const p = pesos(c);
  return p ? ((p.vacia + p.muestra - p.final) / p.muestra) * 100 : null;
}

/** Humedad con la que se pasan las cenizas a base seca: la de la estufa o, si no hubo, la cargada en cenizas. */
export function humedadParaCenizas(input: Pick<ManualInput, "humedad" | "cenizas">): number | null {
  return humedadEstufa(input.humedad) ?? num(input.cenizas?.humedad);
}

/** Cenizas en base seca (%), o null mientras falte algún peso o la humedad. */
export function cenizasBaseSeca(c: CenizasTexto | undefined, humedad: number | null): number | null {
  const p = pesos(c);
  if (!p || humedad === null || !(humedad < 100)) return null;
  return ((p.final - p.vacia) / p.muestra) * 100 * (100 / (100 - humedad));
}

/** Los resultados se guardan con 4 decimales: los pesos se leen al décimo de miligramo. */
const redondear = (x: number): number => Math.round(x * 1e4) / 1e4;

/**
 * Parámetros numéricos del análisis: los valores sueltos y lo calculado con las
 * cápsulas. Si llega un resultado tipeado y además están los pesos, manda la cuenta.
 */
export function parametrosManual(input: ManualInput): { code: string; value: number }[] {
  const out = new Map<string, number>();
  for (const [code, texto] of Object.entries(input.values)) out.set(code, Number(texto));
  const humedad = humedadEstufa(input.humedad);
  if (humedad !== null) out.set(HUMEDAD_ESTUFA, redondear(humedad));
  const cenizas = cenizasBaseSeca(input.cenizas, humedadParaCenizas(input));
  if (cenizas !== null) out.set(CENIZAS, redondear(cenizas));
  return [...out].map(([code, value]) => ({ code, value }));
}

/** ¿Se tipeó algo en la determinación? (aunque sea solo la cápsula, para completarla después) */
export const tieneDatos = (c: CenizasTexto | undefined): boolean =>
  !!c && Object.values(c).some((v) => v !== undefined && v !== "");
