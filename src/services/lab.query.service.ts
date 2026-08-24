import { Prisma } from "@prisma/client";
import { prisma } from "../lib/database";

/**
 * Consultas de lectura del módulo de laboratorio.
 *
 * TODO se agrega en SQL. El dashboard original agregaba en memoria sobre un
 * snapshot cacheado, y ahí era la decisión correcta: SQL Server Express elegía
 * planes inestables para la misma consulta (60 s serial, 44 s por método,
 * contra 3,5 s de scan) y no hay forma de fijarle un plan. Acá el motor es
 * Postgres en Supabase, del otro lado de internet: traerse 28.000 filas para
 * promediarlas en Node gastaría egress y latencia para nada, y contra la cuota
 * del plan free.
 *
 * Los cuatro parámetros de gluten viven en formato largo (una fila por
 * parámetro), así que cada consulta empieza pivoteándolos.
 */

/** Zona del molino. Sin horario de verano desde 2009, pero se nombra la zona y no el offset. */
const TZ = "America/Argentina/Cordoba";

// Códigos tal como los manda el agente del molino. Si cambian allá, cambian acá.
const COD_WET = "Gluten húmedo";
const COD_DRY = "Gluten seco";
const COD_IDX = "Índice de gluten";
const COD_WBC = "Capacidad de retención de agua";

/** Orden fijo de harinas. Las cuatro conocidas se muestran siempre; "Otras" solo si tiene muestras. */
const ORDEN_HARINAS = ["3/0", "4/0", "Tapera", "Semolín", "Otras"] as const;

export interface FiltrosGluten {
  from?: string;
  to?: string;
  instrumentSerial?: string;
  method?: string;
  sampleCodeContains?: string;
  includeIncomplete?: boolean;
}

export interface FiltrosNir {
  product?: string;
  from?: string;
  to?: string;
  sampleCodeContains?: string;
}

// ─── Fechas ──────────────────────────────────────────────────────────────────

/**
 * Convierte una fecha local de planta al instante UTC equivalente, EN SQL.
 *
 * La columna guarda UTC sin zona y la planta está en UTC-3. Comparar contra una
 * fecha suelta correría el corte tres horas: una muestra de las 22:30 del lunes
 * caería en el martes. Ya pasó dos veces en este proyecto.
 *
 * Se convierte el LÍMITE y no la columna a propósito: envolver la columna en
 * AT TIME ZONE inutiliza el índice de analyzedAt. Así la expresión es constante
 * y el índice se sigue usando.
 */
const aUtc = (fechaLocal: string) =>
  Prisma.sql`((${fechaLocal}::timestamp AT TIME ZONE ${TZ}) AT TIME ZONE 'UTC')`;

/** ¿Es una fecha sola, sin hora? Entonces el "hasta" incluye el día completo. */
const esSoloFecha = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

/** Hora local de planta, para agrupar por día o por mes. Acá sí hay que envolver la columna. */
const LOCAL = Prisma.sql`((m."analyzedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})`;

// ─── Filtros ─────────────────────────────────────────────────────────────────

const condicionesGluten = (f: FiltrosGluten): Prisma.Sql[] => {
  const c: Prisma.Sql[] = [
    Prisma.sql`m."source" = 'GLUTOMATIC'::"LabSource"`,
    Prisma.sql`m."deletedAt" IS NULL`,
  ];

  if (f.from?.trim()) c.push(Prisma.sql`m."analyzedAt" >= ${aUtc(f.from.trim())}`);

  if (f.to?.trim()) {
    const to = f.to.trim();
    // Una fecha sola significa "hasta el final de ese día", no "hasta su
    // medianoche". Sin esto, filtrar "hasta hoy" esconde todo lo de hoy.
    c.push(
      esSoloFecha(to)
        ? Prisma.sql`m."analyzedAt" < ${aUtc(to)} + interval '1 day'`
        : Prisma.sql`m."analyzedAt" < ${aUtc(to)}`,
    );
  }

  if (f.instrumentSerial?.trim())
    c.push(Prisma.sql`lower(m."instrumentSerial") = lower(${f.instrumentSerial.trim()})`);

  if (f.method?.trim())
    c.push(Prisma.sql`lower(m."productCode") = lower(${f.method.trim()})`);

  if (f.sampleCodeContains?.trim())
    c.push(Prisma.sql`m."sampleRef" ILIKE ${"%" + f.sampleCodeContains.trim() + "%"}`);

  return c;
};

