import type { LabSource } from "@prisma/client";
import { prisma } from "../lib/database";
import { aggregateAnalyses, analysisKey, type LecturaAgregable } from "../lib/labAnalysisColumns";

/**
 * Reporte de análisis diario del molino: el formato M.M.LC.P.02 que se llenaba
 * a mano.
 *
 * Se arma desde las MUESTRAS INTERNAS registradas ese día: un renglón por
 * muestra (turno, hora de la toma, producto, lote) con sus análisis
 * enlazados, los de los equipos y los cargados a mano. La grilla es fija como
 * en el papel: los 15 productos de cada turno aparecen siempre, vacíos si no
 * hubo muestra, porque el hueco también informa (qué no se muestreó). Dos
 * muestras del mismo producto en el turno son dos renglones, no un promedio:
 * la ronda de las 13:00 y la de las 22:00 son datos distintos.
 *
 * Las mediciones del día sin muestra registrada van al final de cada turno,
 * con el producto adivinado del equipo (como se hacía antes del registro),
 * para que nada quede escondido y se vea qué falta registrar.
 */

const TZ_PLANTA = "America/Argentina/Cordoba";
/** Argentina no aplica horario de verano desde 2009: el desfasaje es fijo. */
const OFFSET_PLANTA = "-03:00";

/** El día del reporte arranca con la noche anterior, como en la planilla. */
export const TURNOS = [
  "1° Noche (22:00–06:00)",
  "2° Mañana (07:00–14:00)",
  "3° Tarde (15:00–21:00)",
] as const;

/** Las 15 corrientes del reporte, en su orden. */
export const PRODUCTOS = [
  "Trigo Sucio",
  "Trigo Limpio",
  "Trigo Acondicionado",
  "Primera Rotura",
  "3/0",
  "4/0",
  "Tapera",
  "Semolín",
  "Semita C4",
  "Semita C5",
  "Afrechillo Fino",
  "Afrechillo Grueso",
  "3/0 Embolse",
  "4/0 Embolse",
  "Tapera Embolse",
] as const;

const TRIGO_GENERICO = "Trigo (sin especificar)";
const SIN_IDENTIFICAR = "Sin identificar";
/** Cubos genéricos cuando el texto no alcanza para la corriente exacta. Van después de las 15. */
const ORDEN_EXTRA = [TRIGO_GENERICO, "Semita", "Afrechillo", SIN_IDENTIFICAR];

export type SeccionReporte = "fq" | "reo";

export interface ColumnaReporte {
  /** `source|code`, la misma clave de la grilla de análisis. */
  key: string;
  source: LabSource;
  code: string;
  /** Encabezado de la columna dentro de su grupo ("Termobalanza", "NIR", "L"). */
  label: string;
  /** Encabezado del grupo, como en el papel ("% Humedad", "Gluten", "Alveogramas"). */
  group: string;
  section: SeccionReporte;
  unit?: string;
  decimals: number;
  /** Se carga a mano desde la ficha (equipo sin conexión). */
  manual: boolean;
}

const c = (
  section: SeccionReporte,
  group: string,
  source: LabSource,
  code: string,
  label: string,
  decimals: number,
  unit?: string,
): ColumnaReporte => ({
  key: analysisKey(source, code),
  source,
  code,
  label,
  group,
  section,
  unit,
  decimals,
  manual: source === "MANUAL",
});

