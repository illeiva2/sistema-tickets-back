import { isIP } from "node:net";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/database";
import { deviceEvents, isWifiRoaming, portEvent, portList, type LiveEventInput } from "./networkLive.events";

// Formas ya validadas por src/validations/networkLive.ts. Se tipan a mano porque
// el tsconfig no es estricto y la inferencia de Zod no sirve (igual que en lab).
export interface LiveNeighborInput {
  protocol: string;
  name?: string | null;
  mac?: string | null;
  ip?: string | null;
  port?: string | null;
  platform?: string | null;
}

export interface LivePortInput {
  key: string;
  name: string;
  description?: string | null;
  position: number;
  kind: string;
  adminUp: boolean;
  linkUp: boolean;
  speedMbps?: number | null;
  fullDuplex?: boolean | null;
  pvid?: number | null;
  neighbors?: LiveNeighborInput[] | null;
  poe?: { status: string; powerW?: number | null; class?: number | null } | null;
}

export interface LiveDeviceInput {
  key: string;
  source: string;
  role: string;
  reachable: boolean;
  error?: string | null;
  pollMs?: number | null;
  name?: string | null;
  managementIp?: string | null;
  macAddress?: string | null;
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
  serialNumber?: string | null;
  uptimeSeconds?: number | null;
  clients?: number | null;
  poeBudgetW?: number | null;
  poeUsedW?: number | null;
  ports?: LivePortInput[] | null;
}

export interface LiveLinkInput {
  a: { device: string; ports: string[] };
  b: { device: string; ports: string[] };
  source: string;
}

export interface LiveEndpointInput {
  mac: string;
  device: string;
  port: string;
  vlan?: number | null;
  ip?: string | null;
  hostname?: string | null;
  via?: string | null;
  shared?: boolean | null;
}

export interface LiveWifiClientInput {
  mac: string;
  ap: string;
  ssid?: string | null;
  band?: string | null;
  channel?: number | null;
  signal?: number | null;
  txKbps?: number | null;
  rxKbps?: number | null;
  uptimeSeconds?: number | null;
  hostname?: string | null;
  ip?: string | null;
  vlan?: number | null;
}

export interface CollectorSnapshotInput {
  collector: { version?: string | null; host?: string | null };
  startedAt: string;
  finishedAt: string;
  devices: LiveDeviceInput[];
  links: LiveLinkInput[];
  /** Ausente en colectores 0.1: en ese caso no se tocan los equipos finales guardados. */
  endpoints?: LiveEndpointInput[];
  /** Sólo en las corridas que leen UniFi (colector 0.3+); ausente = no se toca lo guardado. */
  wifiClients?: LiveWifiClientInput[];
}

export type LiveDeviceStatus = "ok" | "down" | "stale";

/**
 * Router y switches se sondean cada minuto: sin noticias en 3 min, el dato ya no
 * es "en vivo". Los APs llegan desde UniFi cada 5 min, así que tienen más margen.
 */
export const DEVICE_STALE_AFTER_MS = 3 * 60_000;
export const AP_STALE_AFTER_MS = 12 * 60_000;
export const COLLECTOR_STALE_AFTER_MS = 3 * 60_000;
/** Un enlace que faltó en los últimos envíos se sigue mostrando un rato: no parpadea. */
export const LINK_VISIBLE_MS = 10 * 60_000;
/** Un enlace sin cambios se "toca" (lastSeenAt) cada tanto, no en cada envío. */
export const LINK_TOUCH_MS = 4 * 60_000;
/** Lo mismo para los equipos finales: son cientos, se tocan cada 5 min si no cambian. */
export const ENDPOINT_TOUCH_MS = 5 * 60_000;
/** Un equipo final que no aparece hace más de 10 min deja de mostrarse como conectado. */
export const ENDPOINT_VISIBLE_MS = 10 * 60_000;
/** La IP de un agente sólo sirve para reconocerlo si informó hace poco: las IPs se reasignan. */
export const AGENT_IP_MATCH_MS = 24 * 60 * 60_000;
/** Los clientes Wi-Fi llegan con UniFi cada 5 min: se muestran mientras sigan en la última lectura. */
export const WIFI_VISIBLE_MS = 12 * 60_000;
/**
 * Un equipo que el colector dejó de informar (lo sacaron de la configuración o del controlador
 * UniFi) se oculta pasada una hora. No se borra: si vuelve a aparecer, se muestra de nuevo.
 */
export const RETIRED_AFTER_MS = 60 * 60_000;

/**
 * Equipos retirados: los que quedaron más de una hora atrás del más reciente de su misma fuente
 * (UniFi o sondeo directo). No se compara contra el reloj para que un corte del colector o del
 * controlador no esconda a todos.
 */
export const retiredDeviceIds = (devices: { id: string; collector: string; source: string; lastPolledAt: Date }[]) => {
  const group = (device: { collector: string; source: string }) =>
    `${device.collector}|${device.source === "unifi" ? "unifi" : "sondeo"}`;
  const newest = new Map<string, number>();
  for (const device of devices) {
    newest.set(group(device), Math.max(newest.get(group(device)) ?? 0, device.lastPolledAt.getTime()));
  }
  return new Set(
    devices
      .filter((device) => (newest.get(group(device)) ?? 0) - device.lastPolledAt.getTime() > RETIRED_AFTER_MS)
      .map((device) => device.id),
  );
};
export const SEARCH_LIMIT = 25;