/**
 * Pivotea los cuatro parámetros de gluten y aplica los filtros.
 *
 * El filtro de "incompletas" va DESPUÉS del pivot, no en el WHERE: solo se sabe
 * si falta el gluten húmedo una vez armada la fila. Es el mismo criterio que
 * usaba el dashboard original (`WetGluten > 0`), no "el parámetro no existe":
 * una medición fallida deja un 0, no un NULL.
 */
const pivotGluten = (f: FiltrosGluten) => {
  const where = Prisma.join(condicionesGluten(f), " AND ");
  const teniendo = f.includeIncomplete
    ? Prisma.empty
    : Prisma.sql`WHERE wet > 0`;

  return Prisma.sql`
    WITH crudo AS (
      SELECT m."id",
             m."sourceId",
             m."sampleRef",
             m."analyzedAt",
             m."productCode",
             m."instrumentSerial",
             ${LOCAL} AS local_ts,
             MAX(CASE WHEN p."code" = ${COD_WET} THEN p."value" END) AS wet,
             MAX(CASE WHEN p."code" = ${COD_DRY} THEN p."value" END) AS dry,
             MAX(CASE WHEN p."code" = ${COD_IDX} THEN p."value" END) AS idx,
             MAX(CASE WHEN p."code" = ${COD_WBC} THEN p."value" END) AS wbc
      FROM "lab_measurements" m
      LEFT JOIN "lab_parameters" p ON p."measurementId" = m."id"
      WHERE ${where}
      GROUP BY m."id"
    ),
    g AS (SELECT * FROM crudo ${teniendo})
  `;
};

/**
 * Clasificación de harina por prefijo del código de muestra.
 *
 * El límite `[^0-9]|$` no es decorativo: sin él, un código con forma de fecha
 * como "3/06/26 T1" se clasifica como harina 3/0. Es la misma guarda que el
 * dashboard original, traducida a regex de Postgres.
 */
const HARINA = Prisma.sql`
  CASE
    WHEN ltrim(coalesce(g."sampleRef", '')) ~* '^(F ?)?3/0([^0-9]|$)' THEN '3/0'
    WHEN ltrim(coalesce(g."sampleRef", '')) ~* '^(F ?)?4/0([^0-9]|$)' THEN '4/0'
    WHEN ltrim(coalesce(g."sampleRef", '')) ~* '^tap'                 THEN 'Tapera'
    WHEN ltrim(coalesce(g."sampleRef", '')) ~* '^semoli'              THEN 'Semolín'
    ELSE 'Otras'
  END
`;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const red2 = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
};

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v ? String(v) : null;

export class LabQueryService {
  // ─── Instrumentos y métodos ────────────────────────────────────────────────

  /**
   * Equipos de gluten con su conteo real de muestras.
   *
   * Filtra por `source` en la tabla de instrumentos. En el sistema original esto
   * se resolvía uniendo el mapeo con los seriales de la vista de gluten, y por
   * eso agregar el serial del NIR lo hacía aparecer como equipo fantasma con 0
   * mediciones. Acá el filtro es explícito.
   */
  static async equipos() {
    const filas = await prisma.$queryRaw<
      { serial: string; displayName: string; location: string | null; isActive: boolean; total: bigint }[]
    >`
      SELECT i."serial",
             i."displayName",
             i."location",
             i."isActive",
             count(m."id")::bigint AS total
      FROM "lab_instruments" i
      LEFT JOIN "lab_measurements" m
             ON m."instrumentSerial" = i."serial"
            AND m."source" = 'GLUTOMATIC'::"LabSource"
            AND m."deletedAt" IS NULL
      WHERE i."source" = 'GLUTOMATIC'::"LabSource"
      GROUP BY i."serial", i."displayName", i."location", i."isActive"
      ORDER BY i."displayName"
    `;

    return filas.map((f) => ({
      serial: f.serial,
      displayName: f.displayName,
      location: f.location,
      isActive: f.isActive,
      totalSamples: Number(f.total),
    }));
  }

