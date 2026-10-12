import { isIP } from "node:net";
import { z } from "zod";
import { LIVE_EVENT_KINDS } from "../services/networkLive.events";

export const LIVE_SOURCES = ["routeros", "snmp", "unifi"] as const;
export const LIVE_ROLES = ["router", "core", "access", "ap"] as const;
export const LIVE_PORT_KINDS = ["copper", "sfp", "sfpplus", "combo", "wireless", "other"] as const;
export const LIVE_NEIGHBOR_PROTOCOLS = ["lldp", "mndp", "cdp", "unifi", "other"] as const;
export const LIVE_LINK_SOURCES = ["lldp", "fdb"] as const;

export const MAX_LIVE_DEVICES = 300;
export const MAX_LIVE_PORTS = 1000;
export const MAX_LIVE_LINKS = 2000;
export const MAX_LIVE_ENDPOINTS = 10_000;
export const MAX_LIVE_WIFI_CLIENTS = 5_000;

// Lo que mandan los equipos se limpia en vez de rechazarse: un nombre con un
// carácter de control o un modelo demasiado largo no puede tirar abajo el envío
// de toda la planta. Lo estructural (claves, roles, booleanos) sí se exige.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const clean = (value: unknown, max: number) => {
  if (typeof value !== "string") return value;
  const text = value.replace(CONTROL_CHARS, "").trim();
  return text === "" ? null : text.slice(0, max);
};

const optionalText = (max: number) =>
  z.preprocess((value) => clean(value, max), z.string().nullish());

const requiredText = (max: number) =>
  z.preprocess((value) => clean(value, max), z.string().min(1));

/** MAC en formato AA:BB:CC:DD:EE:FF; lo que no es una MAC queda en null. */
const lenientMac = z.preprocess((value) => {
  if (typeof value !== "string") return null;
  const compact = value.replace(/[.\-:\s]/g, "").toUpperCase();
  return /^[0-9A-F]{12}$/.test(compact) ? compact.match(/.{2}/g)!.join(":") : null;
}, z.string().nullable());

/** IP v4 o v6; lo que no es una IP queda en null. */
const lenientIp = z.preprocess((value) => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return isIP(text) !== 0 ? text : null;
}, z.string().nullable());

const optionalInt = (min: number, max: number) =>
  z.number().int().min(min).max(max).nullish();

const neighborSchema = z.object({
  protocol: z.enum(LIVE_NEIGHBOR_PROTOCOLS).catch("other"),
  name: optionalText(120),
  mac: lenientMac,
  ip: lenientIp,
  port: optionalText(120),
  platform: optionalText(120),
});

const portSchema = z.object({
  key: requiredText(64),
  name: requiredText(120),
  description: optionalText(200),
  position: z.number().int().min(0).max(100_000),
  kind: z.enum(LIVE_PORT_KINDS).catch("other"),
  adminUp: z.boolean(),
  linkUp: z.boolean(),
  speedMbps: optionalInt(0, 1_000_000),
  fullDuplex: z.boolean().nullish(),
  pvid: optionalInt(1, 4094),
  neighbors: z.array(neighborSchema).max(16).nullish(),
});

const deviceSchema = z.object({
  key: requiredText(120),
  source: z.enum(LIVE_SOURCES),
  role: z.enum(LIVE_ROLES),
  reachable: z.boolean(),
  error: optionalText(300),
  pollMs: optionalInt(0, 3_600_000),
  name: optionalText(120),
  managementIp: lenientIp.optional(),
  macAddress: lenientMac.optional(),
  vendor: optionalText(60),
  model: optionalText(80),
  firmware: optionalText(80),
  serialNumber: optionalText(80),
  uptimeSeconds: optionalInt(0, 2_000_000_000),
  clients: optionalInt(0, 100_000),
  ports: z
    .array(portSchema)
    .max(MAX_LIVE_PORTS)
    .nullish()
    // Un puerto repetido se descarta (queda el primero) en vez de rechazar el envío.
    .transform((ports) => {
      if (!ports) return ports;
      const seen = new Set<string>();
      return ports.filter((port) => !seen.has(port.key) && seen.add(port.key));
    }),
});

const linkEndSchema = z.object({
  device: requiredText(120),
  ports: z.array(requiredText(64)).max(8),
});

const linkSchema = z.object({
  a: linkEndSchema,
  b: linkEndSchema,
  source: z.enum(LIVE_LINK_SOURCES).catch("fdb"),
});

