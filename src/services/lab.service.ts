import { createHash, timingSafeEqual } from "node:crypto";
import { LabSource, Prisma } from "@prisma/client";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";

// ─── Umbrales de frescura ────────────────────────────────────────────────────
// El agente late cada 5 min. OK hasta 15 (tolera dos latidos perdidos), STALE
// hasta 25, DOWN después. Mismo criterio que deriveState() de agents.service.
export const LAB_FEED_OK_MS = 15 * 60 * 1000;
export const LAB_FEED_STALE_MS = 25 * 60 * 1000;

/** Horas sin mediciones, en día hábil y horario de planta, antes de sospechar del instrumento. */
export const LAB_SOURCE_QUIET_HOURS = 4;

export type LabFeedState = "OK" | "STALE" | "DOWN";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Hash de descarte para que autenticar un slug inexistente cueste lo mismo que uno real. */
const DUMMY_HASH = sha256("service-client-inexistente");

const safeHashEquals = (secret: string, expectedHash: string) => {
  const left = Buffer.from(sha256(secret));
  const right = Buffer.from(expectedHash);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * El estado NUNCA se persiste como adjetivo: se deriva por edad en cada lectura.
 * Un GET no muta nada, así que no hay forma de que quede un "OK" viejo pegado
 * en la base después de que el agente murió.
 */
export const deriveFeedState = (
  feed: { lastHeartbeatAt: Date | null; sqlReachable: boolean },
  now = new Date(),
): LabFeedState => {
  if (!feed.lastHeartbeatAt) return "DOWN";
  if (!feed.sqlReachable) return "DOWN";
  const age = now.getTime() - feed.lastHeartbeatAt.getTime();
  if (age <= LAB_FEED_OK_MS) return "OK";
  if (age <= LAB_FEED_STALE_MS) return "STALE";
  return "DOWN";
};

/**
 * ¿El origen dejó de producir aunque el enlace esté sano?
 *
 * Es un estado DISTINTO de que el sync se caiga, con otro mensaje y otro
 * destinatario: acá el problema es el instrumento o el importador, no la red.
 * Solo aplica en día hábil y horario de planta — si grita los domingos, en tres
 * semanas nadie mira ninguna alerta y perdés la protección entera.
 */
export const isSourceQuiet = (
  lastSourceAnalyzedAt: Date | null,
  now = new Date(),
): boolean => {
  const day = now.getDay(); // 0 = domingo, 6 = sábado
  const hour = now.getHours();
  const enHorarioDePlanta = day >= 1 && day <= 5 && hour >= 6 && hour < 22;
  if (!enHorarioDePlanta) return false;
  if (!lastSourceAnalyzedAt) return true;
  const hours = (now.getTime() - lastSourceAnalyzedAt.getTime()) / 3_600_000;
  return hours > LAB_SOURCE_QUIET_HOURS;
};

// ─── Contratos de ingesta ────────────────────────────────────────────────────

export interface IngestParameter {
  code: string;
  value: number;
  unit?: string | null;
}

export interface IngestMeasurement {
  sourceId: string;
  instrumentSerial?: string | null;
  productCode?: string | null;
  sampleRef?: string | null;
  analyzedAt: string;
  params: IngestParameter[];
}

export interface HeartbeatPayload {
  agentVersion?: string | null;
  sqlReachable: boolean;
  lastSourceRowAt?: string | null;
  pendingCount?: number;
  lastErrorCode?: string | null;
  cursorId?: string | null;
}

export class LabService {
  // ─── Autenticación del agente ──────────────────────────────────────────────
  static async authenticateClient(slug: string, secret: string) {
    const client = await prisma.serviceClient.findFirst({
      where: { slug, revokedAt: null },
      select: { id: true, slug: true, isActive: true, secretHash: true, scopes: true },
    });
    const expectedHash = client?.secretHash ?? DUMMY_HASH;
    const valid = safeHashEquals(secret, expectedHash);

    if (!client || !client.isActive || !valid) {
      throw new ApiError("SERVICE_AUTH_INVALID", "Credenciales de servicio inválidas", 401);
    }
    return client;
  }

  // ─── Ingesta ───────────────────────────────────────────────────────────────

  /**
   * Upsert de un lote. Idempotente por (source, sourceId): reenviar el mismo
   * lote no duplica ni pierde nada, que es lo que permite re-empujar días
   * enteros durante el reconcile sin pensarlo dos veces.
   *
   * Cada medición va en su propia transacción y los errores se cuentan sin
   * abortar el lote: una fila corrupta no puede frenar el avance del cursor
   * ni dejar el feed en verde sin datos nuevos.
   */
  static async ingestBatch(source: LabSource, items: IngestMeasurement[]) {
    const ranges = await this.loadRanges();
    let inserted = 0;
    let updated = 0;
    let failed = 0;
    let maxAnalyzedAt: Date | null = null;

    for (const item of items) {
      const analyzedAt = new Date(item.analyzedAt);
      if (Number.isNaN(analyzedAt.getTime())) {
        failed++;
        continue;
      }

      try {
        await prisma.$transaction(async (tx) => {
          const existing = await tx.labMeasurement.findUnique({
            where: { source_sourceId: { source, sourceId: item.sourceId } },
            select: { id: true },
          });

          const data = {
            instrumentSerial: item.instrumentSerial ?? null,
            productCode: item.productCode ?? null,
            sampleRef: item.sampleRef ?? null,
            analyzedAt,
          };

          const measurement = existing
            ? await tx.labMeasurement.update({ where: { id: existing.id }, data })
            : await tx.labMeasurement.create({
                data: { source, sourceId: item.sourceId, ...data },
              });

          // Los parámetros se reemplazan enteros: es la forma más simple de que
          // una corrección en origen quede reflejada sin dejar filas huérfanas.
          await tx.labParameter.deleteMany({ where: { measurementId: measurement.id } });

          const params = item.params
            .filter((p) => p.code && Number.isFinite(p.value))
            .map((p) => ({
              measurementId: measurement.id,
              code: p.code.slice(0, 40),
              value: p.value,
              unit: p.unit?.slice(0, 16) ?? null,
              isImplausible: this.isImplausible(ranges, item.productCode, p.code, p.value),
            }));

          if (params.length > 0) {
            await tx.labParameter.createMany({ data: params, skipDuplicates: true });
          }

          if (existing) updated++;
          else inserted++;
        });

        if (!maxAnalyzedAt || analyzedAt > maxAnalyzedAt) maxAnalyzedAt = analyzedAt;
      } catch (error) {
        failed++;
        logger.error(
          { err: error, source, sourceId: item.sourceId },
          "Fallo al ingestar una medición de laboratorio",
        );
      }
    }

    return { inserted, updated, failed, maxAnalyzedAt };
  }

  /**
   * Marca de vida. Se escribe SIEMPRE, haya o no mediciones nuevas — es lo que
   * separa "estoy vivo" de "traje datos" y evita el modo de falla donde el
   * dashboard muestra datos viejos como si fueran frescos.
   */
  static async recordHeartbeat(source: LabSource, payload: HeartbeatPayload) {
    const now = new Date();
    const lastSourceRowAt = payload.lastSourceRowAt
      ? new Date(payload.lastSourceRowAt)
      : null;

    return prisma.labFeed.upsert({
      where: { source },
      create: {
        source,
        lastHeartbeatAt: now,
        sqlReachable: payload.sqlReachable,
        agentVersion: payload.agentVersion ?? null,
        pendingCount: payload.pendingCount ?? 0,
        lastErrorCode: payload.lastErrorCode ?? null,
        cursorId: payload.cursorId ?? null,
        lastSourceAnalyzedAt:
          lastSourceRowAt && !Number.isNaN(lastSourceRowAt.getTime())
            ? lastSourceRowAt
            : null,
      },
      update: {
        lastHeartbeatAt: now,
        sqlReachable: payload.sqlReachable,
        agentVersion: payload.agentVersion ?? undefined,
        pendingCount: payload.pendingCount ?? undefined,
        lastErrorCode: payload.lastErrorCode ?? null,
        cursorId: payload.cursorId ?? undefined,
        ...(lastSourceRowAt && !Number.isNaN(lastSourceRowAt.getTime())
          ? { lastSourceAnalyzedAt: lastSourceRowAt }
          : {}),
      },
    });
  }

  static async advanceCursor(source: LabSource, cursorId: string, maxAnalyzedAt: Date | null) {
    return prisma.labFeed.update({
      where: { source },
      data: {
        cursorId,
        lastIngestAt: new Date(),
        ...(maxAnalyzedAt ? { lastSourceAnalyzedAt: maxAnalyzedAt } : {}),
      },
    });
  }

  // ─── Salud del espejo ──────────────────────────────────────────────────────

  /**
   * Lo que consume el banner de frescura y el watchdog. Devuelve el estado
   * derivado, no uno guardado.
   */
  static async getHealth(now = new Date()) {
    const feeds = await prisma.labFeed.findMany();
    const counts = await prisma.labMeasurement.groupBy({
      by: ["source"],
      _count: { _all: true },
      _max: { analyzedAt: true },
      where: { deletedAt: null },
    });

    const byCount = new Map(counts.map((c) => [c.source, c]));

    const sources = feeds.map((feed) => {
      const state = deriveFeedState(feed, now);
      const c = byCount.get(feed.source);
      return {
        source: feed.source,
        state,
        // Distingue "el sync se rompió" de "hoy no se midió nada": son dos
        // problemas distintos, con dos destinatarios distintos.
        sourceQuiet: state === "OK" && isSourceQuiet(feed.lastSourceAnalyzedAt, now),
        lastHeartbeatAt: feed.lastHeartbeatAt,
        lastIngestAt: feed.lastIngestAt,
        lastSourceAnalyzedAt: feed.lastSourceAnalyzedAt,
        lastReconciledAt: feed.lastReconciledAt,
        sqlReachable: feed.sqlReachable,
        lastErrorCode: feed.lastErrorCode,
        pendingCount: feed.pendingCount,
        agentVersion: feed.agentVersion,
        measurements: c?._count._all ?? 0,
        newestMeasurementAt: c?._max.analyzedAt ?? null,
      };
    });

    const worst: LabFeedState = sources.some((s) => s.state === "DOWN")
      ? "DOWN"
      : sources.some((s) => s.state === "STALE")
        ? "STALE"
        : "OK";

    return { state: worst, checkedAt: now, sources };
  }

  // ─── Reconcile ─────────────────────────────────────────────────────────────

  /**
   * Compara, día por día, lo que el origen dice tener contra lo que hay acá.
   *
   * Se comparan DOS cosas y no una: el conteo detecta filas faltantes o de más,
   * pero es ciego a una corrección hecha en sitio (misma fila, mismo día, mismo
   * total). La suma de los valores sí la ve. Es más débil que un hash real —dos
   * cambios que se compensen pasarían— pero no depende de que dos motores
   * distintos formateen los flotantes igual, que es la forma habitual de que un
   * reconcile por hash tire diferencias falsas todos los días hasta que alguien
   * lo apaga.
   */
  static async reconcile(
    source: LabSource,
    days: { day: string; count: number; valueSum: number }[],
  ) {
    if (days.length === 0) return { checked: 0, mismatched: [] as string[] };

    const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
    const from = new Date(`${sorted[0].day}T00:00:00.000Z`);
    const to = new Date(`${sorted[sorted.length - 1].day}T23:59:59.999Z`);

    // Agregación en SQL, no en memoria: traerse las filas para sumarlas acá
    // gastaría egress y latencia para nada.
    const rows = await prisma.$queryRaw<
      { day: Date; count: bigint; value_sum: number | null }[]
    >`
      SELECT date_trunc('day', m."analyzedAt") AS day,
             COUNT(*)::bigint                  AS count,
             COALESCE(SUM(p."value"), 0)       AS value_sum
      FROM "lab_measurements" m
      LEFT JOIN "lab_parameters" p ON p."measurementId" = m."id"
      WHERE m."source" = ${source}::"LabSource"
        AND m."deletedAt" IS NULL
        AND m."analyzedAt" >= ${from}
        AND m."analyzedAt" <= ${to}
      GROUP BY 1
    `;

    const mine = new Map<string, { count: number; sum: number }>();
    for (const r of rows) {
      const key = r.day.toISOString().slice(0, 10);
      mine.set(key, { count: Number(r.count), sum: Number(r.value_sum ?? 0) });
    }

    const mismatched: string[] = [];
    for (const d of sorted) {
      const here = mine.get(d.day) ?? { count: 0, sum: 0 };
      // Tolerancia por acumulación de punto flotante, no por criterio laxo.
      const sumDiff = Math.abs(here.sum - d.valueSum);
      if (here.count !== d.count || sumDiff > 0.01) {
        mismatched.push(d.day);
      }
    }

    await prisma.labFeed.update({
      where: { source },
      data: { lastReconciledAt: new Date() },
    });

    if (mismatched.length > 0) {
      logger.warn(
        { source, mismatched },
        "Reconcile del laboratorio: días con diferencias, hay que re-empujarlos",
      );
    }

    return { checked: sorted.length, mismatched };
  }

  // ─── Rangos de calibración ─────────────────────────────────────────────────

  private static async loadRanges() {
    const rows = await prisma.labParameterRange.findMany();
    const map = new Map<string, { min: number; max: number }>();
    for (const r of rows) {
      map.set(`${r.productCode}|${r.code}`, { min: r.minValue, max: r.maxValue });
    }
    return map;
  }

  /**
   * Un valor fuera del rango de calibración se marca, no se descarta: es
   * evidencia de un problema del instrumento. Sin rango definido, el único
   * criterio universal es que una magnitud física medida no puede ser negativa.
   */
  private static isImplausible(
    ranges: Map<string, { min: number; max: number }>,
    productCode: string | null | undefined,
    code: string,
    value: number,
  ): boolean {
    const range = productCode ? ranges.get(`${productCode}|${code}`) : undefined;
    if (range) return value < range.min || value > range.max;
    return value <= 0;
  }
}

export default LabService;
export type LabIngestSummary = Prisma.PromiseReturnType<typeof LabService.ingestBatch>;