  static async metodos() {
    const filas = await prisma.$queryRaw<{ name: string; total: bigint }[]>`
      SELECT m."productCode" AS name, count(*)::bigint AS total
      FROM "lab_measurements" m
      WHERE m."source" = 'GLUTOMATIC'::"LabSource"
        AND m."deletedAt" IS NULL
        AND m."productCode" IS NOT NULL
        AND m."productCode" <> ''
      GROUP BY m."productCode"
      ORDER BY count(*) DESC
    `;
    return filas.map((f) => ({ name: f.name, totalUses: Number(f.total) }));
  }

  // ─── Mediciones de gluten ──────────────────────────────────────────────────

  static async mediciones(
    f: FiltrosGluten,
    page = 1,
    pageSize = 50,
    sortBy = "analyzedAt",
    sortDesc = true,
  ) {
    const tamano = Math.min(Math.max(pageSize, 1), 500);
    const pagina = Math.max(page, 1);
    const salto = (pagina - 1) * tamano;

    // Lista blanca: el nombre de columna no puede parametrizarse, así que se
    // mapea contra un conjunto cerrado en vez de interpolar lo que llegue.
    const columnas: Record<string, string> = {
      analyzedAt: '"analyzedAt"',
      sampleCode: '"sampleRef"',
      wetGluten: "wet",
      dryGluten: "dry",
      glutenIndex: "idx",
      waterBindingCapacity: "wbc",
      methodName: '"productCode"',
    };
    const col = columnas[sortBy] ?? '"analyzedAt"';
    const dir = sortDesc ? "DESC" : "ASC";

    const pivot = pivotGluten(f);

    const [filas, conteo] = await Promise.all([
      prisma.$queryRaw<Record<string, unknown>[]>`
        ${pivot}
        SELECT g.*, i."displayName", i."location"
        FROM g
        LEFT JOIN "lab_instruments" i ON i."serial" = g."instrumentSerial"
        ORDER BY ${Prisma.raw("g." + col + " " + dir + " NULLS LAST")}, g."sourceId" DESC
        LIMIT ${tamano} OFFSET ${salto}
      `,
      prisma.$queryRaw<{ total: bigint }[]>`
        ${pivot}
        SELECT count(*)::bigint AS total FROM g
      `,
    ]);

    return {
      items: filas.map(mapearGluten),
      total: Number(conteo[0]?.total ?? 0),
      page: pagina,
      pageSize: tamano,
    };
  }

  /**
   * Agregados del conjunto filtrado COMPLETO, no de la página cargada.
   *
   * Los promedios excluyen valores no positivos: un 0 es una medición fallida,
   * no un gluten de cero, y promediarlo hunde el resultado. Los mínimos y
   * máximos no se redondean; los promedios sí, a dos decimales.
   */
  static async estadisticas(f: FiltrosGluten) {
    const pivot = pivotGluten(f);
    const filas = await prisma.$queryRaw<Record<string, unknown>[]>`
      ${pivot}
      SELECT count(*)::bigint                                        AS total,
             count(*) FILTER (WHERE wet IS NULL OR wet = 0)::bigint  AS incompletas,
             avg(wet) FILTER (WHERE wet > 0)                         AS avg_wet,
             avg(dry) FILTER (WHERE dry > 0)                         AS avg_dry,
             avg(idx) FILTER (WHERE idx > 0)                         AS avg_idx,
             avg(wbc) FILTER (WHERE wbc > 0)                         AS avg_wbc,
             min(wet) FILTER (WHERE wet > 0)                         AS min_wet,
             max(wet) FILTER (WHERE wet > 0)                         AS max_wet,
             min(idx) FILTER (WHERE idx > 0)                         AS min_idx,
             max(idx) FILTER (WHERE idx > 0)                         AS max_idx,
             min("analyzedAt")                                      AS primera,
             max("analyzedAt")                                      AS ultima
      FROM g
    `;

    const r = filas[0] ?? {};
    return {
      count: Number(r.total ?? 0),
      incompleteCount: Number(r.incompletas ?? 0),
      avgWetGluten: red2(r.avg_wet),
      avgDryGluten: red2(r.avg_dry),
      avgGlutenIndex: red2(r.avg_idx),
      avgWaterBindingCapacity: red2(r.avg_wbc),
      minWetGluten: num(r.min_wet),
      maxWetGluten: num(r.max_wet),
      minGlutenIndex: num(r.min_idx),
      maxGlutenIndex: num(r.max_idx),
      firstMeasurementAt: iso(r.primera),
      lastMeasurementAt: iso(r.ultima),
    };
  }

