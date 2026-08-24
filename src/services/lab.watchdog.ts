import { LabSource } from "@prisma/client";
import { prisma } from "../lib/database";
import { logger } from "../lib/logger";
import LabService, { deriveFeedState, isSourceQuiet } from "./lab.service";
import PushService from "./push.service";
import { TicketsService } from "./tickets.service";

/** Cada cuánto se re-avisa mientras el feed sigue caído. */
const RE_ESCALATE_MS = 6 * 60 * 60 * 1000;

/** Un reconcile que dejó de correr te deja sin capacidad de reparar huecos, y en silencio. */
const RECONCILE_STALE_MS = 36 * 60 * 60 * 1000;

const SOURCE_LABEL: Record<LabSource, string> = {
  GLUTOMATIC: "Glutomatic (gluten)",
  NIR: "NIR Inframatic IM 9500H",
};

/**
 * Vigilancia del espejo de laboratorio.
 *
 * Diseño deliberado: esto NO es la única red de contención, y no debe serlo.
 * Corre dentro del mismo proceso que puede morir, así que si Render se duerme o
 * se cae, el watchdog se va con él — justo cuando haría falta. La protección
 * que sobrevive a eso es el dead-man switch externo (healthchecks.io), que se
 * pinguea desde el heartbeat. Este watchdog es el que abre el ticket y avisa;
 * el externo es el que garantiza que alguien se entere igual.
 *
 * Es idempotente y se puede disparar por intervalo o por HTTP (para que un cron
 * externo también pueda manejarlo).
 */
export class LabWatchdog {
  static async run(now = new Date()) {
    const feeds = await prisma.labFeed.findMany();
    const results: {
      source: LabSource;
      state: string;
      action: string;
    }[] = [];

    for (const feed of feeds) {
      const state = deriveFeedState(feed, now);
      let action = "ninguna";

      if (state === "DOWN") {
        action = await this.escalate(feed, now);
      } else if (feed.alertOpenTicketId) {
        action = await this.resolve(feed, now);
      } else if (feed.lastErrorCode) {
        // El agente late y puede leer SQL, pero su ultima corrida fallo: el
        // enlace de subida esta roto. Sin esto el feed figura OK, el heartbeat
        // esta fresco y nada revela que hace horas que no entra un dato.
        // Warn-only por ahora, igual que el origen quieto: primero calibrar.
        action = "aviso_error_de_transporte";
        logger.warn(
          { source: feed.source, lastErrorCode: feed.lastErrorCode },
          "El agente late pero su ultima corrida fallo: no esta entrando nada",
        );
      } else if (isSourceQuiet(feed.lastSourceAnalyzedAt, now)) {
        // Warn-only a propósito: es otro problema (el instrumento o el
        // importador, no el enlace) y arranca sin escalar para poder calibrar
        // el umbral contra feriados y paradas de planta sin gastar credibilidad.
        action = "aviso_origen_quieto";
        logger.warn(
          {
            source: feed.source,
            lastSourceAnalyzedAt: feed.lastSourceAnalyzedAt,
          },
          "Feed sano pero el origen no produce mediciones en horario de planta",
        );
      }

      if (
        feed.lastReconciledAt &&
        now.getTime() - feed.lastReconciledAt.getTime() > RECONCILE_STALE_MS
      ) {
        logger.warn(
          { source: feed.source, lastReconciledAt: feed.lastReconciledAt },
          "El reconcile del laboratorio no corre hace más de 36 h",
        );
      }

      results.push({ source: feed.source, state, action });
    }

    return { checkedAt: now, results };
  }

  // ─── Escalada ──────────────────────────────────────────────────────────────

