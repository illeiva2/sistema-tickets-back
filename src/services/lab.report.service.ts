import type { LabSource } from "@prisma/client";
import { prisma } from "../lib/database";

/**
 * Reporte de análisis diario del molino (el formato M.M.LC.P.02 que hoy se
 * llena a mano): filas = turno × producto, columnas = los análisis de los
 * cinco equipos, un promedio por celda.
 *
 * Se arma desde las MEDICIONES del día, no solo desde las muestras
 * registradas: así sirve hoy, con lo que hay, y mejora solo a medida que las
 * muestras se registran y enlazan. El producto sale, en orden de confianza:
 * 1) de la muestra registrada enlazada (campo "producto");
 * 2) del código de producto del equipo (el NIR nombra la harina como la vende
 *    el molino: "Harina 000" es la 3/0);
 * 3) del texto libre que el operario tipeó como nombre de muestra.
 * Lo que no se reconoce va a "Sin identificar", visible, no escondido.
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

export interface ColumnaReporte {
  code: string;
  source: LabSource;
  label: string;
  unit?: string;
  decimals: number;
}

/** Columnas en el orden de la planilla. `code` tal como lo guarda cada equipo. */
export const COLUMNAS: ColumnaReporte[] = [
  { code: "Humedad AsIs", source: "NIR", label: "Humedad NIR", unit: "%", decimals: 1 },
  { code: "Cenizas DryBasis", source: "NIR", label: "Cenizas NIR", unit: "%", decimals: 2 },
  { code: "Proteína DryBasis", source: "NIR", label: "Proteína NIR", unit: "%", decimals: 1 },
  { code: "Gluten Húmedo Fixed", source: "NIR", label: "Gluten NIR", unit: "%", decimals: 1 },
  { code: "Falling Number", source: "FN", label: "Falling Number", unit: "s", decimals: 0 },
  { code: "Gluten húmedo", source: "GLUTOMATIC", label: "Gluten húmedo", unit: "%", decimals: 1 },
  { code: "Índice de gluten", source: "GLUTOMATIC", label: "Índice", decimals: 0 },
  { code: "Gluten seco", source: "GLUTOMATIC", label: "Gluten seco", unit: "%", decimals: 1 },
  { code: "Almidón dañado (UCD)", source: "SDMATIC", label: "Almidón dañado", unit: "UCD", decimals: 1 },
  { code: "W", source: "ALVEOLAB", label: "W", decimals: 0 },
  { code: "P", source: "ALVEOLAB", label: "P", decimals: 0 },
  { code: "L", source: "ALVEOLAB", label: "L", decimals: 0 },
  { code: "P/L", source: "ALVEOLAB", label: "P/L", decimals: 2 },
  { code: "Ie", source: "ALVEOLAB", label: "Ie", unit: "%", decimals: 1 },
];

const claveColumna = (source: string, code: string) => `${source}|${code}`;
const COLUMNAS_POR_CLAVE = new Map(COLUMNAS.map((c) => [claveColumna(c.source, c.code), c]));

const horaPlanta = (d: Date): number =>
  Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ_PLANTA, hour: "numeric", hourCycle: "h23" }).format(d),
  );

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
  return j === -1 ? 900 : 100 + j;
};

const esSoloFecha = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export class LabReportService {
  /**
   * Reporte del día `fecha` (YYYY-MM-DD de planta): desde las 22:00 del día
   * anterior hasta las 22:00 de ese día, como la planilla.
   */
  static async diario(fechaPedida?: string) {
    const fecha = fechaPedida && esSoloFecha(fechaPedida) ? fechaPedida : fechaPlantaHoy();
    const fin = new Date(`${fecha}T22:00:00.000${OFFSET_PLANTA}`);
    const inicio = new Date(fin.getTime() - 24 * 60 * 60 * 1000);

    const mediciones = await prisma.labMeasurement.findMany({
      where: { deletedAt: null, analyzedAt: { gte: inicio, lt: fin } },
      include: {
        params: true,
        sample: { select: { accession: true, fields: true, kind: { select: { code: true } } } },
      },
      orderBy: { analyzedAt: "asc" },
    });

    interface Fila {
      turno: number;
      producto: string;
      measurements: number;
      muestras: Set<string>;
      celdas: Map<string, { suma: number; n: number }>;
    }
    const filas = new Map<string, Fila>();

    for (const m of mediciones) {
      const turno = indiceTurno(horaPlanta(m.analyzedAt));
      const campos = (m.sample?.fields ?? null) as Record<string, unknown> | null;
      const producto = productoDe(campos?.producto, m.productCode, m.sampleRef);
      const clave = `${turno}|${producto}`;
      const fila = filas.get(clave) ?? {
        turno,
        producto,
        measurements: 0,
        muestras: new Set<string>(),
        celdas: new Map(),
      };
      fila.measurements++;
      if (m.sample?.accession) fila.muestras.add(m.sample.accession);
      for (const p of m.params) {
        // Fuera del rango de calibración: se excluye del promedio, igual que en las pestañas.
        if (p.isImplausible) continue;
        const col = COLUMNAS_POR_CLAVE.get(claveColumna(m.source, p.code));
        if (!col) continue;
        const c = fila.celdas.get(col.code) ?? { suma: 0, n: 0 };
        c.suma += p.value;
        c.n++;
        fila.celdas.set(col.code, c);
      }
      filas.set(clave, fila);
    }

    const rows = [...filas.values()]
      .sort((a, b) => a.turno - b.turno || ordenProducto(a.producto) - ordenProducto(b.producto))
      .map((f) => ({
        turno: TURNOS[f.turno],
        producto: f.producto,
        measurements: f.measurements,
        samples: [...f.muestras].sort(),
        values: Object.fromEntries(
          [...f.celdas].map(([code, c]) => [code, Math.round((c.suma / c.n) * 1000) / 1000]),
        ) as Record<string, number>,
      }));

    return {
      date: fecha,
      from: inicio,
      to: fin,
      turnos: [...TURNOS],
      columns: COLUMNAS,
      rows,
      totalMeasurements: mediciones.length,
    };
  }
}

export default LabReportService;
