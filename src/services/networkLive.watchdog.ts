import { TicketCategory, TicketPriority, UserRole, type NetworkLiveAlert, type Prisma } from "@prisma/client";
import { prisma } from "../lib/database";
import { logger } from "../lib/logger";
import { deriveDeviceStatus } from "./networkLive.service";
import PushService from "./push.service";
import { TicketsService } from "./tickets.service";

/** Router y switches se leen cada minuto: tres lecturas seguidas sin respuesta ya es una caída. */
export const DEVICE_DOWN_ALERT_MS = 3 * 60_000;
/** Los APs llegan de UniFi cada 5 min: con 10 min no se avisa por un reinicio o una actualización. */
export const AP_DOWN_ALERT_MS = 10 * 60_000;
/** El colector manda cada minuto: 10 minutos sin noticias es que algo se cortó en la planta. */
export const COLLECTOR_SILENT_ALERT_MS = 10 * 60_000;
/** Mientras siga caído se vuelve a avisar cada 6 h, como el laboratorio: ni olvido ni ruido. */
export const RE_NOTIFY_MS = 6 * 60 * 60_000;
/** El árbol se arma con los enlaces del último día: un switch caído deja de aparecer en las tablas MAC. */
const TREE_LINKS_MS = 24 * 60 * 60_000;

const NETWORK_URL = "/it/network-live";

interface WatchedDevice {
  id: string;
  collector: string;
  name: string;
  role: string;
  source: string;
  reachable: boolean;
  lastPolledAt: Date;
  alertsMuted: boolean;
}

const minutesSince = (from: Date, now: Date) => Math.max(1, Math.round((now.getTime() - from.getTime()) / 60_000));

