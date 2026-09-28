import type { LabSite, LabSource } from "@prisma/client";
import { ApiError } from "../lib/errors";
import { ANALYSIS_COLUMNS, analysisKey, type AnalysisColumn } from "../lib/labAnalysisColumns";
import LabReportService from "./lab.report.service";
import LabSamplesService, { type FiltrosMuestras } from "./lab.samples.service";
import LabService from "./lab.service";

/**
 * Herramientas del asistente de laboratorio: lo ÚNICO que el modelo puede
 * hacer. Todas son de lectura y devuelven datos ya formateados (etiqueta,
 * unidad, decimales) para que el modelo no tenga que interpretar códigos de
 * instrumento ni redondear. Corren en el backend, con los servicios de
 * siempre: el modelo nunca toca la base ni arma consultas.
 *
 * El formato de las definiciones es el de "function calling" que entiende
 * Ollama (y, de paso, el de OpenAI): si algún día el modelo se reemplaza, las
 * herramientas quedan.
 */

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolResult {
  ok: boolean;
  /** Una línea para la traza que ve el usuario: qué se consultó y cuánto volvió. */
  summary: string;
  /** Lo que se le devuelve al modelo (se serializa a JSON). */
  data: unknown;
}

const FECHA = { type: "string", description: "Fecha de planta en formato YYYY-MM-DD" };
const LABORATORIO = {
  type: "string",
  enum: ["MOLINO", "ACOPIO"],
  description: "MOLINO: muestras internas de proceso. ACOPIO: recepción de camiones de grano.",
};
const TEXTO = {
  type: "string",
  description: "Texto a buscar en el nombre de la muestra: empresa, patente, procedencia, silo, producto…",
};