const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 };

/** El estado no se guarda: se deriva por edad en cada lectura, como en lab. */
export const deriveDeviceStatus = (
  device: { source: string; reachable: boolean; lastPolledAt: Date },
  now: Date,
): LiveDeviceStatus => {
  const limit = device.source === "unifi" ? AP_STALE_AFTER_MS : DEVICE_STALE_AFTER_MS;
  if (now.getTime() - device.lastPolledAt.getTime() > limit) return "stale";
  return device.reachable ? "ok" : "down";
};

type NeighborJson = {
  protocol: string;
  name: string | null;
  mac: string | null;
  ip: string | null;
  port: string | null;
  platform: string | null;
};

/** Orden estable para que el mismo conjunto de vecinos no cuente como cambio. */
export const normalizeNeighbors = (neighbors?: LiveNeighborInput[] | null): NeighborJson[] | null => {
  if (!neighbors?.length) return null;
  return neighbors
    .map((n) => ({
      protocol: n.protocol,
      name: n.name ?? null,
      mac: n.mac ?? null,
      ip: n.ip ?? null,
      port: n.port ?? null,
      platform: n.platform ?? null,
    }))
    .sort((x, y) =>
      `${x.mac ?? ""}|${x.name ?? ""}|${x.port ?? ""}`.localeCompare(`${y.mac ?? ""}|${y.name ?? ""}|${y.port ?? ""}`),
    );
};

/**
 * JSON con las claves ordenadas: JSONB devuelve los objetos con otro orden de
 * claves que el que se guardó, y sin esto todo puerto con vecinos "cambiaría"
 * en cada envío.
 */
export const canonicalJson = (value: unknown) =>
  JSON.stringify(value ?? null, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );

export interface StoredPort {
  id: string;
  key: string;
  name: string;
  description: string | null;
  position: number;
  kind: string;
  adminUp: boolean;
  linkUp: boolean;
  speedMbps: number | null;
  fullDuplex: boolean | null;
  pvid: number | null;
  neighbors: Prisma.JsonValue | null;
  poeStatus: string | null;
  poePowerW: number | null;
  poeClass: number | null;
}

/** La potencia PoE de un puerto varía décimas minuto a minuto: se reescribe recién al cambiar medio watt. */
export const POE_POWER_STEP_W = 0.5;

const samePower = (stored: number | null, incoming: number | null) =>
  stored === incoming || (stored !== null && incoming !== null && Math.abs(stored - incoming) < POE_POWER_STEP_W);

/**
 * Qué escribir para un puerto: nada si no cambió (lo normal minuto a minuto),
 * el alta si es nuevo o los campos si cambió algo. Cambio de enlace o de
 * velocidad = nuevo linkChangedAt.
 */
export const planPortWrite = (
  current: StoredPort | undefined,
  incoming: LivePortInput,
  now: Date,
): { kind: "create" | "update"; data: Record<string, unknown> } | null => {
  const neighbors = normalizeNeighbors(incoming.neighbors);
  const fields = {
    name: incoming.name,
    description: incoming.description ?? null,
    position: incoming.position,
    kind: incoming.kind,
    adminUp: incoming.adminUp,
    linkUp: incoming.linkUp,
    speedMbps: incoming.speedMbps ?? null,
    fullDuplex: incoming.fullDuplex ?? null,
    pvid: incoming.pvid ?? null,
  };
  const neighborsValue = neighbors ?? Prisma.DbNull;
  const poe = {
    poeStatus: incoming.poe?.status ?? null,
    poePowerW: incoming.poe?.powerW ?? null,
    poeClass: incoming.poe?.class ?? null,
  };

  if (!current) {
    return { kind: "create", data: { key: incoming.key, ...fields, ...poe, neighbors: neighborsValue } };
  }

  const sameFields = (Object.keys(fields) as (keyof typeof fields)[]).every(
    (field) => (current[field] ?? null) === fields[field],
  );
  const sameNeighbors = canonicalJson(current.neighbors) === canonicalJson(neighbors);
  const samePoe =
    (current.poeStatus ?? null) === poe.poeStatus &&
    (current.poeClass ?? null) === poe.poeClass &&
    samePower(current.poePowerW ?? null, poe.poePowerW);
  if (sameFields && sameNeighbors && samePoe) return null;

  const linkChanged =
    current.linkUp !== fields.linkUp || (current.speedMbps ?? null) !== fields.speedMbps;
  return {
    kind: "update",
    data: { ...fields, ...poe, neighbors: neighborsValue, ...(linkChanged ? { linkChangedAt: now } : {}) },
  };
};

