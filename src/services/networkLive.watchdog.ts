import { TicketCategory, TicketPriority, UserRole, type NetworkLiveAlert, type Prisma } from "@prisma/client";
import { prisma } from "../lib/database";
import { logger } from "../lib/logger";
import { deriveDeviceStatus, retiredDeviceIds } from "./networkLive.service";
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
/**
 * Caídas que empiezan con menos de 15 min entre una y otra son un mismo incidente: un ticket y un
 * push. El 15-oct-2026 un problema del núcleo abrió 25 tickets en 40 minutos, uno por equipo.
 */
export const INCIDENT_WINDOW_MS = 15 * 60_000;
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

/** Equipo caído que pasó el umbral, con el texto que va al aviso. */
interface DeviceDown {
  device: WatchedDevice;
  verb: string;
  detail: string;
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
 * - Varias caídas casi juntas son un mismo incidente: un ticket y un push, aunque no cuelguen una
 *   de otra (cuando el núcleo falla, los switches dejan de responder antes que él).
 * - Lo que el colector dejó de informar (un switch reemplazado) está retirado, no caído: no se vigila.
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
            ...(await this.openAlert(
              collector.slug,
              "collector_silent",
              [{ deviceId: null, detail }],
              {
                title: "Red: el colector no manda datos",
                ticketTitle: "Red en vivo: el colector de srv-datos no manda datos",
                ticketBody: `${detail}\n\nRevisar en srv-datos la tarea programada "\\GRF\\Colector de red" y sus logs en C:\\ProgramData\\GRF\\NetCollector\\logs, y que el servidor tenga salida a internet.`,
                priority: TicketPriority.HIGH,
                pushBody: detail,
              },
              now,
            )),
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
    const retired = retiredDeviceIds(devices);
    const down = new Set(
      devices
        .filter((device) => !retired.has(device.id) && deriveDeviceStatus(device, now) === "down")
        .map((device) => device.id),
    );
    const parent = await this.parents(collector, devices, now);
    const since = await this.downSince([...down]);
    const actions: string[] = [];
    const fresh: DeviceDown[] = [];
    const ongoing: (DeviceDown & { alert: NetworkLiveAlert })[] = [];

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
      if (alert) ongoing.push({ device, verb, detail, alert });
      else fresh.push({ device, verb, detail });
    }

    if (fresh.length) actions.push(...(await this.openDeviceAlerts(collector, fresh, open, now)));
    actions.push(...(await this.remind(ongoing, now)));

    for (const alert of open.filter((item) => item.kind === "device_down" && item.collector === collector)) {
      const device = alert.deviceId ? byId.get(alert.deviceId) : undefined;
      if (!device || device.alertsMuted || retired.has(device.id)) {
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

  /**
   * Abre los avisos de los equipos que acaban de pasar el umbral. Las caídas de esta vuelta van en
   * un solo ticket y un solo push; si hay un incidente abierto cuya última caída fue hace menos de
   * 15 min, se suman a su ticket con un comentario y sin otro push.
   */
  private static async openDeviceAlerts(collector: string, fresh: DeviceDown[], open: NetworkLiveAlert[], now: Date) {
    const incident = open
      .filter((alert) => alert.kind === "device_down" && alert.collector === collector && alert.ticketId)
      .filter((alert) => now.getTime() - alert.openedAt.getTime() <= INCIDENT_WINDOW_MS)
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())[0];

    if (incident?.ticketId) {
      for (const item of fresh) {
        await prisma.networkLiveAlert.create({
          data: {
            collector,
            kind: "device_down",
            deviceId: item.device.id,
            detail: item.detail.slice(0, 500),
            openedAt: now,
            lastNotifiedAt: now,
            ticketId: incident.ticketId,
          },
        });
      }
      await this.comment(incident.ticketId, `Se sumaron a este incidente:\n${fresh.map((item) => `- ${item.detail}`).join("\n")}`);
      logger.warn({ ticketId: incident.ticketId, devices: fresh.map((item) => item.device.id) }, "Red en vivo: caídas sumadas a un incidente abierto");
      return fresh.map((item) => `sumado:device_down:${item.device.id}`);
    }

    const priority = fresh.some((item) => item.device.role !== "ap") ? TicketPriority.HIGH : TicketPriority.MEDIUM;
    if (fresh.length === 1) {
      const [{ device, verb, detail }] = fresh;
      return this.openAlert(
        collector,
        "device_down",
        [{ deviceId: device.id, detail }],
        {
          title: `Red: ${device.name} ${verb}`,
          ticketTitle: `Red: ${device.name} ${verb}`,
          ticketBody:
            `${detail}\n\nVer el equipo en Gestión IT → Red en vivo. Revisar alimentación, el cable o la fibra de subida ` +
            `y, si es un AP, el puerto PoE del switch.`,
          priority,
          pushBody: detail,
        },
        now,
      );
    }

    const names = fresh.map((item) => item.device.name);
    const title = `Red: ${fresh.length} equipos sin respuesta`;
    return this.openAlert(
      collector,
      "device_down",
      fresh.map((item) => ({ deviceId: item.device.id, detail: item.detail })),
      {
        title,
        ticketTitle: title,
        ticketBody:
          `${fresh.map((item) => `- ${item.detail}`).join("\n")}\n\nVer los equipos en Gestión IT → Red en vivo. Cuando caen ` +
          `varios a la vez suele ser un equipo de más arriba, la alimentación o la conexión con el controlador UniFi.`,
        priority,
        pushBody: `${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""} dejaron de responder.`,
      },
      now,
    );
  }

  /** Un aviso por incidente: un registro por equipo, un ticket y un push para todos. */
  private static async openAlert(
    collector: string,
    kind: string,
    items: { deviceId: string | null; detail: string }[],
    notice: { title: string; ticketTitle: string; ticketBody: string; priority: TicketPriority; pushBody: string },
    now: Date,
  ) {
    // El registro va primero: el recordatorio depende de lastNotifiedAt, no de que el push o el
    // ticket hayan salido bien (así una falla no se convierte en un aviso por minuto).
    const created: NetworkLiveAlert[] = [];
    for (const item of items) {
      created.push(
        await prisma.networkLiveAlert.create({
          data: { collector, kind, deviceId: item.deviceId, detail: item.detail.slice(0, 500), openedAt: now, lastNotifiedAt: now },
        }),
      );
    }

    // El ticket lo "pide" un ADMIN (como el del laboratorio); si no hay ninguno, alguien de IT.
    const recipients = await this.recipients();
    const requester = recipients.find((user) => user.role === UserRole.ADMIN) ?? recipients[0];
    if (requester) {
      try {
        const ticket = await TicketsService.createTicket(
          { title: notice.ticketTitle.slice(0, 200), description: notice.ticketBody, priority: notice.priority, category: TicketCategory.RED },
          requester.id,
        );
        for (const alert of created) {
          await prisma.networkLiveAlert.update({ where: { id: alert.id }, data: { ticketId: ticket.id } });
        }
      } catch (error) {
        // Que falle el ticket no puede impedir el push: son caminos independientes a propósito.
        logger.error({ err: error, alerts: created.map((alert) => alert.id) }, "No se pudo crear el ticket del aviso de red");
      }
    }
    await this.push(notice.title, notice.pushBody);
    logger.warn({ kind, devices: items.map((item) => item.deviceId), title: notice.title }, "Red en vivo: aviso abierto");
    return items.map((item) => `abierto:${kind}:${item.deviceId ?? collector}`);
  }

  /** Recordatorio cada 6 h, uno por incidente: los avisos que comparten ticket se recuerdan juntos. */
  private static async remind(ongoing: (DeviceDown & { alert: NetworkLiveAlert })[], now: Date) {
    const incidents = new Map<string, (DeviceDown & { alert: NetworkLiveAlert })[]>();
    for (const item of ongoing) {
      const key = item.alert.ticketId ?? item.alert.id;
      incidents.set(key, [...(incidents.get(key) ?? []), item]);
    }

    const actions: string[] = [];
    for (const items of incidents.values()) {
      if (!items.some((item) => this.due(item.alert, now))) continue;
      if (items.length === 1) {
        const [{ alert, device, detail }] = items;
        actions.push(await this.renotify(alert, `Red: ${device.name} sigue sin responder`, detail, now));
        continue;
      }
      for (const item of items) {
        await prisma.networkLiveAlert.update({
          where: { id: item.alert.id },
          data: { lastNotifiedAt: now, detail: item.detail.slice(0, 500) },
        });
      }
      const names = items.map((item) => item.device.name);
      await this.push(
        `Red: ${items.length} equipos siguen sin responder`,
        `${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""}.`,
      );
      actions.push(...items.map((item) => `recordado:${item.alert.kind}:${item.device.id}`));
    }
    return actions;
  }

  private static async renotify(alert: NetworkLiveAlert, title: string, body: string, now: Date) {
    await prisma.networkLiveAlert.update({ where: { id: alert.id }, data: { lastNotifiedAt: now, detail: body.slice(0, 500) } });
    await this.push(title, body);
    return `recordado:${alert.kind}:${alert.deviceId ?? alert.collector}`;
  }

  /**
   * Cierra el aviso; con `notice` avisa que volvió (sin él, cierre silencioso). Si el ticket es de
   * un incidente con varios equipos, queda abierto hasta que vuelve el último, y recién ahí se avisa.
   */
  private static async resolve(alert: NetworkLiveAlert, now: Date, notice: { title: string; body: string } | null) {
    await prisma.networkLiveAlert.update({ where: { id: alert.id }, data: { resolvedAt: now } });
    const action = `cerrado:${alert.kind}:${alert.deviceId ?? alert.collector}`;
    if (alert.ticketId) {
      const stillOpen = await prisma.networkLiveAlert.count({
        where: { ticketId: alert.ticketId, resolvedAt: null, id: { not: alert.id } },
      });
      if (stillOpen > 0) return action;

      const total = await prisma.networkLiveAlert.count({ where: { ticketId: alert.ticketId } });
      if (notice && total > 1) {
        const first = await prisma.networkLiveAlert.findFirst({
          where: { ticketId: alert.ticketId },
          orderBy: { openedAt: "asc" },
          select: { openedAt: true },
        });
        notice = {
          title: `Red: volvieron los ${total} equipos del incidente`,
          body: `Todos vuelven a responder después de ${duration(first?.openedAt ?? alert.openedAt, now)}.`,
        };
      }
      try {
        await prisma.ticket.update({ where: { id: alert.ticketId }, data: { status: "RESOLVED", closedAt: now } });
      } catch (error) {
        logger.warn({ err: error, ticketId: alert.ticketId }, "No se pudo cerrar el ticket del aviso de red (¿lo cerraron a mano?)");
      }
    }
    if (notice) await this.push(notice.title, notice.body);
    return action;
  }

  /** Comentario en el ticket del incidente, a nombre del mismo usuario que lo pidió. */
  private static async comment(ticketId: string, message: string) {
    try {
      const recipients = await this.recipients();
      const author = recipients.find((user) => user.role === UserRole.ADMIN) ?? recipients[0];
      if (!author) return;
      await prisma.comment.create({ data: { ticketId, authorId: author.id, message } });
    } catch (error) {
      logger.warn({ err: error, ticketId }, "No se pudo comentar el ticket del incidente de red");
    }
  }

  private static async event(collector: string, kind: string, deviceId: string | null, at: Date, detail: Prisma.InputJsonObject) {
    await prisma.networkLiveEvent.create({ data: { collector, kind, deviceId, at, detail } });
  }
}

export default NetworkWatchdog;