export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "buscar_muestras",
      description:
        "Lista muestras registradas (las más recientes primero) con su ficha (empresa, patente, acoplado, CTG, silo, producto…), sus alteraciones del grano y el valor de cada análisis. ES LA HERRAMIENTA PARA ENCONTRAR LAS MUESTRAS DE UNA EMPRESA, PERSONA, PATENTE, PROCEDENCIA O LOTE: pasá ese nombre en `texto`. También para listar qué muestras hay en un período.",
      parameters: {
        type: "object",
        properties: {
          desde: FECHA,
          hasta: FECHA,
          laboratorio: LABORATORIO,
          texto: TEXTO,
          solo_con_alteraciones: {
            type: "boolean",
            description: "Solo muestras con alguna alteración del grano (brotado, insectos, olor…)",
          },
          limite: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Máximo de muestras a devolver (por defecto 20)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ficha_muestra",
      description:
        "Ficha completa de UNA muestra por su accesión: datos, alteraciones y todos sus análisis medición por medición. Usala SOLO cuando ya tenés la accesión exacta (la escribió el usuario o salió de buscar_muestras). NUNCA adivines ni inventes una accesión: si te dan un nombre, usá buscar_muestras.",
      parameters: {
        type: "object",
        properties: {
          accesion: { type: "string", description: "Accesión de la muestra, por ejemplo A-0012-2 o M-0012-4" },
        },
        required: ["accesion"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resumen_analisis",
      description:
        "Estadísticas (cantidad, promedio, mínimo y máximo con su accesión) de cada análisis sobre las muestras que cumplen el filtro, opcionalmente agrupadas por un campo de la ficha (empresa, producto, procedencia…) o por día. Usala para promedios, comparaciones y extremos.",
      parameters: {
        type: "object",
        properties: {
          desde: FECHA,
          hasta: FECHA,
          laboratorio: LABORATORIO,
          texto: TEXTO,
          agrupar_por: {
            type: "string",
            description:
              'Clave del campo de la ficha por el que agrupar (empresa, producto, procedencia, silo…) o "dia". Vacío = un solo total.',
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reporte_diario",
      description:
        "Reporte de análisis diario del molino: promedios por turno y producto de todos los equipos, para un día de planta (de 22:00 del día anterior a 22:00).",
      parameters: { type: "object", properties: { fecha: { ...FECHA, description: "Día del reporte (YYYY-MM-DD). Vacío = hoy." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "estado_equipos",
      description:
        "Estado de la conexión de cada equipo del laboratorio con el sistema: si está reportando, cuándo fue su último análisis y si hay errores.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ─── Formato ─────────────────────────────────────────────────────────────────

const TZ_PLANTA = "America/Argentina/Cordoba";

const SITE_LABEL: Record<LabSite, string> = { MOLINO: "Molino", ACOPIO: "Acopio" };

export const SOURCE_LABEL: Record<LabSource, string> = {
  GLUTOMATIC: "Gluten (Glutomatic)",
  NIR: "NIR",
  FN: "Falling Number",
  SDMATIC: "Almidón dañado (SDmatic)",
  ALVEOLAB: "Alveógrafo (AlveoLab)",
};

const fmtFechaHora = (d: Date | string | null | undefined): string | null =>
  d
    ? new Intl.DateTimeFormat("es-AR", {
        timeZone: TZ_PLANTA,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(d))
    : null;

/** YYYY-MM-DD en fecha de planta (en-CA formatea ISO). */
const fechaPlanta = (d: Date | string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ_PLANTA, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(d),
  );

const esFecha = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

interface Formato {
  decimals: number;
  unit?: string;
}

/** Número con la coma decimal y la unidad del laboratorio: "12,3 %". */
const fmtValor = (v: number, f?: Formato | null): string => {
  const n = v.toFixed(f?.decimals ?? 2).replace(".", ",");
  return f?.unit ? `${n} ${f.unit}` : n;
};

const CATALOGO = new Map(ANALYSIS_COLUMNS.map((c) => [c.key, c]));

const columnaDe = (key: string, extra: AnalysisColumn[]): AnalysisColumn | undefined =>
  CATALOGO.get(key) ?? extra.find((c) => c.key === key);

const etiquetaDe = (key: string, extra: AnalysisColumn[]): string =>
  columnaDe(key, extra)?.label ?? key.slice(key.indexOf("|") + 1);

type Args = Record<string, unknown>;

const texto = (v: unknown, max = 80): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

const fallo = (name: string, mensaje: string): ToolResult => ({
  ok: false,
  summary: `${name}: ${mensaje}`,
  data: { error: mensaje },
});

/** Filtros comunes (fechas, laboratorio, texto) validados; el modelo a veces manda "2026-9-1" o "molino". */
const filtrosDe = (a: Args): { filtros: FiltrosMuestras; descripcion: string } | { error: string } => {
  for (const k of ["desde", "hasta"]) {
    if (a[k] !== undefined && a[k] !== null && a[k] !== "" && !esFecha(a[k])) {
      return { error: `"${k}" debe ser una fecha con formato YYYY-MM-DD (recibí ${JSON.stringify(a[k])})` };
    }
  }
  const labRaw = typeof a.laboratorio === "string" ? a.laboratorio.trim().toUpperCase() : "";
  if (labRaw && labRaw !== "MOLINO" && labRaw !== "ACOPIO") {
    return { error: '"laboratorio" debe ser MOLINO o ACOPIO' };
  }
  const filtros: FiltrosMuestras = {
    from: esFecha(a.desde) ? a.desde : undefined,
    to: esFecha(a.hasta) ? a.hasta : undefined,
    site: (labRaw || undefined) as LabSite | undefined,
    q: texto(a.texto),
  };
  const partes = [
    filtros.from || filtros.to ? `${filtros.from ?? "…"} a ${filtros.to ?? "hoy"}` : "sin fechas",
    filtros.site ? SITE_LABEL[filtros.site] : "ambos laboratorios",
    filtros.q ? `"${filtros.q}"` : null,
  ].filter(Boolean);
  return { filtros, descripcion: partes.join(", ") };
};

/** Etiqueta legible de cada clave de la ficha, tomada del catálogo vigente. */
const etiquetasFicha = async (): Promise<Map<string, string>> => {
  const kinds = await LabSamplesService.kinds();
  const out = new Map<string, string>();
  for (const k of kinds) for (const f of k.fields) if (!out.has(f.key)) out.set(f.key, f.label);
  return out;
};

const fichaLegible = (fields: unknown, etiquetas: Map<string, string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((fields ?? {}) as Record<string, unknown>)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    out[etiquetas.get(k) ?? k] = v === true ? "Sí" : v;
  }
  return out;
};

type FilaGrilla = Awaited<ReturnType<typeof LabSamplesService.grid>>["items"][number];

/** "No liga" es un resultado, no una ausencia: el Glutomatic registró la prueba con gluten 0. */
const ligaDe = (r: { noLiga?: boolean; analyses?: Partial<Record<LabSource, number>> }): string =>
  r.noLiga ? "NO LIGA (el Glutomatic no formó gluten)" : (r.analyses?.GLUTOMATIC ?? 0) > 0 ? "liga" : "sin Glutomatic todavía";

const filaCompacta = (r: FilaGrilla, extra: AnalysisColumn[], etiquetas: Map<string, string>) => ({
  accesion: r.accession,
  fecha: fmtFechaHora(r.sampledAt),
  laboratorio: SITE_LABEL[r.site],
  tipo: r.kind.name,
  nombre: r.displayName,
  ficha: fichaLegible(r.fields, etiquetas),
  alteraciones: r.conditions,
  gluten: ligaDe(r),
  analisis: Object.fromEntries(
    Object.entries(r.values).map(([k, v]) => [
      etiquetaDe(k, extra),
      fmtValor(v, columnaDe(k, extra)) + (r.implausible.includes(k) ? " (dudoso: fuera de calibración)" : ""),
    ]),
  ),
});

// ─── Herramientas ────────────────────────────────────────────────────────────

const buscarMuestras = async (a: Args): Promise<ToolResult> => {
  const f = filtrosDe(a);
  if ("error" in f) return fallo("buscar_muestras", f.error);
  const limite = Math.min(Math.max(Number(a.limite) || 20, 1), 50);
  const soloAlteradas = a.solo_con_alteraciones === true || a.solo_con_alteraciones === "true";

  // Con el filtro de alteraciones se traen más filas y se filtra acá: el backend no filtra por eso.
  const [g, etiquetas] = await Promise.all([
    LabSamplesService.grid(f.filtros, soloAlteradas ? 200 : limite),
    etiquetasFicha(),
  ]);
  const filas = (soloAlteradas ? g.items.filter((r) => r.conditions.length > 0) : g.items).slice(0, limite);
  return {
    ok: true,
    summary: `buscar_muestras: ${filas.length} muestra${filas.length === 1 ? "" : "s"} (${f.descripcion}${soloAlteradas ? ", con alteraciones" : ""})`,
    data: {
      filtro: f.descripcion,
      total_que_cumplen: soloAlteradas ? filas.length : g.total,
      devueltas: filas.length,
      muestras: filas.map((r) => filaCompacta(r, g.columns, etiquetas)),
    },
  };
};

const fichaMuestra = async (a: Args): Promise<ToolResult> => {
  const acc = texto(a.accesion, 20);
  if (!acc) return fallo("ficha_muestra", 'falta "accesion"');
  const [s, etiquetas] = await Promise.all([LabSamplesService.getByAccession(acc), etiquetasFicha()]);
  if (!s) return fallo("ficha_muestra", `no existe una muestra con la accesión ${acc}`);
  return {
    ok: true,
    summary: `ficha_muestra: ${s.accession} (${s.measurements.length} medici${s.measurements.length === 1 ? "ón" : "ones"})`,
    data: {
      accesion: s.accession,
      fecha: fmtFechaHora(s.sampledAt),
      laboratorio: SITE_LABEL[s.site],
      tipo: s.kind.name,
      nombre: s.displayName,
      ficha: fichaLegible(s.fields, etiquetas),
      alteraciones: s.conditions,
      gluten: ligaDe({ noLiga: s.noLiga, analyses: { GLUTOMATIC: s.measurements.filter((m) => m.source === "GLUTOMATIC").length } }),
      notas: s.notes,
      analisis: s.measurements.map((m) => ({
        equipo: SOURCE_LABEL[m.source],
        fecha: fmtFechaHora(m.analyzedAt),
        producto_segun_equipo: m.productCode,
        valores: Object.fromEntries(
          m.params.map((p) => {
            const key = analysisKey(m.source, p.code);
            const col = CATALOGO.get(key);
            return [
              col?.label ?? p.code,
              fmtValor(p.value, col ?? { decimals: 2, unit: p.unit ?? undefined }) +
                (p.isImplausible ? " (dudoso: fuera de calibración)" : ""),
            ];
          }),
        ),
      })),
    },
  };
};

interface Acumulador {
  n: number;
  suma: number;
  min: number;
  max: number;
  accMin: string;
  accMax: string;
  dudosos: number;
}
const nuevoAcumulador = (): Acumulador => ({ n: 0, suma: 0, min: Infinity, max: -Infinity, accMin: "", accMax: "", dudosos: 0 });

const resumenAnalisis = async (a: Args): Promise<ToolResult> => {
  const f = filtrosDe(a);
  if ("error" in f) return fallo("resumen_analisis", f.error);
  const agrupar = texto(a.agrupar_por, 40)?.toLowerCase();
  const g = await LabSamplesService.grid(f.filtros, 1000);

  const claveGrupo = (r: FilaGrilla): string => {
    if (!agrupar) return "Total";
    if (agrupar === "dia" || agrupar === "día" || agrupar === "fecha") return fechaPlanta(r.sampledAt);
    const v = ((r.fields ?? {}) as Record<string, unknown>)[agrupar];
    if (v === undefined || v === null || v === "" || v === false) return "(sin dato)";
    return v === true ? "Sí" : String(v);
  };

  const grupos = new Map<string, { muestras: number; stats: Map<string, Acumulador> }>();
  for (const r of g.items) {
    const gk = claveGrupo(r);
    const grp = grupos.get(gk) ?? { muestras: 0, stats: new Map<string, Acumulador>() };
    grp.muestras++;
    for (const [k, v] of Object.entries(r.values)) {
      const s = grp.stats.get(k) ?? nuevoAcumulador();
      if (r.implausible.includes(k)) {
        s.dudosos++;
      } else {
        s.n++;
        s.suma += v;
        if (v < s.min) {
          s.min = v;
          s.accMin = r.accession;
        }
        if (v > s.max) {
          s.max = v;
          s.accMax = r.accession;
        }
      }
      grp.stats.set(k, s);
    }
    grupos.set(gk, grp);
  }

  const ordenados = [...grupos].sort((x, y) =>
    agrupar === "dia" ? x[0].localeCompare(y[0]) : y[1].muestras - x[1].muestras || x[0].localeCompare(y[0]),
  );
  const MAX_GRUPOS = 30;
  return {
    ok: true,
    summary: `resumen_analisis: ${g.items.length} muestras (${f.descripcion})${agrupar ? `, agrupadas por ${agrupar}` : ""}`,
    data: {
      filtro: f.descripcion,
      muestras: g.items.length,
      ...(g.truncated ? { aviso: `Solo se consideraron las ${g.limit} muestras más recientes de ${g.total}` } : {}),
      agrupado_por: agrupar ?? null,
      ...(ordenados.length > MAX_GRUPOS ? { grupos_omitidos: ordenados.length - MAX_GRUPOS } : {}),
      grupos: ordenados.slice(0, MAX_GRUPOS).map(([grupo, grp]) => ({
        grupo,
        muestras: grp.muestras,
        analisis: Object.fromEntries(
          [...grp.stats]
            .filter(([, s]) => s.n > 0)
            .map(([k, s]) => {
              const col = columnaDe(k, g.columns);
              return [
                etiquetaDe(k, g.columns),
                {
                  n: s.n,
                  promedio: fmtValor(s.suma / s.n, col),
                  minimo: `${fmtValor(s.min, col)} (${s.accMin})`,
                  maximo: `${fmtValor(s.max, col)} (${s.accMax})`,
                  ...(s.dudosos > 0 ? { lecturas_dudosas_excluidas: s.dudosos } : {}),
                },
              ];
            }),
        ),
      })),
    },
  };
};

const reporteDiario = async (a: Args): Promise<ToolResult> => {
  if (a.fecha !== undefined && a.fecha !== null && a.fecha !== "" && !esFecha(a.fecha)) {
    return fallo("reporte_diario", '"fecha" debe ser YYYY-MM-DD');
  }
  const r = await LabReportService.diario(esFecha(a.fecha) ? a.fecha : undefined);
  return {
    ok: true,
    summary: `reporte_diario: ${r.date} (${r.rows.length} filas, ${r.totalMeasurements} mediciones)`,
    data: {
      fecha: r.date,
      desde: fmtFechaHora(r.from),
      hasta: fmtFechaHora(r.to),
      mediciones: r.totalMeasurements,
      filas: r.rows.map((x) => ({
        turno: x.turno,
        producto: x.producto,
        mediciones: x.measurements,
        muestras: x.samples,
        promedios: Object.fromEntries(
          Object.entries(x.values).map(([code, v]) => {
            const col = r.columns.find((c) => c.code === code);
            return [col?.label ?? code, fmtValor(v, col)];
          }),
        ),
      })),
    },
  };
};

const estadoEquipos = async (): Promise<ToolResult> => {
  const h = (await LabService.getHealth()) as {
    sources: {
      source: LabSource;
      state: string;
      sourceQuiet: boolean;
      lastHeartbeatAt: Date | null;
      lastSourceAnalyzedAt: Date | null;
      lastErrorCode: string | null;
      measurements: number;
    }[];
    [k: string]: unknown;
  };
  return {
    ok: true,
    summary: `estado_equipos: ${h.sources.length} equipos`,
    data: {
      equipos: h.sources.map((s) => ({
        equipo: SOURCE_LABEL[s.source] ?? s.source,
        estado: s.state,
        sin_mediciones_nuevas: s.sourceQuiet,
        ultimo_analisis: fmtFechaHora(s.lastSourceAnalyzedAt),
        ultima_senal_del_agente: fmtFechaHora(s.lastHeartbeatAt),
        mediciones_totales: s.measurements,
        error: s.lastErrorCode,
      })),
    },
  };
};

// ─── Entrada ─────────────────────────────────────────────────────────────────

/**
 * Ejecuta una herramienta pedida por el modelo. Nunca lanza por errores "del
 * modelo" (nombre desconocido, argumento inválido, accesión inexistente): eso
 * vuelve como resultado con `ok: false` para que el modelo se corrija. Solo
 * propagan las fallas reales del sistema.
 */
export const executeTool = async (name: string, argsIn: unknown): Promise<ToolResult> => {
  const args: Args = argsIn && typeof argsIn === "object" && !Array.isArray(argsIn) ? (argsIn as Args) : {};
  try {
    switch (name) {
      case "buscar_muestras":
        return await buscarMuestras(args);
      case "ficha_muestra":
        return await fichaMuestra(args);
      case "resumen_analisis":
        return await resumenAnalisis(args);
      case "reporte_diario":
        return await reporteDiario(args);
      case "estado_equipos":
        return await estadoEquipos();
      default:
        return fallo(
          name || "(sin nombre)",
          `no existe esa herramienta; las disponibles son ${TOOLS.map((t) => t.function.name).join(", ")}`,
        );
    }
  } catch (err) {
    if (err instanceof ApiError && err.statusCode < 500) return fallo(name, err.message);
    throw err;
  }
};

/** Lo que el modelo tiene que saber del catálogo vigente para elegir bien filtros y agrupaciones. */
export const catalogoParaPrompt = async (): Promise<string> => {
  const kinds = await LabSamplesService.kinds();
  const tipos = kinds
    .map(
      (k) =>
        `- ${k.name} (${k.defaultSite ? SITE_LABEL[k.defaultSite] : "cualquier laboratorio"}): ${k.fields
          .map((f) => `${f.label} [${f.key}]${f.isCondition ? " (alteración)" : ""}`)
          .join(", ")}`,
    )
    .join("\n");
  const analisis = ANALYSIS_COLUMNS.map((c) => `${c.label}${c.unit ? ` (${c.unit})` : ""}`).join(", ");
  return `Tipos de muestra y campos de su ficha (entre corchetes, la clave para "agrupar_por"):\n${tipos}\n\nAnálisis disponibles: ${analisis}.`;
};