/** Columnas en el orden y con los grupos de la planilla. `code` tal como lo guarda cada equipo. */
export const COLUMNAS: ColumnaReporte[] = [
  c("fq", "% Humedad", "MANUAL", "Humedad termobalanza", "Termobalanza", 1, "%"),
  c("fq", "% Humedad", "NIR", "Humedad AsIs", "NIR", 1, "%"),
  c("fq", "% Cenizas", "MANUAL", "Cenizas cápsula", "Cápsula", 2),
  c("fq", "% Cenizas", "MANUAL", "Cenizas estufa", "Estufa", 2, "%"),
  c("fq", "% Cenizas", "MANUAL", "Cenizas cápsula ensayo", "Cápsula ensayo", 2),
  c("fq", "% Cenizas", "NIR", "Cenizas DryBasis", "NIR", 2, "%"),
  c("fq", "% Proteínas", "NIR", "Proteína DryBasis", "NIR", 1, "%"),
  c("fq", "PH", "NIR", "Peso específico", "NIR", 1, "kg/hl"),
  c("fq", "Colorímetro", "MANUAL", "Color L", "L", 1),
  c("fq", "Colorímetro", "MANUAL", "Color a", "a", 1),
  c("fq", "Colorímetro", "MANUAL", "Color b", "b", 1),
  c("fq", "PMG", "MANUAL", "Peso de mil granos", "g", 1, "g"),
  c("fq", "Falling Number", "FN", "Falling Number", "FN", 0, "s"),
  c("fq", "Gluten", "NIR", "Gluten Húmedo Fixed", "NIR", 1, "%"),
  c("fq", "Gluten", "GLUTOMATIC", "Gluten húmedo", "Húmedo", 1, "%"),
  c("fq", "Gluten", "GLUTOMATIC", "Índice de gluten", "Index", 0),
  c("fq", "Gluten", "GLUTOMATIC", "Gluten seco", "Seco", 1, "%"),
  c("fq", "Gluten", "GLUTOMATIC", "Capacidad de retención de agua", "% ReH2O", 1, "%"),
  c("fq", "Almidón", "SDMATIC", "Absorción de yodo", "Ai %", 1, "%"),
  c("fq", "Almidón", "SDMATIC", "Almidón dañado (UCD)", "UCD", 1, "UCD"),
  c("reo", "Alveogramas", "ALVEOLAB", "W", "W", 0),
  c("reo", "Alveogramas", "ALVEOLAB", "P", "P", 0),
  c("reo", "Alveogramas", "ALVEOLAB", "L", "L", 0),
  c("reo", "Alveogramas", "ALVEOLAB", "P/L", "P/L", 2),
  c("reo", "Alveogramas", "ALVEOLAB", "Ie", "Ie", 1, "%"),
];

const CLAVES_REPORTE = new Set(COLUMNAS.map((col) => col.key));

export interface MuestraReporte {
  id: string;
  accession: string;
  sampledAt: Date;
  displayName: string;
}

export interface FilaReporte {
  turno: string;
  producto: string;
  /** Posición en la planilla (0–14); 100+ lo que no está en ella; 200+ mediciones sueltas. */
  orden: number;
  /** Muestra registrada; null en un renglón vacío de la planilla o en mediciones sueltas. */
  sample: MuestraReporte | null;
  /** Hora de planta de la toma (o de la primera medición, si no hay muestra). */
  hora: string | null;
  /** Lote del embolse, o el silo / acoplado de la mezcla en trigo sucio. */
  lote: string | null;
  /** Mediciones del día sin muestra registrada: el producto es el que dice el equipo. */
  sinMuestra: boolean;
  measurements: number;
  /** Un valor por columna (`source|code`): promedio de las lecturas plausibles de ESA muestra. */
  values: Record<string, number>;
  /** Columnas cuyo valor sale solo de lecturas fuera de calibración. */
  implausible: string[];
  /** El Glutomatic no formó gluten (prueba en 0). */
  noLiga: boolean;
}

const horaPlanta = (d: Date): number =>
  Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ_PLANTA, hour: "numeric", hourCycle: "h23" }).format(d),
  );

const horaPlantaTexto = (d: Date): string =>
  new Intl.DateTimeFormat("es-AR", {
    timeZone: TZ_PLANTA,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);

/** 0 noche (22–06), 1 mañana (07–14), 2 tarde (15–21). Los huecos entre turnos van al que arranca. */
export const indiceTurno = (hora: number): number => (hora >= 22 || hora < 7 ? 0 : hora < 15 ? 1 : 2);

/** YYYY-MM-DD de hoy en fecha de planta (en-CA formatea ISO). */
export const fechaPlantaHoy = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ_PLANTA, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );

const normalizar = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase();

/** Del código de producto del equipo. El NIR nombra la harina como la vende el molino. */
const PATRONES_CODIGO: [string, string][] = [
  ["HARINA TAPERA", "Tapera"],
  ["HARINA 0000", "4/0"],
  ["HARINA 000", "3/0"],
  ["SEMOLIN", "Semolín"],
  ["TRIGO", TRIGO_GENERICO],
];

/**
 * Del texto libre que tipeó el operario. Los más específicos primero. Sin
 * "000"/"0000" acá a propósito: en texto libre aparecen en lotes y fechas.
 */