const PORT_SELECT = {
  id: true,
  key: true,
  name: true,
  description: true,
  position: true,
  kind: true,
  adminUp: true,
  linkUp: true,
  speedMbps: true,
  fullDuplex: true,
  pvid: true,
  neighbors: true,
  poeStatus: true,
  poePowerW: true,
  poeClass: true,
} as const;

export class NetworkLiveService {
  // ─── Ingesta (colector) ─────────────────────────────────────────────────────

  static async ingestSnapshot(collector: string, input: CollectorSnapshotInput) {
    const receivedAt = new Date();

    // Un equipo por transacción: si uno falla, el resto del envío igual se guarda
    // y el colector reintenta todo al minuto siguiente.
    for (const device of input.devices) {
      await prisma.$transaction(
        (tx) => NetworkLiveService.saveDevice(tx, collector, device, receivedAt),
        TX_OPTIONS,
      );
    }

    const links = await NetworkLiveService.saveLinks(collector, input.links, receivedAt);
    const endpoints = input.endpoints
      ? await NetworkLiveService.saveEndpoints(collector, input.endpoints, receivedAt)
      : null;
    const wifiClients = input.wifiClients
      ? await NetworkLiveService.saveWifiClients(collector, input.wifiClients, receivedAt)
      : null;
    const devicesOk = input.devices.filter((device) => device.reachable).length;
    const run = {
      version: input.collector.version ?? null,
      host: input.collector.host ?? null,
      lastStartedAt: new Date(input.startedAt),
      lastFinishedAt: new Date(input.finishedAt),
      lastReceivedAt: receivedAt,
      devicesTotal: input.devices.length,
      devicesOk,
    };
    await prisma.networkCollector.upsert({
      where: { slug: collector },
      create: { slug: collector, ...run },
      update: run,
    });

    return {
      devices: input.devices.length,
      devicesOk,
      links,
      ...(endpoints === null ? {} : { endpoints }),
      ...(wifiClients === null ? {} : { wifiClients }),
    };
  }

  /**
   * Clientes Wi-Fi: una fila por MAC con lo último que dijo UniFi. Llegan cada 5 min y la señal
   * cambia en cada lectura, así que se reescriben todos (son decenas). Nada se borra.
   */
  static async saveWifiClients(collector: string, clients: LiveWifiClientInput[], receivedAt: Date) {
    if (!clients.length) return 0;

    const aps = await prisma.networkLiveDevice.findMany({
      where: { collector, key: { in: [...new Set(clients.map((client) => client.ap))] } },
      select: { id: true, key: true },
    });
    const apId = new Map(aps.map((ap) => [ap.key, ap.id]));
    const stored = await prisma.networkLiveWifiClient.findMany({
      where: { collector, macAddress: { in: clients.map((client) => client.mac) } },
      select: { id: true, macAddress: true },
    });
    const storedId = new Map(stored.map((client) => [client.macAddress, client.id]));

    const creates: Prisma.NetworkLiveWifiClientCreateManyInput[] = [];
    const updates: Prisma.PrismaPromise<unknown>[] = [];
    for (const client of clients) {
      const apDeviceId = apId.get(client.ap);
      if (!apDeviceId) continue;
      const fields = {
        apDeviceId,
        ssid: client.ssid ?? null,
        band: client.band ?? null,
        channel: client.channel ?? null,
        signal: client.signal ?? null,
        txKbps: client.txKbps ?? null,
        rxKbps: client.rxKbps ?? null,
        uptimeSeconds: client.uptimeSeconds ?? null,
        hostname: client.hostname ?? null,
        ipAddress: client.ip ?? null,
        vlan: client.vlan ?? null,
        lastSeenAt: receivedAt,
      };
      const id = storedId.get(client.mac);
      if (id) updates.push(prisma.networkLiveWifiClient.update({ where: { id }, data: fields }));
      else creates.push({ collector, macAddress: client.mac, ...fields });
    }

    if (creates.length) await prisma.networkLiveWifiClient.createMany({ data: creates, skipDuplicates: true });
    for (let index = 0; index < updates.length; index += 50) {
      await prisma.$transaction(updates.slice(index, index + 50));
    }
    return creates.length + updates.length;
  }