  private static async escalate(
    feed: {
      source: LabSource;
      lastHeartbeatAt: Date | null;
      sqlReachable: boolean;
      lastErrorCode: string | null;
      alertOpenTicketId: string | null;
      alertLastNotifiedAt: Date | null;
    },
    now: Date,
  ): Promise<string> {
    const yaAvisado = feed.alertLastNotifiedAt
      ? now.getTime() - feed.alertLastNotifiedAt.getTime() < RE_ESCALATE_MS
      : false;

    if (feed.alertOpenTicketId && yaAvisado) return "ya_escalado";

    const admins = await prisma.user.findMany({
      where: { role: "ADMIN", isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (admins.length === 0) {
      logger.error("Feed de laboratorio caído y no hay ningún ADMIN activo a quien avisar");
      return "sin_destinatarios";
    }

    const detalle = this.describe(feed, now);
    let ticketId = feed.alertOpenTicketId;

    // Un solo ticket por incidente: re-escalar no abre uno nuevo, solo vuelve a
    // notificar. Si no, en un fin de semana caído aparecen veinte tickets.
    if (!ticketId) {
      try {
        const ticket = await TicketsService.createTicket(
          {
            title: `Laboratorio: sin datos de ${SOURCE_LABEL[feed.source]}`,
            description:
              `El espejo de mediciones dejó de recibir datos.\n\n${detalle}\n\n` +
              `Revisar en el servidor del molino: la tarea programada del pusher, ` +
              `el enlace a internet y que SQL Server esté respondiendo.`,
            priority: "HIGH",
            category: "Infraestructura",
          },
          admins[0].id,
        );
        ticketId = ticket.id;
      } catch (error) {
        // Que falle la creación del ticket no puede impedir la notificación:
        // son dos caminos independientes a propósito.
        logger.error({ err: error }, "No se pudo crear el ticket de feed caído");
      }
    }

    // Dos destinatarios como mínimo: una sola notificación perdida es
    // exactamente cómo pasó lo del mirror de la extranet.
    await Promise.allSettled(
      admins.map((a) =>
        PushService.sendToUser(a.id, {
          title: "Laboratorio sin datos",
          body: `${SOURCE_LABEL[feed.source]}: ${detalle}`,
          url: "/modulos/laboratorio",
        }),
      ),
    );

    await prisma.labFeed.update({
      where: { source: feed.source },
      data: { alertOpenTicketId: ticketId, alertLastNotifiedAt: now },
    });

    logger.error(
      { source: feed.source, ticketId, detalle },
      "Feed de laboratorio CAÍDO: escalado",
    );
    return feed.alertOpenTicketId ? "re_escalado" : "escalado";
  }

  /** El feed volvió: se cierra el incidente sin intervención humana. */
  private static async resolve(
    feed: { source: LabSource; alertOpenTicketId: string | null },
    now: Date,
  ): Promise<string> {
    if (feed.alertOpenTicketId) {
      try {
        await prisma.ticket.update({
          where: { id: feed.alertOpenTicketId },
          data: { status: "RESOLVED", closedAt: now },
        });
      } catch (error) {
        logger.warn(
          { err: error, ticketId: feed.alertOpenTicketId },
          "No se pudo cerrar el ticket del feed (¿lo cerraron a mano?)",
        );
      }
    }

    await prisma.labFeed.update({
      where: { source: feed.source },
      data: { alertOpenTicketId: null, alertLastNotifiedAt: null },
    });

    logger.info({ source: feed.source }, "Feed de laboratorio recuperado");
    return "recuperado";
  }

  private static describe(
    feed: { lastHeartbeatAt: Date | null; sqlReachable: boolean; lastErrorCode: string | null },
    now: Date,
  ): string {
    if (!feed.lastHeartbeatAt) return "nunca se recibió una señal del agente del molino";

    const mins = Math.round((now.getTime() - feed.lastHeartbeatAt.getTime()) / 60_000);
    if (!feed.sqlReachable) {
      return `el agente está vivo pero no puede leer SQL Server en el molino` +
        (feed.lastErrorCode ? ` (${feed.lastErrorCode})` : "");
    }
    return `sin señal del agente hace ${mins} minutos`;
  }
}

/**
 * Dead-man switch externo. Se pinguea DESPUÉS de commitear un heartbeat sano,
 * así el ping afirma "el dato está en la base" y no "recibí una request".
 *
 * Es la única capa que sobrevive a que se caiga este servicio, Supabase o el
 * propio pusher: healthchecks.io avisa por su cuenta cuando dejan de llegar
 * pings. Sin esto, todas las alarmas viven dentro del sistema que puede morir.
 */
export const pingDeadMansSwitch = async () => {
  const url = process.env.LAB_HEALTHCHECK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
  } catch (error) {
    // Nunca puede romper la ingesta: es telemetría, no camino crítico.
    logger.warn({ err: error }, "No se pudo pinguear el dead-man switch del laboratorio");
  }
};

export default LabWatchdog;