const PATRONES_TEXTO: [string, string][] = [
  ["TAPERA EMBOLSE", "Tapera Embolse"],
  ["3/0 EMBOLSE", "3/0 Embolse"],
  ["4/0 EMBOLSE", "4/0 Embolse"],
  ["TRIGO SUCIO", "Trigo Sucio"],
  ["TRIGO LIMPIO", "Trigo Limpio"],
  ["TRIGO ACOND", "Trigo Acondicionado"],
  ["ROTURA", "Primera Rotura"],
  ["AFRECHILLO FINO", "Afrechillo Fino"],
  ["AFRECHILLO GRUESO", "Afrechillo Grueso"],
  ["SEMITA C4", "Semita C4"],
  ["SEMITA C5", "Semita C5"],
  ["SEMOL", "Semolín"],
  ["TAPERA", "Tapera"],
  ["3/0", "3/0"],
  ["4/0", "4/0"],
  ["AFRECHILLO", "Afrechillo"],
  ["SEMITA", "Semita"],
  ["TRIGO", TRIGO_GENERICO],
];

/** Producto de una medición SIN muestra: del código del equipo o del texto tipeado. */
export const productoDe = (
  productoMuestra: unknown,
  productCode: string | null,
  sampleRef: string | null,
): string => {
  if (typeof productoMuestra === "string" && (PRODUCTOS as readonly string[]).includes(productoMuestra)) {
    return productoMuestra;
  }
  if (productCode) {
    const t = normalizar(productCode);
    for (const [aguja, producto] of PATRONES_CODIGO) if (t.includes(aguja)) return producto;
  }
  if (sampleRef) {
    const t = normalizar(sampleRef);
    for (const [aguja, producto] of PATRONES_TEXTO) if (t.includes(aguja)) return producto;
  }
  return SIN_IDENTIFICAR;
};

const ordenProducto = (p: string): number => {
  const i = (PRODUCTOS as readonly string[]).indexOf(p);
  if (i !== -1) return i;
  const j = ORDEN_EXTRA.indexOf(p);
  return j === -1 ? 150 : 100 + j;
};

const esSoloFecha = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** El turno que eligió el operario ("3° Tarde (15:00–21:00)") manda sobre la hora. */
const turnoDeCampo = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const m = /^\s*([123])/.exec(v);
  return m ? Number(m[1]) - 1 : null;
};