  /**
   * Promedios por tipo de harina.
   *
   * Recibe los MISMOS filtros que estadisticas() a propósito: si describieran
   * conjuntos distintos, las cards de arriba y esta tabla mostrarían números que
   * no cierran entre sí, que es exactamente el bug que se reportó una vez.
   *
   * Las cuatro harinas conocidas se emiten SIEMPRE, con 0 si el filtro no dejó
   * muestras. Una fila que desaparece se lee como "esa harina no existe" en
   * lugar de "no hubo muestras".
   */
  static async harinas(f: FiltrosGluten) {
    const pivot = pivotGluten(f);
    const filas = await prisma.$queryRaw<Record<string, unknown>[]>`
      ${pivot}
      SELECT ${HARINA} AS harina,
             count(*)::bigint                AS total,
             avg(wet) FILTER (WHERE wet > 0) AS avg_wet,
             avg(dry) FILTER (WHERE dry > 0) AS avg_dry,
             avg(idx) FILTER (WHERE idx > 0) AS avg_idx,
             avg(wbc) FILTER (WHERE wbc > 0) AS avg_wbc
      FROM g
      GROUP BY 1
    `;

    const porHarina = new Map(filas.map((r) => [String(r.harina), r]));

    return ORDEN_HARINAS.flatMap((harina) => {
      const r = porHarina.get(harina);
      if (!r) {
        // "Otras" no es una harina real: si está vacía, no se muestra.
        return harina === "Otras"
          ? []
          : [{ flour: harina, count: 0, avgWetGluten: null, avgDryGluten: null, avgGlutenIndex: null, avgWBC: null }];
      }
      return [{
        flour: harina,
        count: Number(r.total),
        avgWetGluten: red2(r.avg_wet),
        avgDryGluten: red2(r.avg_dry),
        avgGlutenIndex: red2(r.avg_idx),
        avgWBC: red2(r.avg_wbc),
      }];
    });
  }

  /**
   * Promedios mensuales, ponderados por muestra y no promedio de promedios.
   * Se agrupa por mes en hora de PLANTA: agrupar en UTC movería al mes
   * siguiente todo lo medido después de las 21:00 del último día del mes.
   */
  static async tendenciaMensual(
    meses = 12,
    serial?: string,
    method?: string,
    includeIncomplete = true,
  ) {
    const n = Math.min(Math.max(meses, 1), 60);
    // El conteo mensual viaja en el DTO y se exporta, así que el flag importa
    // aunque los promedios ya excluyan los no positivos por su cuenta.
    const pivot = pivotGluten({ instrumentSerial: serial, method, includeIncomplete });

    const filas = await prisma.$queryRaw<Record<string, unknown>[]>`
      ${pivot}
      SELECT date_trunc('month', local_ts)     AS mes,
             count(*)::bigint                  AS total,
             avg(wet) FILTER (WHERE wet > 0)   AS avg_wet,
             avg(dry) FILTER (WHERE dry > 0)   AS avg_dry,
             avg(idx) FILTER (WHERE idx > 0)   AS avg_idx,
             avg(wbc) FILTER (WHERE wbc > 0)   AS avg_wbc
      FROM g
      WHERE local_ts >= date_trunc('month', (now() AT TIME ZONE ${TZ})) - make_interval(months => ${n - 1}::int)
      GROUP BY 1
      ORDER BY 1
    `;

    return filas.map((r) => {
      const mes = r.mes as Date;
      return {
        year: mes.getUTCFullYear(),
        month: mes.getUTCMonth() + 1,
        avgWetGluten: red2(r.avg_wet),
        avgDryGluten: red2(r.avg_dry),
        avgGlutenIndex: red2(r.avg_idx),
        avgWBC: red2(r.avg_wbc),
        count: Number(r.total),
      };
    });
  }