  /**
   * Equipos finales: una fila por MAC. Sólo se escribe lo que cambió (otro puerto, otra VLAN,
   * IP o nombre nuevos); lo que sigue igual se "toca" cada 5 min. Nada se borra.
   */
  static async saveEndpoints(collector: string, endpoints: LiveEndpointInput[], receivedAt: Date) {
    if (!endpoints.length) return 0;

    const keys = [
      ...new Set(endpoints.flatMap((endpoint) => (endpoint.via ? [endpoint.device, endpoint.via] : [endpoint.device]))),
    ];
    const devices = await prisma.networkLiveDevice.findMany({
      where: { collector, key: { in: keys } },
      select: { id: true, key: true },
    });
    const idByKey = new Map(devices.map((device) => [device.key, device.id]));

    const stored = await prisma.networkLiveEndpoint.findMany({
      where: { collector },
      select: {
        id: true,
        macAddress: true,
        deviceId: true,
        portKey: true,
        vlan: true,
        ipAddress: true,
        hostname: true,
        viaDeviceId: true,
        sharedPort: true,
        lastSeenAt: true,
      },
    });
    const byMac = new Map(stored.map((endpoint) => [endpoint.macAddress, endpoint]));

    const creates: Prisma.NetworkLiveEndpointCreateManyInput[] = [];
    const updates: Prisma.PrismaPromise<unknown>[] = [];
    const touched: string[] = [];
    const events: LiveEventInput[] = [];
    let saved = 0;

    for (const endpoint of endpoints) {
      const deviceId = idByKey.get(endpoint.device);
      if (!deviceId) continue;
      saved++;
      const fields = {
        deviceId,
        portKey: endpoint.port,
        vlan: endpoint.vlan ?? null,
        viaDeviceId: endpoint.via ? (idByKey.get(endpoint.via) ?? null) : null,
        sharedPort: endpoint.shared ?? false,
      };
      const current = byMac.get(endpoint.mac);
      if (!current) {
        creates.push({
          collector,
          macAddress: endpoint.mac,
          ...fields,
          ipAddress: endpoint.ip ?? null,
          hostname: endpoint.hostname ?? null,
          lastSeenAt: receivedAt,
        });
        events.push({
          collector,
          at: receivedAt,
          kind: "endpoint_new",
          deviceId,
          portKey: endpoint.port,
          macAddress: endpoint.mac,
          detail: { vlan: fields.vlan, viaDeviceId: fields.viaDeviceId },
        });
        continue;
      }

      // Si esta vez no vino IP o nombre (el ARP o la concesión vencieron) se conserva lo último conocido.
      const ipAddress = endpoint.ip ?? current.ipAddress;
      const hostname = endpoint.hostname ?? current.hostname;
      const moved = current.deviceId !== fields.deviceId || current.portKey !== fields.portKey;
      const changed =
        moved ||
        current.vlan !== fields.vlan ||
        current.viaDeviceId !== fields.viaDeviceId ||
        current.sharedPort !== fields.sharedPort ||
        current.ipAddress !== ipAddress ||
        current.hostname !== hostname;
      if (changed) {
        updates.push(
          prisma.networkLiveEndpoint.update({
            where: { id: current.id },
            data: { ...fields, ipAddress, hostname, lastSeenAt: receivedAt, ...(moved ? { movedAt: receivedAt } : {}) },
          }),
        );
        // El puerto nuevo (y "llegó a este puerto") se guarda igual; sólo no va al historial.
        if (moved && !isWifiRoaming(current.viaDeviceId, fields.viaDeviceId)) {
          events.push({
            collector,
            at: receivedAt,
            kind: "endpoint_moved",
            deviceId,
            portKey: endpoint.port,
            macAddress: endpoint.mac,
            peerDeviceId: current.deviceId,
            peerPortKey: current.portKey,
            detail: { vlan: fields.vlan, viaDeviceId: fields.viaDeviceId },
          });
        }
      } else if (receivedAt.getTime() - current.lastSeenAt.getTime() >= ENDPOINT_TOUCH_MS) {
        touched.push(current.id);
      }
    }

    if (creates.length) {
      await prisma.networkLiveEndpoint.createMany({ data: creates, skipDuplicates: true });
    }
    for (let index = 0; index < updates.length; index += 50) {
      await prisma.$transaction(updates.slice(index, index + 50));
    }
    if (touched.length) {
      await prisma.networkLiveEndpoint.updateMany({
        where: { id: { in: touched } },
        data: { lastSeenAt: receivedAt },
      });
    }
    if (events.length) await prisma.networkLiveEvent.createMany({ data: events });
    return saved;
  }