const textoDe = (f: Record<string, unknown>, k: string): string | null => {
  const v = f[k];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/** Lote del embolse; en trigo sucio, de dónde salió (silo o acoplado de la mezcla). */
const loteDe = (f: Record<string, unknown>): string | null => {
  const lote = textoDe(f, "lote");
  if (lote) return lote;
  const silo = textoDe(f, "silo");
  if (silo) return `Silo ${silo}`;
  const acoplado = textoDe(f, "acoplado_mezcla");
  if (acoplado) return `Mezcla acoplado ${acoplado}`;
  return null;
};

const soloReporte = (values: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(values).filter(([k]) => CLAVES_REPORTE.has(k)));

/** Misma regla que la lista de muestras: hay Glutomatic y ningún gluten húmedo > 0. */
const noLigaDe = (ms: LecturaAgregable[]): boolean =>
  ms.some((m) => m.source === "GLUTOMATIC") &&
  !ms.some((m) => m.source === "GLUTOMATIC" && m.params.some((p) => p.code === "Gluten húmedo" && p.value > 0));

const PARAMS_SELECT = { select: { code: true, value: true, unit: true, isImplausible: true } };

export class LabReportService {
  /**
   * Reporte del día `fecha` (YYYY-MM-DD de planta): desde las 22:00 del día
   * anterior hasta las 22:00 de ese día, como la planilla. Una muestra tomada
   * a las 22:00 ya es del turno noche del día siguiente.
   */
  static async diario(fechaPedida?: string) {
    const fecha = fechaPedida && esSoloFecha(fechaPedida) ? fechaPedida : fechaPlantaHoy();
    const fin = new Date(`${fecha}T22:00:00.000${OFFSET_PLANTA}`);
    const inicio = new Date(fin.getTime() - 24 * 60 * 60 * 1000);

    const [muestras, sueltas] = await Promise.all([
      prisma.labSample.findMany({
        where: { deletedAt: null, sampledAt: { gte: inicio, lt: fin }, kind: { code: "INTERNA" } },
        select: {
          id: true,
          accession: true,
          sampledAt: true,
          displayName: true,
          fields: true,
          // Los análisis de la muestra cuentan aunque se hayan corrido después
          // de las 22:00: pertenecen a la toma, no al reloj del equipo.
          measurements: { where: { deletedAt: null }, select: { source: true, params: PARAMS_SELECT } },
        },
        orderBy: { sampledAt: "asc" },
      }),
      prisma.labMeasurement.findMany({
        where: { deletedAt: null, sampleId: null, analyzedAt: { gte: inicio, lt: fin } },
        select: { source: true, analyzedAt: true, productCode: true, sampleRef: true, params: PARAMS_SELECT },
        orderBy: { analyzedAt: "asc" },
      }),
    ]);

    // Un renglón por muestra, agrupado por turno y producto para ubicarlo en la planilla.
    const porClave = new Map<string, FilaReporte[]>();
    let enlazadas = 0;
    for (const s of muestras) {
      const campos = (s.fields ?? {}) as Record<string, unknown>;
      const turno = turnoDeCampo(campos.turno) ?? indiceTurno(horaPlanta(s.sampledAt));
      const producto = textoDe(campos, "producto") ?? SIN_IDENTIFICAR;
      const agg = aggregateAnalyses(s.measurements);
      enlazadas += s.measurements.length;
      const fila: FilaReporte = {
        turno: TURNOS[turno],
        producto,
        orden: ordenProducto(producto),
        sample: { id: s.id, accession: s.accession, sampledAt: s.sampledAt, displayName: s.displayName },
        hora: horaPlantaTexto(s.sampledAt),
        lote: loteDe(campos),
        sinMuestra: false,
        measurements: s.measurements.length,
        values: soloReporte(agg.values),
        implausible: agg.implausible.filter((k) => CLAVES_REPORTE.has(k)),
        noLiga: noLigaDe(s.measurements),
      };
      const clave = `${turno}|${producto}`;
      const lista = porClave.get(clave) ?? [];
      lista.push(fila);
      porClave.set(clave, lista);
    }

    // Mediciones sin muestra: como antes del registro, agrupadas por turno y producto adivinado.
    const sueltasPorClave = new Map<string, { turno: number; producto: string; lecturas: typeof sueltas }>();
    for (const m of sueltas) {
      const turno = indiceTurno(horaPlanta(m.analyzedAt));
      const producto = productoDe(null, m.productCode, m.sampleRef);
      const clave = `${turno}|${producto}`;
      const g = sueltasPorClave.get(clave) ?? { turno, producto, lecturas: [] };
      g.lecturas.push(m);
      sueltasPorClave.set(clave, g);
    }

    const vacia = (t: number, producto: string): FilaReporte => ({
      turno: TURNOS[t],
      producto,
      orden: ordenProducto(producto),
      sample: null,
      hora: null,
      lote: null,
      sinMuestra: false,
      measurements: 0,
      values: {},
      implausible: [],
      noLiga: false,
    });

    const rows: FilaReporte[] = [];
    for (let t = 0; t < TURNOS.length; t++) {
      for (const producto of PRODUCTOS) {
        const lista = porClave.get(`${t}|${producto}`);
        if (lista?.length) rows.push(...lista);
        else rows.push(vacia(t, producto));
      }
      // Productos registrados que no están en la planilla ("Prueba"), por nombre.
      const extras = [...porClave.entries()]
        .filter(([k, v]) => k.startsWith(`${t}|`) && !(PRODUCTOS as readonly string[]).includes(v[0].producto))
        .sort(([a], [b]) => a.localeCompare(b));
      for (const [, lista] of extras) rows.push(...lista);
      // Lo que se midió sin registrar la muestra.
      const sinRegistro = [...sueltasPorClave.values()]
        .filter((g) => g.turno === t)
        .sort((a, b) => ordenProducto(a.producto) - ordenProducto(b.producto));
      for (const g of sinRegistro) {
        const agg = aggregateAnalyses(g.lecturas);
        rows.push({
          turno: TURNOS[t],
          producto: g.producto,
          orden: 200 + ordenProducto(g.producto),
          sample: null,
          hora: horaPlantaTexto(g.lecturas[0].analyzedAt),
          lote: null,
          sinMuestra: true,
          measurements: g.lecturas.length,
          values: soloReporte(agg.values),
          implausible: agg.implausible.filter((k) => CLAVES_REPORTE.has(k)),
          noLiga: false,
        });
      }
    }

    return {
      date: fecha,
      from: inicio,
      to: fin,
      turnos: [...TURNOS],
      columns: COLUMNAS,
      rows,
      totalMeasurements: enlazadas + sueltas.length,
      totalSamples: muestras.length,
    };
  }
}

export default LabReportService;