  /**
   * Tendencia diaria sobre el conjunto filtrado. Mismo criterio de día local.
   *
   * Respeta `includeIncomplete` tal como viene y NO lo fuerza. Forzarlo tenía
   * sentido cuando esto alimentaba una vista aparte, sin ese filtro; con una
   * sola barra gobernando indicadores, tabla y gráficos, destildar "incluir
   * incompletas" dejaba el gráfico de volumen contando mediciones que las
   * cards ya habían descartado. Números distintos en la misma pantalla es
   * justo lo que la vista unificada viene a evitar.
   */
  static async tendenciaDiaria(f: FiltrosGluten, dias = 30) {
    const n = Math.min(Math.max(dias, 1), 400);
    const pivot = pivotGluten(f);

    const filas = await prisma.$queryRaw<Record<string, unknown>[]>`
      ${pivot}
      SELECT to_char(date_trunc('day', local_ts), 'YYYY-MM-DD') AS dia,
             count(*)::bigint                                   AS total,
             avg(wet) FILTER (WHERE wet > 0)                     AS avg_wet,
             avg(dry) FILTER (WHERE dry > 0)                     AS avg_dry,
             avg(idx) FILTER (WHERE idx > 0)                     AS avg_idx,
             avg(wbc) FILTER (WHERE wbc > 0)                     AS avg_wbc
      FROM g
      WHERE local_ts >= date_trunc('day', (now() AT TIME ZONE ${TZ})) - make_interval(days => ${n - 1}::int)
      GROUP BY 1
      ORDER BY 1
    `;

    return filas.map((r) => ({
      date: String(r.dia),
      avgWetGluten: red2(r.avg_wet),
      avgDryGluten: red2(r.avg_dry),
      avgGlutenIndex: red2(r.avg_idx),
      avgWBC: red2(r.avg_wbc),
      count: Number(r.total),
    }));
  }

  /**
   * Resumen para las cards por defecto, cuando no hay ningún filtro puesto.
   *
   * Los cortes de hoy / esta semana / este mes se calculan en hora de PLANTA.
   * En UTC, "hoy" arranca a las 21:00 del día anterior: a las 22 de un lunes el
   * panel diría que hay muestras del martes.
   */
  static async resumen() {
    const pivot = pivotGluten({ includeIncomplete: true });
    const filas = await prisma.$queryRaw<Record<string, unknown>[]>`
      ${pivot},
      hoy AS (SELECT date_trunc('day', (now() AT TIME ZONE ${TZ})) AS d)
      SELECT count(*) FILTER (WHERE g.local_ts >= (SELECT d FROM hoy))::bigint                       AS de_hoy,
             count(*) FILTER (WHERE g.local_ts >= date_trunc('week',  (SELECT d FROM hoy)))::bigint  AS de_semana,
             count(*) FILTER (WHERE g.local_ts >= date_trunc('month', (SELECT d FROM hoy)))::bigint  AS de_mes,
             avg(g.wet) FILTER (WHERE g.wet > 0 AND g.local_ts >= (SELECT d FROM hoy) - interval '7 days') AS avg_wet_7d,
             avg(g.idx) FILTER (WHERE g.idx > 0 AND g.local_ts >= (SELECT d FROM hoy) - interval '7 days') AS avg_idx_7d,
             count(DISTINCT g."instrumentSerial")::bigint                                            AS equipos,
             max(g."analyzedAt")                                                                     AS ultima
      FROM g
    `;

    const r = filas[0] ?? {};
    return {
      samplesToday: Number(r.de_hoy ?? 0),
      samplesThisWeek: Number(r.de_semana ?? 0),
      samplesThisMonth: Number(r.de_mes ?? 0),
      avgWetGlutenLast7Days: red2(r.avg_wet_7d),
      avgGlutenIndexLast7Days: red2(r.avg_idx_7d),
      instrumentCount: Number(r.equipos ?? 0),
      lastMeasurementAt: iso(r.ultima),
    };
  }