const duration = (from: Date, now: Date) => {
  const minutes = minutesSince(from, now);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} días`;
};

/**
 * Vigilancia de Red en vivo: avisa cuando se cae un equipo de red o el colector deja de mandar, y
 * cierra el aviso solo cuando vuelve. Mismo criterio que el watchdog del laboratorio: un ticket por
 * incidente (también cuando se cae un AP), push a todo IT (ADMIN y AGENT) y recordatorio cada 6 h.
 *
 * - Sólo avisa las caídas que el historial vio empezar (el evento device_down): lo que ya estaba
 *   caído antes de existir el historial (un AP apagado hace semanas) no dispara nada.
 * - Si se cae un switch, todo lo que cuelga de él también deja de responder: se avisa por el de
 *   más arriba y se nombran los de abajo, no veinte avisos.
 * - Con el colector mudo los estados no son confiables: se avisa por el colector y nada más.
 *
 * Corre dentro de este proceso (si Render se cae, se va con él); es idempotente.
 */
export class NetworkWatchdog {
  static async run(now = new Date()) {
    const [collectors, open] = await Promise.all([
      prisma.networkCollector.findMany(),
      prisma.networkLiveAlert.findMany({ where: { resolvedAt: null } }),
    ]);
    const actions: string[] = [];

    for (const collector of collectors) {
      const silent = now.getTime() - collector.lastReceivedAt.getTime() > COLLECTOR_SILENT_ALERT_MS;
      const alert = open.find((item) => item.kind === "collector_silent" && item.collector === collector.slug);

      if (silent) {
        const detail = `El colector de red (${collector.host ?? collector.slug}) no manda datos desde hace ${duration(collector.lastReceivedAt, now)}: la pantalla Red en vivo está desactualizada y no se pueden detectar caídas.`;
        if (!alert) {
          actions.push(
            await this.openAlert(
              { collector: collector.slug, kind: "collector_silent", deviceId: null, detail },
              {
                title: "Red: el colector no manda datos",
                ticketTitle: "Red en vivo: el colector de srv-datos no manda datos",
                ticketBody: `${detail}\n\nRevisar en srv-datos la tarea programada "\\GRF\\Colector de red" y sus logs en C:\\ProgramData\\GRF\\NetCollector\\logs, y que el servidor tenga salida a internet.`,
                priority: TicketPriority.HIGH,
              },
              now,
            ),
          );
          await this.event(collector.slug, "collector_silent", null, now, { since: collector.lastReceivedAt.toISOString() });
        } else if (this.due(alert, now)) {
          actions.push(await this.renotify(alert, "Red: el colector sigue sin mandar datos", detail, now));
        }
        // Sin datos frescos no se puede decir qué está caído y qué no.
        continue;
      }

      if (alert) {
        actions.push(
          await this.resolve(alert, now, {
            title: "Red: el colector volvió a mandar datos",
            body: `Estuvo sin mandar ${duration(alert.openedAt, now)}.`,
          }),
        );
        await this.event(collector.slug, "collector_back", null, now, { silentMinutes: minutesSince(alert.openedAt, now) });
      }

      actions.push(...(await this.checkDevices(collector.slug, open, now)));
    }

    return { checkedAt: now.toISOString(), actions };
  }

  private static async checkDevices(collector: string, open: NetworkLiveAlert[], now: Date) {
    const devices: WatchedDevice[] = await prisma.networkLiveDevice.findMany({
      where: { collector },
      select: { id: true, collector: true, name: true, role: true, source: true, reachable: true, lastPolledAt: true, alertsMuted: true },
    });
    const byId = new Map(devices.map((device) => [device.id, device]));
    const down = new Set(devices.filter((device) => deriveDeviceStatus(device, now) === "down").map((device) => device.id));
    const parent = await this.parents(collector, devices, now);
    const since = await this.downSince([...down]);
    const actions: string[] = [];

    for (const id of down) {
      const device = byId.get(id)!;
      const from = since.get(id);
      // Ya estaba caído antes de que hubiera historial: se ve en la pantalla, pero no se avisa.
      if (device.alertsMuted || !from) continue;
      if (now.getTime() - from.getTime() < (device.role === "ap" ? AP_DOWN_ALERT_MS : DEVICE_DOWN_ALERT_MS)) continue;
      // Lo explica un equipo de más arriba que también está caído: el aviso es por ése.
      if (this.ancestors(id, parent).some((ancestor) => down.has(ancestor))) continue;

      const behind = this.descendants(id, parent).filter((other) => down.has(other)).map((other) => byId.get(other)!.name);
      const verb = device.role === "ap" ? "está desconectado del controlador" : "no responde";
      const detail =
        `${device.name} ${verb} desde hace ${duration(from, now)}` +
        (behind.length
          ? `; también quedaron sin respuesta ${behind.length} equipo${behind.length === 1 ? " que depende" : "s que dependen"} de él (${behind.slice(0, 5).join(", ")}${behind.length > 5 ? "…" : ""})`
          : "") +
        ".";
      const alert = open.find((item) => item.kind === "device_down" && item.deviceId === id);
      if (!alert) {
        actions.push(
          await this.openAlert(
            { collector, kind: "device_down", deviceId: id, detail },
            {
              title: `Red: ${device.name} ${verb}`,
              ticketTitle: `Red: ${device.name} ${verb}`,
              ticketBody:
                `${detail}\n\nVer el equipo en Gestión IT → Red en vivo. Revisar alimentación, el cable o la fibra de subida ` +
                `y, si es un AP, el puerto PoE del switch.`,
              priority: device.role === "ap" ? TicketPriority.MEDIUM : TicketPriority.HIGH,
            },
            now,
          ),
        );
      } else if (this.due(alert, now)) {
        actions.push(await this.renotify(alert, `Red: ${device.name} sigue sin responder`, detail, now));
      }
    }

    for (const alert of open.filter((item) => item.kind === "device_down" && item.collector === collector)) {
      const device = alert.deviceId ? byId.get(alert.deviceId) : undefined;
      if (!device) {
        actions.push(await this.resolve(alert, now, null));
      } else if (device.alertsMuted) {
        actions.push(await this.resolve(alert, now, null));
      } else if (deriveDeviceStatus(device, now) === "ok") {
        actions.push(
          await this.resolve(alert, now, {
            title: `Red: ${device.name} volvió`,
            body: `${device.name} vuelve a responder después de ${duration(alert.openedAt, now)} con aviso.`,
          }),
        );
      }
      // "Sin datos" (un AP cuando UniFi no contestó) no cierra ni reabre nada: se espera.
    }

    return actions;
  }

  /** Silencia (o vuelve a escuchar) un equipo; silenciarlo cierra su aviso abierto sin notificar. */
  static async setMuted(deviceId: string, muted: boolean, now = new Date()) {
    const exists = await prisma.networkLiveDevice.findUnique({ where: { id: deviceId }, select: { id: true } });
    if (!exists) return null;
    const device = await prisma.networkLiveDevice.update({
      where: { id: deviceId },
      data: { alertsMuted: muted },
      select: { id: true, name: true, alertsMuted: true },
    });
    if (muted) {
      const open = await prisma.networkLiveAlert.findMany({ where: { deviceId, resolvedAt: null } });
      for (const alert of open) await this.resolve(alert, now, null);
    }
    return device;
  }

  // ─── Árbol ──────────────────────────────────────────────────────────────────

  /** Padre de cada equipo, recorriendo los enlaces desde el router (o el núcleo si no hay router). */
  private static async parents(collector: string, devices: WatchedDevice[], now: Date) {
    const links = await prisma.networkLiveLink.findMany({
      where: { collector, lastSeenAt: { gte: new Date(now.getTime() - TREE_LINKS_MS) } },
      select: { aDeviceId: true, bDeviceId: true },
    });
    const adjacency = new Map<string, string[]>();
    for (const link of links) {
      adjacency.set(link.aDeviceId, [...(adjacency.get(link.aDeviceId) ?? []), link.bDeviceId]);
      adjacency.set(link.bDeviceId, [...(adjacency.get(link.bDeviceId) ?? []), link.aDeviceId]);
    }
    const roots = devices.filter((device) => device.role === "router");
    const start = roots.length ? roots : devices.filter((device) => device.role === "core");
    const parent = new Map<string, string>();
    const seen = new Set(start.map((device) => device.id));
    const queue = start.map((device) => device.id);
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        parent.set(next, current);
        queue.push(next);
      }
    }
    return parent;
  }

  private static ancestors(id: string, parent: Map<string, string>) {
    const list: string[] = [];
    for (let current = parent.get(id); current && !list.includes(current); current = parent.get(current)) list.push(current);
    return list;
  }

  private static descendants(id: string, parent: Map<string, string>) {
    return [...parent.keys()].filter((other) => this.ancestors(other, parent).includes(id));
  }

  /** Desde cuándo está caído cada equipo según el historial (último device_down sin device_up después). */
  private static async downSince(ids: string[]) {
    if (!ids.length) return new Map<string, Date>();
    const latest = await prisma.networkLiveEvent.findMany({
      where: { deviceId: { in: ids }, kind: { in: ["device_down", "device_up"] } },
      orderBy: { at: "desc" },
      distinct: ["deviceId"],
      select: { deviceId: true, kind: true, at: true },
    });
    return new Map(
      latest
        .filter((event) => event.kind === "device_down" && event.deviceId)
        .map((event) => [event.deviceId as string, event.at]),
    );
  }

  // ─── Avisos ─────────────────────────────────────────────────────────────────

  private static due(alert: NetworkLiveAlert, now: Date) {
    return !alert.lastNotifiedAt || now.getTime() - alert.lastNotifiedAt.getTime() >= RE_NOTIFY_MS;
  }

  /** A quién se avisa: todo IT (ADMIN y AGENT) activo. */
  private static async recipients() {
    return prisma.user.findMany({
      where: { role: { in: [UserRole.ADMIN, UserRole.AGENT] }, isActive: true, deletedAt: null },
      select: { id: true, role: true },
    });
  }

  private static async push(title: string, body: string) {
    const recipients = await this.recipients();
    if (!recipients.length) {
      logger.error({ title }, "Aviso de red sin nadie de IT (ADMIN o AGENT) activo a quien mandarlo");
      return;
    }
    await Promise.allSettled(recipients.map((user) => PushService.sendToUser(user.id, { title, body, url: NETWORK_URL })));
  }

  private static async openAlert(
    alert: { collector: string; kind: string; deviceId: string | null; detail: string },
    notice: { title: string; ticketTitle: string; ticketBody: string; priority: TicketPriority },
    now: Date,
  ) {
    // El registro va primero: el recordatorio depende de lastNotifiedAt, no de que el push o el
    // ticket hayan salido bien (así una falla no se convierte en un aviso por minuto).
    const created = await prisma.networkLiveAlert.create({
      data: { ...alert, detail: alert.detail.slice(0, 500), openedAt: now, lastNotifiedAt: now },
    });

    // El ticket lo "pide" un ADMIN (como el del laboratorio); si no hay ninguno, alguien de IT.
    const recipients = await this.recipients();
    const requester = recipients.find((user) => user.role === UserRole.ADMIN) ?? recipients[0];
    if (requester) {
      try {
        const ticket = await TicketsService.createTicket(
          { title: notice.ticketTitle.slice(0, 200), description: notice.ticketBody, priority: notice.priority, category: TicketCategory.RED },
          requester.id,
        );
        await prisma.networkLiveAlert.update({ where: { id: created.id }, data: { ticketId: ticket.id } });
      } catch (error) {
        // Que falle el ticket no puede impedir el push: son caminos independientes a propósito.
        logger.error({ err: error, alert: created.id }, "No se pudo crear el ticket del aviso de red");
      }
    }
    await this.push(notice.title, alert.detail);
    logger.warn({ kind: alert.kind, deviceId: alert.deviceId, detail: alert.detail }, "Red en vivo: aviso abierto");
    return `abierto:${alert.kind}:${alert.deviceId ?? alert.collector}`;
  }

  private static async renotify(alert: NetworkLiveAlert, title: string, body: string, now: Date) {
    await prisma.networkLiveAlert.update({ where: { id: alert.id }, data: { lastNotifiedAt: now, detail: body.slice(0, 500) } });
    await this.push(title, body);
    return `recordado:${alert.kind}:${alert.deviceId ?? alert.collector}`;
  }

  /** Cierra el aviso y su ticket; con `notice` avisa que volvió (sin él, cierre silencioso). */
  private static async resolve(alert: NetworkLiveAlert, now: Date, notice: { title: string; body: string } | null) {
    await prisma.networkLiveAlert.update({ where: { id: alert.id }, data: { resolvedAt: now } });
    if (alert.ticketId) {
      try {
        await prisma.ticket.update({ where: { id: alert.ticketId }, data: { status: "RESOLVED", closedAt: now } });
      } catch (error) {
        logger.warn({ err: error, ticketId: alert.ticketId }, "No se pudo cerrar el ticket del aviso de red (¿lo cerraron a mano?)");
      }
    }
    if (notice) await this.push(notice.title, notice.body);
    return `cerrado:${alert.kind}:${alert.deviceId ?? alert.collector}`;
  }

  private static async event(collector: string, kind: string, deviceId: string | null, at: Date, detail: Prisma.InputJsonObject) {
    await prisma.networkLiveEvent.create({ data: { collector, kind, deviceId, at, detail } });
  }
}

export default NetworkWatchdog;
