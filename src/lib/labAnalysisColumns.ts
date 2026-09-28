import type { LabSource } from "@prisma/client";

/**
 * Columnas de análisis de la grilla de consulta: un parámetro de un equipo por
 * columna, identificado por `source|code` (el código tal como lo guarda cada
 * instrumento). El catálogo fijo da etiqueta legible, unidad y decimales a los
 * parámetros que el laboratorio lee todos los días; lo que llegue con un código
 * nuevo se muestra igual, con su código como etiqueta, para que un parámetro
 * que un equipo empiece a mandar mañana no quede invisible hasta tocar código.
 */

export interface AnalysisColumn {
  /** `source|code`. Es la clave de `values` en cada fila y el id de columna que guarda la vista. */
  key: string;
  source: LabSource;
  code: string;
  label: string;
  unit?: string;
  decimals: number;
}

export const analysisKey = (source: string, code: string): string => `${source}|${code}`;

const col = (
  source: LabSource,
  code: string,
  label: string,
  decimals: number,
  unit?: string,
): AnalysisColumn => ({ key: analysisKey(source, code), source, code, label, decimals, unit });

/**
 * Análisis que se hacen con equipos sin conexión (termobalanza, estufa,
 * colorímetro, balanza) y se cargan a mano desde la ficha de la muestra. Los
 * códigos son fijos: son las columnas del reporte diario en papel
 * (M.M.LC.P.02), y así se llaman también en la grilla y para el asistente.
 */
export interface ManualParam {
  code: string;
  label: string;
  unit?: string;
  decimals: number;
  min: number;
  max: number;
  /** Ayuda corta para el formulario. */
  hint?: string;
}

export const MANUAL_PARAMS: ManualParam[] = [
  { code: "Humedad termobalanza", label: "Humedad (termobalanza)", unit: "%", decimals: 1, min: 0, max: 100 },
  { code: "Cenizas cápsula", label: "Cenizas: cápsula", decimals: 2, min: 0, max: 1000, hint: "Como en la planilla" },
  { code: "Cenizas estufa", label: "Cenizas (estufa)", unit: "%", decimals: 2, min: 0, max: 100 },
  { code: "Cenizas cápsula ensayo", label: "Cenizas: cápsula ensayo", decimals: 2, min: 0, max: 1000, hint: "Como en la planilla" },
  { code: "Color L", label: "Color L", decimals: 1, min: 0, max: 100 },
  { code: "Color a", label: "Color a", decimals: 1, min: -100, max: 100 },
  { code: "Color b", label: "Color b", decimals: 1, min: -100, max: 100 },
  { code: "Peso de mil granos", label: "Peso de mil granos", unit: "g", decimals: 1, min: 0, max: 100, hint: "Solo trigo" },
];

export const MANUAL_PARAM_BY_CODE = new Map(MANUAL_PARAMS.map((p) => [p.code, p]));

/** En el orden del flujo del laboratorio: NIR primero (el análisis general), reología al final. */
export const ANALYSIS_COLUMNS: AnalysisColumn[] = [
  col("NIR", "Humedad AsIs", "Humedad (NIR)", 1, "%"),
  col("NIR", "Proteína DryBasis", "Proteína (NIR, b.s.)", 1, "%"),
  col("NIR", "Gluten Húmedo Fixed", "Gluten húmedo (NIR)", 1, "%"),
  col("NIR", "Cenizas DryBasis", "Cenizas (NIR, b.s.)", 2, "%"),
  col("NIR", "Peso específico", "Peso específico (NIR)", 1, "kg/hl"),
  col("NIR", "Zeleny Fixed", "Zeleny (NIR)", 0, "ml"),
  col("NIR", "Almidón DryBasis", "Almidón (NIR, b.s.)", 1, "%"),
  col("GLUTOMATIC", "Gluten húmedo", "Gluten húmedo", 1, "%"),
  col("GLUTOMATIC", "Gluten seco", "Gluten seco", 1, "%"),
  col("GLUTOMATIC", "Índice de gluten", "Índice de gluten", 0),
  col("GLUTOMATIC", "Capacidad de retención de agua", "Retención de agua", 1, "%"),
  col("FN", "Falling Number", "Falling Number", 0, "s"),
  col("FN", "Índice de licuefacción", "Índice de licuefacción", 0),
  col("SDMATIC", "Almidón dañado (UCD)", "Almidón dañado", 1, "UCD"),
  col("SDMATIC", "Almidón dañado corregido (UCDc)", "Almidón dañado corr.", 1, "UCDc"),
  col("SDMATIC", "Absorción de yodo", "Absorción de yodo", 1, "%"),
  col("ALVEOLAB", "W", "W", 0, "10⁻⁴ J"),
  col("ALVEOLAB", "P", "P", 0, "mm"),
  col("ALVEOLAB", "L", "L", 0, "mm"),
  col("ALVEOLAB", "P/L", "P/L", 2),
  col("ALVEOLAB", "Ie", "Ie", 1, "%"),
  col("ALVEOLAB", "G", "G", 1),
  ...MANUAL_PARAMS.map((p) => col("MANUAL", p.code, p.label, p.decimals, p.unit)),
];