  /**
   * Detalle de una medición más el historial del mismo código de muestra.
   *
   * `calibration` va en null: los datos de calibración del Glutomatic viven en
   * una tabla del SQL Server del molino que el espejo no replica. Se deja el
   * campo en el contrato para no romper el consumidor, pero el panel no debe
   * mostrar la sección si viene vacía — mejor ausente que inventada.
   */
  static async detalle(sourceId: string) {
    const base = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT g.*, i."displayName", i."location"
      FROM (
        SELECT m."id", m."sourceId", m."sampleRef", m."analyzedAt", m."productCode",
               m."instrumentSerial",
               MAX(CASE WHEN p."code" = ${COD_WET} THEN p."value" END) AS wet,
               MAX(CASE WHEN p."code" = ${COD_DRY} THEN p."value" END) AS dry,
               MAX(CASE WHEN p."code" = ${COD_IDX} THEN p."value" END) AS idx,
               MAX(CASE WHEN p."code" = ${COD_WBC} THEN p."value" END) AS wbc
        FROM "lab_measurements" m
        LEFT JOIN "lab_parameters" p ON p."measurementId" = m."id"
        WHERE m."source" = 'GLUTOMATIC'::"LabSource"
          AND m."deletedAt" IS NULL
          AND m."sourceId" = ${sourceId}
        GROUP BY m."id"
      ) g
      LEFT JOIN "lab_instruments" i ON i."serial" = g."instrumentSerial"
    `;

    if (base.length === 0) return null;
    const m = mapearGluten(base[0]);

    const historial = m.sampleCode
      ? await prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT g.*, i."displayName", i."location"
          FROM (
            SELECT m."id", m."sourceId", m."sampleRef", m."analyzedAt", m."productCode",
                   m."instrumentSerial",
                   MAX(CASE WHEN p."code" = ${COD_WET} THEN p."value" END) AS wet,
                   MAX(CASE WHEN p."code" = ${COD_DRY} THEN p."value" END) AS dry,
                   MAX(CASE WHEN p."code" = ${COD_IDX} THEN p."value" END) AS idx,
                   MAX(CASE WHEN p."code" = ${COD_WBC} THEN p."value" END) AS wbc
            FROM "lab_measurements" m
            LEFT JOIN "lab_parameters" p ON p."measurementId" = m."id"
            WHERE m."source" = 'GLUTOMATIC'::"LabSource"
              AND m."deletedAt" IS NULL
              AND m."sampleRef" = ${m.sampleCode}
              AND m."sourceId" <> ${sourceId}
            GROUP BY m."id"
          ) g
          LEFT JOIN "lab_instruments" i ON i."serial" = g."instrumentSerial"
          ORDER BY g."analyzedAt" DESC
          LIMIT 50
        `
      : [];

    return {
      measurement: m,
      sameSampleHistory: historial.map(mapearGluten),
      calibration: null,
    };
  }

  // ─── NIR ───────────────────────────────────────────────────────────────────

  private static condicionesNir(f: FiltrosNir): Prisma.Sql[] {
    const c: Prisma.Sql[] = [
      Prisma.sql`m."source" = 'NIR'::"LabSource"`,
      Prisma.sql`m."deletedAt" IS NULL`,
    ];
    if (f.product?.trim()) c.push(Prisma.sql`m."productCode" = ${f.product.trim()}`);
    if (f.from?.trim()) c.push(Prisma.sql`m."analyzedAt" >= ${aUtc(f.from.trim())}`);
    if (f.to?.trim()) {
      const to = f.to.trim();
      c.push(
        esSoloFecha(to)
          ? Prisma.sql`m."analyzedAt" < ${aUtc(to)} + interval '1 day'`
          : Prisma.sql`m."analyzedAt" < ${aUtc(to)}`,
      );
    }
    if (f.sampleCodeContains?.trim())
      c.push(Prisma.sql`m."sampleRef" ILIKE ${"%" + f.sampleCodeContains.trim() + "%"}`);
    return c;
  }