  /**
   * Agentes de PC que corresponden a estos equipos finales: por MAC (lo seguro) o, si no, por IP
   * cuando el agente informó hace poco.
   */
  static async agentsFor(endpoints: { macAddress: string; ipAddress: string | null }[], now: Date) {
    const macs = [...new Set(endpoints.map((endpoint) => endpoint.macAddress))];
    const ips = [...new Set(endpoints.map((endpoint) => endpoint.ipAddress).filter((ip): ip is string => Boolean(ip)))];
    if (!macs.length && !ips.length) return { byMac: new Map(), byIp: new Map() };

    const agents = await prisma.agentDevice.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        OR: [
          ...(macs.length ? [{ primaryMac: { in: macs } }] : []),
          ...(ips.length ? [{ primaryIp: { in: ips } }] : []),
        ],
      },
      select: { id: true, hostname: true, loggedInUser: true, primaryMac: true, primaryIp: true, lastSeenAt: true, assetId: true },
    });

    type AgentSummary = { id: string; hostname: string; loggedInUser: string | null; assetId: string | null };
    const summary = (agent: (typeof agents)[number]): AgentSummary => ({
      id: agent.id,
      hostname: agent.hostname,
      loggedInUser: agent.loggedInUser,
      assetId: agent.assetId,
    });
    const byMac = new Map<string, AgentSummary>();
    const byIp = new Map<string, AgentSummary>();
    for (const agent of agents) {
      if (agent.primaryMac) byMac.set(agent.primaryMac.toUpperCase(), summary(agent));
      if (agent.primaryIp && agent.lastSeenAt && now.getTime() - agent.lastSeenAt.getTime() <= AGENT_IP_MATCH_MS) {
        byIp.set(agent.primaryIp, summary(agent));
      }
    }
    return { byMac, byIp };
  }

  static async saveDevice(
    tx: Prisma.TransactionClient,
    collector: string,
    device: LiveDeviceInput,
    receivedAt: Date,
  ) {
    const existing = await tx.networkLiveDevice.findUnique({
      where: { collector_key: { collector, key: device.key } },
      select: { id: true, reachable: true, uptimeSeconds: true },
    });

    const status = {
      source: device.source,
      role: device.role,
      reachable: device.reachable,
      lastError: device.reachable ? null : (device.error ?? "Sin respuesta"),
      lastPollMs: device.pollMs ?? null,
      lastPolledAt: receivedAt,
      ...(device.reachable ? { lastOkAt: receivedAt } : {}),
    };

    // Si el equipo no respondió se conserva lo último conocido (nombre, modelo,
    // puertos): sólo cambia el estado.
    const identity = device.reachable
      ? {
          ...(device.name ? { name: device.name } : {}),
          managementIp: device.managementIp ?? null,
          macAddress: device.macAddress ?? null,
          vendor: device.vendor ?? null,
          model: device.model ?? null,
          firmware: device.firmware ?? null,
          serialNumber: device.serialNumber ?? null,
          uptimeSeconds: device.uptimeSeconds ?? null,
          clients: device.clients ?? null,
          poeBudgetW: device.poeBudgetW ?? null,
          poeUsedW: device.poeUsedW ?? null,
          ...(device.ports ? { portKeys: device.ports.map((port) => port.key) } : {}),
        }
      : {};

    const id = existing
      ? (
          await tx.networkLiveDevice.update({
            where: { id: existing.id },
            data: { ...status, ...identity },
            select: { id: true },
          })
        ).id
      : (
          await tx.networkLiveDevice.create({
            data: {
              collector,
              key: device.key,
              name: device.name ?? device.key,
              ...status,
              ...identity,
            },
            select: { id: true },
          })
        ).id;

    // Historial: la caída o la vuelta del equipo y los cambios de enlace de sus puertos, en la
    // misma transacción que el estado que los produjo.
    const events = deviceEvents(collector, id, existing, device, receivedAt);
    if (device.reachable && device.ports?.length) {
      events.push(...(await NetworkLiveService.savePorts(tx, collector, id, device.ports, receivedAt)));
    }
    if (events.length) await tx.networkLiveEvent.createMany({ data: events });
    return id;
  }

  /** Guarda los puertos que cambiaron y devuelve los eventos de enlace (cayó, volvió, otra velocidad). */
  static async savePorts(
    tx: Prisma.TransactionClient,
    collector: string,
    deviceId: string,
    ports: LivePortInput[],
    receivedAt: Date,
  ) {
    const current = await tx.networkLivePort.findMany({ where: { deviceId }, select: PORT_SELECT });
    const byKey = new Map(current.map((port) => [port.key, port as StoredPort]));
    const creates: Prisma.NetworkLivePortCreateManyInput[] = [];
    const events: LiveEventInput[] = [];

    for (const port of ports) {
      const stored = byKey.get(port.key);
      const write = planPortWrite(stored, port, receivedAt);
      if (!write) continue;
      if (write.kind === "create") {
        creates.push({ deviceId, ...(write.data as Omit<Prisma.NetworkLivePortCreateManyInput, "deviceId">) });
      } else {
        await tx.networkLivePort.update({ where: { id: stored!.id }, data: write.data });
        const event = portEvent(collector, deviceId, stored, port, receivedAt);
        if (event) events.push(event);
      }
    }

    if (creates.length) await tx.networkLivePort.createMany({ data: creates, skipDuplicates: true });
    return events;
  }

  static async saveLinks(collector: string, links: LiveLinkInput[], receivedAt: Date) {
    if (!links.length) return 0;

    const keys = [...new Set(links.flatMap((link) => [link.a.device, link.b.device]))];
    const devices = await prisma.networkLiveDevice.findMany({
      where: { collector, key: { in: keys } },
      select: { id: true, key: true },
    });
    const idByKey = new Map(devices.map((device) => [device.key, device.id]));

    // Un enlace por par de equipos, con los ids en orden para que A–B y B–A sean el mismo.
    const wanted = new Map<string, { aDeviceId: string; bDeviceId: string; aPorts: string[]; bPorts: string[]; source: string }>();
    for (const link of links) {
      let aDeviceId = idByKey.get(link.a.device);
      let bDeviceId = idByKey.get(link.b.device);
      if (!aDeviceId || !bDeviceId || aDeviceId === bDeviceId) continue;
      let aPorts = link.a.ports;
      let bPorts = link.b.ports;
      if (aDeviceId > bDeviceId) {
        [aDeviceId, bDeviceId] = [bDeviceId, aDeviceId];
        [aPorts, bPorts] = [bPorts, aPorts];
      }
      const pair = `${aDeviceId}|${bDeviceId}`;
      // Si llegan dos versiones del mismo enlace, gana la de LLDP: trae el puerto exacto.
      const previous = wanted.get(pair);
      if (previous && previous.source === "lldp" && link.source !== "lldp") continue;
      wanted.set(pair, { aDeviceId, bDeviceId, aPorts, bPorts, source: link.source });
    }

    const stored = await prisma.networkLiveLink.findMany({
      where: { collector },
      select: { id: true, aDeviceId: true, bDeviceId: true, aPorts: true, bPorts: true, source: true, lastSeenAt: true },
    });
    const storedByPair = new Map(stored.map((link) => [`${link.aDeviceId}|${link.bDeviceId}`, link]));

    const writes: Prisma.PrismaPromise<unknown>[] = [];
    const events: LiveEventInput[] = [];
    for (const [pair, link] of wanted) {
      const current = storedByPair.get(pair);
      if (!current) {
        writes.push(prisma.networkLiveLink.create({ data: { collector, ...link, lastSeenAt: receivedAt } }));
        events.push({
          collector,
          at: receivedAt,
          kind: "link_new",
          deviceId: link.aDeviceId,
          portKey: portList(link.aPorts),
          peerDeviceId: link.bDeviceId,
          peerPortKey: portList(link.bPorts),
          detail: { source: link.source, aPorts: link.aPorts, bPorts: link.bPorts },
        });
        continue;
      }
      const changed =
        current.source !== link.source ||
        current.aPorts.join(",") !== link.aPorts.join(",") ||
        current.bPorts.join(",") !== link.bPorts.join(",");
      if (changed || receivedAt.getTime() - current.lastSeenAt.getTime() >= LINK_TOUCH_MS) {
        writes.push(
          prisma.networkLiveLink.update({
            where: { id: current.id },
            data: { aPorts: link.aPorts, bPorts: link.bPorts, source: link.source, lastSeenAt: receivedAt },
          }),
        );
      }
    }

    if (writes.length) await prisma.$transaction(writes);
    if (events.length) await prisma.networkLiveEvent.createMany({ data: events });
    return wanted.size;
  }

  // ─── Lectura (pantalla "Red en vivo") ───────────────────────────────────────

  static async liveView(now = new Date()) {
    const [collectors, allDevices, links, alerts] = await Promise.all([
      prisma.networkCollector.findMany({ orderBy: { slug: "asc" } }),
      prisma.networkLiveDevice.findMany({
        orderBy: { name: "asc" },
        include: { ports: { orderBy: [{ position: "asc" }, { key: "asc" }] } },
      }),
      prisma.networkLiveLink.findMany({ orderBy: { firstSeenAt: "asc" } }),
      prisma.networkLiveAlert.findMany({ where: { resolvedAt: null }, orderBy: { openedAt: "asc" } }),
    ]);

    const lastReceived = new Map(collectors.map((c) => [c.slug, c.lastReceivedAt.getTime()]));
    // Lo retirado (un switch reemplazado, un AP olvidado en UniFi) no se muestra ni con sus enlaces.
    const retired = retiredDeviceIds(allDevices);
    const devices = allDevices.filter((device) => !retired.has(device.id));

    // Equipos finales conectados ahora: vistos en el último rato respecto del último envío.
    const newest = collectors.length ? Math.max(...collectors.map((c) => c.lastReceivedAt.getTime())) : null;
    const endpoints =
      newest === null
        ? []
        : await prisma.networkLiveEndpoint.findMany({
            where: { lastSeenAt: { gte: new Date(newest - ENDPOINT_VISIBLE_MS) } },
            orderBy: [{ deviceId: "asc" }, { portKey: "asc" }, { macAddress: "asc" }],
          });
    // Clientes Wi-Fi de la última lectura de UniFi (llega cada 5 min).
    const wifiClients =
      newest === null
        ? []
        : await prisma.networkLiveWifiClient.findMany({
            where: { lastSeenAt: { gte: new Date(newest - WIFI_VISIBLE_MS) } },
            orderBy: [{ apDeviceId: "asc" }, { macAddress: "asc" }],
          });
    const agents = await NetworkLiveService.agentsFor([...endpoints, ...wifiClients], now);

    return {
      generatedAt: now.toISOString(),
      collectors: collectors.map((c) => ({
        slug: c.slug,
        version: c.version,
        host: c.host,
        lastReceivedAt: c.lastReceivedAt.toISOString(),
        devicesTotal: c.devicesTotal,
        devicesOk: c.devicesOk,
        stale: now.getTime() - c.lastReceivedAt.getTime() > COLLECTOR_STALE_AFTER_MS,
      })),
      devices: devices.map((device) => {
        const current = new Set(device.portKeys);
        return {
          id: device.id,
          collector: device.collector,
          key: device.key,
          source: device.source,
          role: device.role,
          name: device.name,
          managementIp: device.managementIp,
          macAddress: device.macAddress,
          vendor: device.vendor,
          model: device.model,
          firmware: device.firmware,
          serialNumber: device.serialNumber,
          uptimeSeconds: device.uptimeSeconds,
          clients: device.clients,
          status: deriveDeviceStatus(device, now),
          lastError: device.lastError,
          lastPolledAt: device.lastPolledAt.toISOString(),
          lastOkAt: device.lastOkAt?.toISOString() ?? null,
          alertsMuted: device.alertsMuted,
          poe:
            device.poeBudgetW != null || device.poeUsedW != null
              ? { budgetW: device.poeBudgetW ?? null, usedW: device.poeUsedW ?? null }
              : null,
          ports: device.ports
            .filter((port) => current.has(port.key))
            .map((port) => ({
              key: port.key,
              name: port.name,
              description: port.description,
              position: port.position,
              kind: port.kind,
              adminUp: port.adminUp,
              linkUp: port.linkUp,
              speedMbps: port.speedMbps,
              fullDuplex: port.fullDuplex,
              pvid: port.pvid,
              neighbors: Array.isArray(port.neighbors) ? port.neighbors : [],
              linkChangedAt: port.linkChangedAt?.toISOString() ?? null,
              poe: port.poeStatus ? { status: port.poeStatus, powerW: port.poePowerW, class: port.poeClass } : null,
            })),
        };
      }),
      links: links
        .filter((link) => {
          const last = lastReceived.get(link.collector);
          return (
            last !== undefined &&
            link.lastSeenAt.getTime() >= last - LINK_VISIBLE_MS &&
            !retired.has(link.aDeviceId) &&
            !retired.has(link.bDeviceId)
          );
        })
        .map((link) => ({
          id: link.id,
          a: { deviceId: link.aDeviceId, ports: link.aPorts },
          b: { deviceId: link.bDeviceId, ports: link.bPorts },
          source: link.source,
          firstSeenAt: link.firstSeenAt.toISOString(),
          lastSeenAt: link.lastSeenAt.toISOString(),
        })),
      endpoints: endpoints
        .filter((endpoint) => !retired.has(endpoint.deviceId))
        .map((endpoint) => NetworkLiveService.endpointView(endpoint, agents)),
      wifiClients: wifiClients
        .filter((client) => !retired.has(client.apDeviceId))
        .map((client) => {
          const agent =
            agents.byMac.get(client.macAddress) ?? (client.ipAddress ? agents.byIp.get(client.ipAddress) : undefined);
          return {
            mac: client.macAddress,
            apDeviceId: client.apDeviceId,
            ssid: client.ssid,
            band: client.band,
            channel: client.channel,
            signal: client.signal,
            txKbps: client.txKbps,
            rxKbps: client.rxKbps,
            uptimeSeconds: client.uptimeSeconds,
            hostname: client.hostname,
            ip: client.ipAddress,
            vlan: client.vlan,
            firstSeenAt: client.firstSeenAt.toISOString(),
            lastSeenAt: client.lastSeenAt.toISOString(),
            agent: agent ?? null,
          };
        }),
      // Incidentes avisados que siguen abiertos (equipo caído, colector mudo).
      alerts: alerts.filter((alert) => !alert.deviceId || !retired.has(alert.deviceId)).map((alert) => ({
        id: alert.id,
        kind: alert.kind,
        deviceId: alert.deviceId,
        openedAt: alert.openedAt.toISOString(),
        lastNotifiedAt: alert.lastNotifiedAt?.toISOString() ?? null,
        ticketId: alert.ticketId,
        detail: alert.detail,
      })),
    };
  }

  // ─── Historial ──────────────────────────────────────────────────────────────

  /**
   * Eventos más nuevos primero. Filtrando por equipo (y puerto) también trae los que lo tienen del
   * otro lado: el enlace nuevo visto desde el vecino, o el equipo final que se fue de ese puerto.
   */
  static async events(params: {
    since: Date;
    until?: Date;
    deviceId?: string;
    portKey?: string;
    mac?: string;
    kinds?: string[];
    limit: number;
  }, now = new Date()) {
    const { since, until, deviceId, portKey, mac, kinds, limit } = params;
    const where: Prisma.NetworkLiveEventWhereInput = {
      at: { gte: since, ...(until ? { lte: until } : {}) },
      ...(kinds?.length ? { kind: { in: kinds } } : {}),
      ...(mac ? { macAddress: mac } : {}),
      ...(deviceId
        ? {
            OR: [
              { deviceId, ...(portKey ? { portKey } : {}) },
              { peerDeviceId: deviceId, ...(portKey ? { peerPortKey: portKey } : {}) },
            ],
          }
        : {}),
    };
    const rows = await prisma.networkLiveEvent.findMany({ where, orderBy: { at: "desc" }, take: limit + 1 });
    const page = rows.slice(0, limit);

    // Los equipos finales se nombran como en la pantalla: la PC del agente, el nombre DHCP o la IP.
    const macs = [...new Set(page.map((event) => event.macAddress).filter((value): value is string => Boolean(value)))];
    const endpoints = macs.length
      ? await prisma.networkLiveEndpoint.findMany({
          where: { macAddress: { in: macs } },
          select: { macAddress: true, ipAddress: true, hostname: true },
        })
      : [];
    const agents = await NetworkLiveService.agentsFor(endpoints, now);
    const endpointByMac = new Map(endpoints.map((endpoint) => [endpoint.macAddress, endpoint]));

    return {
      events: page.map((event) => {
        const endpoint = event.macAddress ? endpointByMac.get(event.macAddress) : undefined;
        const agent = endpoint
          ? (agents.byMac.get(endpoint.macAddress) ?? (endpoint.ipAddress ? agents.byIp.get(endpoint.ipAddress) : undefined))
          : undefined;
        return {
          id: event.id,
          at: event.at.toISOString(),
          kind: event.kind,
          deviceId: event.deviceId,
          portKey: event.portKey,
          macAddress: event.macAddress,
          peerDeviceId: event.peerDeviceId,
          peerPortKey: event.peerPortKey,
          detail: event.detail ?? null,
          endpoint: endpoint
            ? { ip: endpoint.ipAddress, hostname: endpoint.hostname, agent: agent ?? null }
            : null,
        };
      }),
      hasMore: rows.length > limit,
    };
  }

  static endpointView(
    endpoint: Prisma.NetworkLiveEndpointGetPayload<object>,
    agents: Awaited<ReturnType<typeof NetworkLiveService.agentsFor>>,
  ) {
    const agent =
      agents.byMac.get(endpoint.macAddress) ?? (endpoint.ipAddress ? agents.byIp.get(endpoint.ipAddress) : undefined);
    return {
      mac: endpoint.macAddress,
      deviceId: endpoint.deviceId,
      portKey: endpoint.portKey,
      vlan: endpoint.vlan,
      ip: endpoint.ipAddress,
      hostname: endpoint.hostname,
      viaDeviceId: endpoint.viaDeviceId,
      shared: endpoint.sharedPort,
      firstSeenAt: endpoint.firstSeenAt.toISOString(),
      lastSeenAt: endpoint.lastSeenAt.toISOString(),
      movedAt: endpoint.movedAt?.toISOString() ?? null,
      agent: agent ?? null,
    };
  }

  // ─── Búsqueda ("¿dónde está X?") ────────────────────────────────────────────

  /**
   * Busca equipos finales por MAC, IP, nombre DHCP, nombre de la PC o usuario logueado (estos
   * dos, vía el agente), incluidos los que ya no están conectados: devuelve dónde se los vio por
   * última vez.
   */
  static async search(query: string, now = new Date()) {
    const text = query.trim();
    const compact = text.replace(/[.\-:\s]/g, "").toUpperCase();
    const mac = /^[0-9A-F]{12}$/.test(compact) ? compact.match(/.{2}/g)!.join(":") : null;
    const ip = isIP(text) !== 0 ? text : null;

    const agentMatches = mac || ip
      ? []
      : await prisma.agentDevice.findMany({
          where: {
            isActive: true,
            deletedAt: null,
            OR: [
              { hostname: { contains: text, mode: "insensitive" } },
              { loggedInUser: { contains: text, mode: "insensitive" } },
            ],
          },
          select: { primaryMac: true, primaryIp: true },
          take: 50,
        });
    const agentMacs = agentMatches.map((agent) => agent.primaryMac).filter((value): value is string => Boolean(value));
    const agentIps = ip
      ? (
          await prisma.agentDevice.findMany({
            where: { isActive: true, deletedAt: null, primaryIp: ip },
            select: { primaryMac: true },
            take: 10,
          })
        )
          .map((agent) => agent.primaryMac)
          .filter((value): value is string => Boolean(value))
      : [];

    const conditions: Prisma.NetworkLiveEndpointWhereInput[] = [];
    if (mac) conditions.push({ macAddress: mac });
    if (ip) conditions.push({ ipAddress: ip });
    if (!mac && !ip) conditions.push({ hostname: { contains: text, mode: "insensitive" } });
    const macsFromAgents = [...agentMacs, ...agentIps];
    if (macsFromAgents.length) conditions.push({ macAddress: { in: macsFromAgents } });

    const found = await prisma.networkLiveEndpoint.findMany({
      where: { OR: conditions },
      orderBy: { lastSeenAt: "desc" },
      take: SEARCH_LIMIT,
      include: { device: { select: { id: true, name: true, role: true } } },
    });
    const collectors = await prisma.networkCollector.findMany({ select: { slug: true, lastReceivedAt: true } });
    const lastReceived = new Map(collectors.map((c) => [c.slug, c.lastReceivedAt.getTime()]));
    const agents = await NetworkLiveService.agentsFor(found, now);

    return {
      query: text,
      results: found.map((endpoint) => {
        const last = lastReceived.get(endpoint.collector);
        return {
          ...NetworkLiveService.endpointView(endpoint, agents),
          deviceName: endpoint.device.name,
          deviceRole: endpoint.device.role,
          online: last !== undefined && endpoint.lastSeenAt.getTime() >= last - ENDPOINT_VISIBLE_MS,
        };
      }),
    };
  }
}

export default NetworkLiveService;