const CATALOGO = new Map(ANALYSIS_COLUMNS.map((c) => [c.key, c]));

/** Lo mínimo de una medición para agregarla: de qué equipo es y sus parámetros. */
export interface LecturaAgregable {
  source: LabSource;
  params: { code: string; value: number; isImplausible: boolean; unit: string | null }[];
}

export interface AnalisisAgregados {
  /** Un valor por `source|code`: promedio de las lecturas plausibles (o de todas, si ninguna lo es). */
  values: Record<string, number>;
  /** Claves cuyo valor sale SOLO de lecturas fuera de calibración: se muestra, marcado. */
  implausible: string[];
  /** Cuántas mediciones aportó cada equipo. */
  counts: Partial<Record<LabSource, number>>;
  /** Unidad vista por clave, para etiquetar parámetros que no están en el catálogo. */
  units: Record<string, string>;
}

const redondear = (n: number) => Math.round(n * 1000) / 1000;
const promedio = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Colapsa las mediciones de UNA muestra a un valor por parámetro.
 *
 * Promedio y no "la última" a propósito: el FN corre dos canales de la misma
 * muestra y una prueba se repite; el laboratorio informa el promedio, y es el
 * mismo criterio que usa el reporte diario. Las lecturas fuera de calibración
 * quedan afuera del promedio salvo que sean las únicas: entonces se promedian
 * igual y la clave se marca, porque esconder el dato haría creer que el
 * análisis no se hizo.
 */
export const aggregateAnalyses = (lecturas: LecturaAgregable[]): AnalisisAgregados => {
  const plausibles = new Map<string, number[]>();
  const dudosas = new Map<string, number[]>();
  const counts: Partial<Record<LabSource, number>> = {};
  const units: Record<string, string> = {};

  for (const m of lecturas) {
    counts[m.source] = (counts[m.source] ?? 0) + 1;
    for (const p of m.params) {
      if (!Number.isFinite(p.value)) continue;
      const k = analysisKey(m.source, p.code);
      const destino = p.isImplausible ? dudosas : plausibles;
      destino.set(k, [...(destino.get(k) ?? []), p.value]);
      if (p.unit && !units[k]) units[k] = p.unit;
    }
  }

  const values: Record<string, number> = {};
  const implausible: string[] = [];
  for (const [k, xs] of plausibles) values[k] = redondear(promedio(xs));
  for (const [k, xs] of dudosas) {
    if (k in values) continue;
    values[k] = redondear(promedio(xs));
    implausible.push(k);
  }
  return { values, implausible: implausible.sort(), counts, units };
};

/**
 * Columnas a ofrecer: el catálogo completo (aunque hoy ninguna fila tenga el
 * dato, para que el usuario pueda elegirlo) más cualquier clave vista en los
 * datos que el catálogo no conozca, etiquetada con su código.
 */
export const columnsFor = (vistas: Map<string, string | null | undefined>): AnalysisColumn[] => {
  const conocidas = ANALYSIS_COLUMNS.map((c) => ({ ...c, unit: c.unit ?? vistas.get(c.key) ?? undefined }));
  const extra: AnalysisColumn[] = [];
  for (const [key, unit] of vistas) {
    if (CATALOGO.has(key)) continue;
    const sep = key.indexOf("|");
    if (sep <= 0) continue;
    extra.push({
      key,
      source: key.slice(0, sep) as LabSource,
      code: key.slice(sep + 1),
      label: key.slice(sep + 1),
      unit: unit ?? undefined,
      decimals: 2,
    });
  }
  extra.sort((a, b) => a.key.localeCompare(b.key));
  return [...conocidas, ...extra];
};