/** MAC obligatoria: un equipo final sin MAC válida se descarta (ver el transform del envío). */
const requiredMac = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const compact = value.replace(/[.\-:\s]/g, "").toUpperCase();
  return /^[0-9A-F]{12}$/.test(compact) ? compact.match(/.{2}/g)!.join(":") : null;
}, z.string().nullable());

const endpointSchema = z.object({
  mac: requiredMac,
  device: requiredText(120),
  port: requiredText(64),
  vlan: optionalInt(1, 4094),
  ip: lenientIp.optional(),
  hostname: optionalText(120),
  via: optionalText(120),
  shared: z.boolean().nullish(),
});

/** Cliente Wi-Fi según UniFi: lo raro (banda desconocida, señal positiva) queda en null. */
const wifiClientSchema = z.object({
  mac: requiredMac,
  ap: requiredText(120),
  ssid: optionalText(64),
  band: z.enum(["2.4", "5", "6"]).nullish().catch(null),
  channel: optionalInt(1, 299).catch(null),
  signal: optionalInt(-130, -1).catch(null),
  txKbps: optionalInt(0, 100_000_000).catch(null),
  rxKbps: optionalInt(0, 100_000_000).catch(null),
  uptimeSeconds: optionalInt(0, 2_000_000_000).catch(null),
  hostname: optionalText(120),
  ip: lenientIp.optional(),
  vlan: optionalInt(1, 4094).catch(null),
});

export const networkLiveSearchSchema = z
  .object({
    q: z.string().trim().min(2, "Escribí al menos 2 caracteres").max(100),
  })
  .strict();

/** Historial: desde/hasta (por defecto, las últimas 24 h), equipo y puerto, MAC, tipos y tope. */
export const networkLiveEventsSchema = z
  .object({
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    deviceId: z.string().trim().min(1).max(40).optional(),
    portKey: z.string().trim().min(1).max(64).optional(),
    mac: requiredMac.optional().refine((value) => value !== null, "MAC inválida"),
    kinds: z
      .string()
      .max(400)
      .optional()
      .transform((value) => (value ? value.split(",").map((kind) => kind.trim()).filter(Boolean) : undefined))
      .pipe(z.array(z.enum(LIVE_EVENT_KINDS)).max(LIVE_EVENT_KINDS.length).optional()),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict()
  .refine((query) => !query.portKey || query.deviceId, { message: "El puerto va con su equipo", path: ["portKey"] });

/** Silenciar (o volver a escuchar) las alertas de un equipo. */
export const networkLiveMuteSchema = z.object({
  params: z.object({ id: z.string().trim().min(1).max(40) }),
  body: z.object({ muted: z.boolean() }).strict(),
});

/**
 * Envío del colector de red. A diferencia del agente de las PCs, no es
 * `.strict()`: un colector más nuevo puede mandar campos que este back todavía
 * no conoce y se descartan sin rechazar el envío.
 */
export const collectorSnapshotSchema = z.object({
  body: z.object({
    collector: z.object({
      version: optionalText(32),
      host: optionalText(64),
    }),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    devices: z
      .array(deviceSchema)
      .max(MAX_LIVE_DEVICES)
      .transform((devices) => {
        const seen = new Set<string>();
        return devices.filter((device) => !seen.has(device.key) && seen.add(device.key));
      }),
    links: z.array(linkSchema).max(MAX_LIVE_LINKS).default([]),
    // Ausente = el colector no informó equipos finales (versión vieja): no se toca lo guardado.
    endpoints: z
      .array(endpointSchema)
      .max(MAX_LIVE_ENDPOINTS)
      .optional()
      .transform((endpoints) => {
        if (!endpoints) return endpoints;
        const seen = new Set<string>();
        return endpoints.filter(
          (endpoint) => endpoint.mac !== null && !seen.has(endpoint.mac) && seen.add(endpoint.mac),
        );
      }),
    // Sólo en las corridas que leen UniFi (cada 5 min); ausente = no se toca lo guardado.
    wifiClients: z
      .array(wifiClientSchema)
      .max(MAX_LIVE_WIFI_CLIENTS)
      .optional()
      .transform((clients) => {
        if (!clients) return clients;
        const seen = new Set<string>();
        return clients.filter((client) => client.mac !== null && !seen.has(client.mac) && seen.add(client.mac));
      }),
  }),
});