  static async nirProductos() {
    const filas = await prisma.$queryRaw<
      { producto: string; total: bigint; primera: Date; ultima: Date }[]
    >`
      SELECT coalesce(m."productCode", '(sin producto)') AS producto,
             count(*)::bigint                            AS total,
             min(m."analyzedAt")                         AS primera,
             max(m."analyzedAt")                         AS ultima
      FROM "lab_measurements" m
      WHERE m."source" = 'NIR'::"LabSource" AND m."deletedAt" IS NULL
      GROUP BY 1
      ORDER BY count(*) DESC
    `;
    return filas.map((f) => ({
      productName: f.producto,
      totalSamples: Number(f.total),
      firstAt: iso(f.primera),
      lastAt: iso(f.ultima),
    }));
  }

  static async nirMediciones(f: FiltrosNir, page = 1, pageSize = 50) {
    const tamano = Math.min(Math.max(pageSize, 1), 500);
    const pagina = Math.max(page, 1);
    const where = Prisma.join(this.condicionesNir(f), " AND ");

    const [cabeceras, conteo] = await Promise.all([
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT m."id", m."sourceId", m."instrumentSerial", m."analyzedAt",
               m."productCode", m."sampleRef"
        FROM "lab_measurements" m
        WHERE ${where}
        ORDER BY m."analyzedAt" DESC, m."sourceId" DESC
        LIMIT ${tamano} OFFSET ${(pagina - 1) * tamano}
      `,
      prisma.$queryRaw<{ total: bigint }[]>`
        SELECT count(*)::bigint AS total FROM "lab_measurements" m WHERE ${where}
      `,
    ]);

    const ids = cabeceras.map((c) => String(c.id));
    // Una sola consulta para los parámetros de toda la página, no una por fila.
    const params = ids.length
      ? await prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT p."measurementId", p."code", p."value", p."isImplausible"
          FROM "lab_parameters" p
          WHERE p."measurementId" IN (${Prisma.join(ids)})
          ORDER BY p."code"
        `
      : [];

    const porMedicion = new Map<string, Record<string, unknown>[]>();
    for (const p of params) {
      const k = String(p.measurementId);
      const lista = porMedicion.get(k) ?? [];
      lista.push(p);
      porMedicion.set(k, lista);
    }

    return {
      items: cabeceras.map((c) => ({
        nirMeasurementId: Number(c.sourceId),
        instrumentSerial: (c.instrumentSerial as string | null) ?? "",
        analyzedAt: iso(c.analyzedAt)!,
        productName: (c.productCode as string | null) ?? "",
        sampleCode: (c.sampleRef as string | null) ?? null,
        // El espejo no trae IsLabSample: el agente no lo manda porque en el
        // instrumento ese check no se usa de forma confiable. Se devuelve en
        // false para no romper el contrato, y el filtro correspondiente no
        // existe en esta versión.
        isLabSample: false,
        parameters: (porMedicion.get(String(c.id)) ?? []).map((p) => ({
          parameterName: String(p.code),
          moistureBasis: baseHumedad(String(p.code)),
          value: num(p.value),
        })),
      })),
      total: Number(conteo[0]?.total ?? 0),
      page: pagina,
      pageSize: tamano,
    };
  }

  /**
   * Agregados por parámetro. Los valores no positivos se EXCLUYEN del promedio
   * y se cuentan aparte: hay predicciones fuera del rango de calibración (una
   * Zeleny de -1705, por ejemplo) que promediadas destruyen el resultado. Se
   * informa cuántas se excluyeron en lugar de esconderlo.
   */
  static async nirEstadisticas(f: FiltrosNir) {
    const where = Prisma.join(this.condicionesNir(f), " AND ");

    const [general, porParam] = await Promise.all([
      prisma.$queryRaw<{ total: bigint; primera: Date | null; ultima: Date | null }[]>`
        SELECT count(*)::bigint AS total, min(m."analyzedAt") AS primera, max(m."analyzedAt") AS ultima
        FROM "lab_measurements" m
        WHERE ${where}
      `,
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT p."code",
               count(*) FILTER (WHERE p."value" > 0)::bigint  AS con_valor,
               count(*) FILTER (WHERE p."value" <= 0)::bigint AS excluidos,
               avg(p."value") FILTER (WHERE p."value" > 0)    AS promedio,
               min(p."value") FILTER (WHERE p."value" > 0)    AS minimo,
               max(p."value") FILTER (WHERE p."value" > 0)    AS maximo
        FROM "lab_measurements" m
        JOIN "lab_parameters" p ON p."measurementId" = m."id"
        WHERE ${where}
        GROUP BY p."code"
        ORDER BY p."code"
      `,
    ]);

    const g = general[0];
    return {
      count: Number(g?.total ?? 0),
      firstAt: iso(g?.primera),
      lastAt: iso(g?.ultima),
      parameters: porParam.map((r) => ({
        parameterName: String(r.code),
        moistureBasis: baseHumedad(String(r.code)),
        count: Number(r.con_valor),
        excluded: Number(r.excluidos),
        avg: red2(r.promedio),
        min: num(r.minimo),
        max: num(r.maximo),
      })),
    };
  }

  /** Tendencia diaria del NIR: un punto por día local, con un promedio por parámetro. */
  static async nirTendencia(f: FiltrosNir, dias = 60) {
    const n = Math.min(Math.max(dias, 1), 400);
    const where = Prisma.join(this.condicionesNir(f), " AND ");

    const filas = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT to_char(date_trunc('day', ${LOCAL}), 'YYYY-MM-DD') AS dia,
             p."code",
             avg(p."value") FILTER (WHERE p."value" > 0)         AS promedio,
             count(DISTINCT m."id")::bigint                      AS total
      FROM "lab_measurements" m
      LEFT JOIN "lab_parameters" p ON p."measurementId" = m."id"
      WHERE ${where}
        AND ${LOCAL} >= date_trunc('day', (now() AT TIME ZONE ${TZ})) - make_interval(days => ${n - 1}::int)
      GROUP BY 1, 2
      ORDER BY 1
    `;

    const porDia = new Map<string, { count: number; averages: Record<string, number | null> }>();
    for (const r of filas) {
      const dia = String(r.dia);
      const punto = porDia.get(dia) ?? { count: 0, averages: {} };
      punto.count = Math.max(punto.count, Number(r.total ?? 0));
      if (r.code) punto.averages[String(r.code)] = red2(r.promedio);
      porDia.set(dia, punto);
    }

    return [...porDia.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, p]) => ({ date, count: p.count, averages: p.averages }));
  }
}

/**
 * La base de humedad viene embebida en el nombre del parámetro
 * ("Proteína DryBasis", "Humedad AsIs"), porque así lo exporta el instrumento y
 * así se guarda. Se reconstruye para el campo del contrato en lugar de agregar
 * una columna que sería redundante.
 */
const baseHumedad = (code: string): string | null => {
  for (const base of ["DryBasis", "AsIs", "Fixed"]) {
    if (code.endsWith(base)) return base;
  }
  return null;
};

/** Fila pivoteada -> DTO. Una sola definición para lista, detalle e historial. */
const mapearGluten = (r: Record<string, unknown>) => ({
  sampleId: Number(r.sourceId),
  sampleCode: (r.sampleRef as string | null) ?? "",
  analyzedAt: iso(r.analyzedAt)!,
  methodName: (r.productCode as string | null) ?? "",
  instrumentSerial: (r.instrumentSerial as string | null) ?? "",
  instrumentName: (r.displayName as string | null) ?? null,
  instrumentLocation: (r.location as string | null) ?? null,
  wetGluten: num(r.wet),
  dryGluten: num(r.dry),
  glutenIndex: num(r.idx),
  waterBindingCapacity: num(r.wbc),
});

export default LabQueryService;
