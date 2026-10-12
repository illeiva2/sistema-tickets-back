import { Prisma } from "@prisma/client";
import { prisma } from "../lib/database";

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
  ports?: LivePortInput[] | null;
}

export interface LiveLinkInput {
  a: { device: string; ports: string[] };
  b: { device: string; ports: string[] };
  source: string;
}

export interface CollectorSnapshotInput {
  collector: { version?: string | null; host?: string | null };
  startedAt: string;
  finishedAt: string;
  devices: LiveDeviceInput[];
  links: LiveLinkInput[];
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
}

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

  if (!current) {
    return { kind: "create", data: { key: incoming.key, ...fields, neighbors: neighborsValue } };
  }

  const sameFields = (Object.keys(fields) as (keyof typeof fields)[]).every(
    (field) => (current[field] ?? null) === fields[field],
  );
  const sameNeighbors = canonicalJson(current.neighbors) === canonicalJson(neighbors);
  if (sameFields && sameNeighbors) return null;

  const linkChanged =
    current.linkUp !== fields.linkUp || (current.speedMbps ?? null) !== fields.speedMbps;
  return {
    kind: "update",
    data: { ...fields, neighbors: neighborsValue, ...(linkChanged ? { linkChangedAt: now } : {}) },
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

    return { devices: input.devices.length, devicesOk, links };
  }

  static async saveDevice(
    tx: Prisma.TransactionClient,
    collector: string,
    device: LiveDeviceInput,
    receivedAt: Date,
  ) {
    const existing = await tx.networkLiveDevice.findUnique({
      where: { collector_key: { collector, key: device.key } },
      select: { id: true },
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

    if (device.reachable && device.ports?.length) {
      await NetworkLiveService.savePorts(tx, id, device.ports, receivedAt);
    }
    return id;
  }

  static async savePorts(
    tx: Prisma.TransactionClient,
    deviceId: string,
    ports: LivePortInput[],
    receivedAt: Date,
  ) {
    const current = await tx.networkLivePort.findMany({ where: { deviceId }, select: PORT_SELECT });
    const byKey = new Map(current.map((port) => [port.key, port as StoredPort]));
    const creates: Prisma.NetworkLivePortCreateManyInput[] = [];

    for (const port of ports) {
      const stored = byKey.get(port.key);
      const write = planPortWrite(stored, port, receivedAt);
      if (!write) continue;
      if (write.kind === "create") {
        creates.push({ deviceId, ...(write.data as Omit<Prisma.NetworkLivePortCreateManyInput, "deviceId">) });
      } else {
        await tx.networkLivePort.update({ where: { id: stored!.id }, data: write.data });
      }
    }

    if (creates.length) await tx.networkLivePort.createMany({ data: creates, skipDuplicates: true });
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
    for (const [pair, link] of wanted) {
      const current = storedByPair.get(pair);
      if (!current) {
        writes.push(prisma.networkLiveLink.create({ data: { collector, ...link, lastSeenAt: receivedAt } }));
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
    return wanted.size;
  }

  // ─── Lectura (pantalla "Red en vivo") ───────────────────────────────────────

  static async liveView(now = new Date()) {
    const [collectors, devices, links] = await Promise.all([
      prisma.networkCollector.findMany({ orderBy: { slug: "asc" } }),
      prisma.networkLiveDevice.findMany({
        orderBy: { name: "asc" },
        include: { ports: { orderBy: [{ position: "asc" }, { key: "asc" }] } },
      }),
      prisma.networkLiveLink.findMany({ orderBy: { firstSeenAt: "asc" } }),
    ]);

    const lastReceived = new Map(collectors.map((c) => [c.slug, c.lastReceivedAt.getTime()]));

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
            })),
        };
      }),
      links: links
        .filter((link) => {
          const last = lastReceived.get(link.collector);
          return last !== undefined && link.lastSeenAt.getTime() >= last - LINK_VISIBLE_MS;
        })
        .map((link) => ({
          id: link.id,
          a: { deviceId: link.aDeviceId, ports: link.aPorts },
          b: { deviceId: link.bDeviceId, ports: link.bPorts },
          source: link.source,
          firstSeenAt: link.firstSeenAt.toISOString(),
          lastSeenAt: link.lastSeenAt.toISOString(),
        })),
    };
  }
}

export default NetworkLiveService;
