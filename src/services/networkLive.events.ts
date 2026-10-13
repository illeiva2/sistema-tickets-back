import type { Prisma } from "@prisma/client";
import type { LiveDeviceInput, LivePortInput, StoredPort } from "./networkLive.service";

/**
 * Historial de Red en vivo: qué cambió entre lo guardado y lo que trajo el colector. Son reglas
 * puras (sin base) para poder probarlas solas; la ingesta las aplica y escribe los eventos.
 */
export const LIVE_EVENT_KINDS = [
  "device_new",
  "device_down",
  "device_up",
  "device_restart",
  "port_down",
  "port_up",
  "port_speed",
  "link_new",
  "endpoint_new",
  "endpoint_moved",
  "collector_silent",
  "collector_back",
] as const;

export type LiveEventKind = (typeof LIVE_EVENT_KINDS)[number];
export type LiveEventInput = Prisma.NetworkLiveEventCreateManyInput & { kind: LiveEventKind };

/** Un uptime que baja más de un minuto entre dos envíos es un reinicio (no un reloj que corre raro). */
const RESTART_MARGIN_S = 60;

/** Caída, vuelta (y si volvió reiniciado), reinicio sin caída visible o equipo nuevo. */
export const deviceEvents = (
  collector: string,
  deviceId: string,
  stored: { reachable: boolean; uptimeSeconds: number | null } | null,
  incoming: LiveDeviceInput,
  at: Date,
): LiveEventInput[] => {
  const base = { collector, deviceId, at };
  if (!stored) return [{ ...base, kind: "device_new" }];

  const restarted =
    incoming.reachable &&
    stored.uptimeSeconds != null &&
    incoming.uptimeSeconds != null &&
    incoming.uptimeSeconds + RESTART_MARGIN_S < stored.uptimeSeconds;

  if (stored.reachable === true && !incoming.reachable) {
    return [{ ...base, kind: "device_down", detail: { error: incoming.error ?? null } }];
  }
  if (stored.reachable === false && incoming.reachable) {
    return [{ ...base, kind: "device_up", detail: { restarted: Boolean(restarted) } }];
  }
  if (restarted) {
    return [{ ...base, kind: "device_restart", detail: { uptimeSeconds: incoming.uptimeSeconds ?? null } }];
  }
  return [];
};

/** Enlace que cae o vuelve, o que cambia de velocidad sin caerse (un cable que negocia a 100). */
export const portEvent = (
  collector: string,
  deviceId: string,
  stored: StoredPort | undefined,
  incoming: LivePortInput,
  at: Date,
): LiveEventInput | null => {
  if (!stored) return null;
  const base = { collector, deviceId, portKey: incoming.key, at };
  if (stored.linkUp !== incoming.linkUp) {
    return incoming.linkUp
      ? { ...base, kind: "port_up", detail: { name: incoming.name, speedMbps: incoming.speedMbps ?? null } }
      : { ...base, kind: "port_down", detail: { name: incoming.name } };
  }
  const from = stored.speedMbps ?? null;
  const to = incoming.speedMbps ?? null;
  if (incoming.linkUp && from !== null && to !== null && from !== to) {
    return { ...base, kind: "port_speed", detail: { name: incoming.name, from, to } };
  }
  return null;
};

/**
 * Un equipo que pasa de un AP a otro (un celular que se mueve por la planta) no es una mudanza:
 * son cientos por día y tapaban el resto del historial. Sí cuentan el paso entre cable y Wi-Fi y
 * los clientes de un AP que cambió de puerto.
 */
export const isWifiRoaming = (fromVia: string | null, toVia: string | null) =>
  fromVia !== null && toVia !== null && fromVia !== toVia;

/** Varios puertos (un LAG) en una sola clave, dentro del largo de la columna. */
export const portList = (ports: string[]) => (ports.length ? ports.join("+").slice(0, 64) : null);
