import { isIP } from "node:net";
import { z } from "zod";
import { assignAssetSchema, createAssetSchema } from "./assets";

export const AGENT_API_STATES = ["ONLINE", "STALE", "OFFLINE"] as const;

const cuid = (label: string) => z.string().cuid(`ID de ${label} inválido`);
const nullableId = (label: string) =>
  z.preprocess(
    (value) => (value === "" ? null : value),
    cuid(label).nullable(),
  );
const nullableText = (max: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().max(max).nullable().optional(),
  );
const expectedUpdatedAt = z
  .string()
  .datetime("expectedUpdatedAt debe ser una fecha ISO válida");
const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
const boolQuery = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Texto inválido");

const canonicalIp = z
  .preprocess((value) => {
    if (typeof value !== "string" || !value.includes("%")) return value;
    const parts = value.trim().split("%");
    if (
      parts.length === 2 &&
      parts[0] &&
      /^[A-Za-z0-9_.-]{1,32}$/.test(parts[1])
    ) {
      return parts[0];
    }
    return value;
  }, z
  .string()
  .trim()
  .max(45)
  .refine((value) => isIP(value) !== 0, "Dirección IP inválida")
  .transform((value) => {
    if (isIP(value) !== 6) return value;
    return new URL(`http://[${value}]/`)
      .hostname.replace(/^\[|\]$/g, "")
      .toLowerCase();
  }));

const canonicalMac = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value.trim().replace(/[.\-:\s]/g, "").toUpperCase()
      : value,
  z
    .string()
    .regex(/^[0-9A-F]{12}$/, "Dirección MAC inválida")
    .transform((value) => value.match(/.{2}/g)!.join(":")),
);

const nonNegativeBytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const enrollmentTokenFiltersSchema = z
  .object({
    status: z.enum(["AVAILABLE", "USED", "EXPIRED"]).optional(),
  })
  .strict();

export const createEnrollmentTokenSchema = z
  .object({
    label: nullableText(200),
    expiresAt: z.string().datetime("expiresAt debe ser una fecha ISO válida").optional(),
  })
  .strict();

export const enrollmentTokenIdParamsSchema = z
  .object({ id: cuid("token") })
  .strict();

export const agentDeviceIdParamsSchema = z
  .object({ id: cuid("dispositivo") })
  .strict();

export const remoteSessionIdParamsSchema = z
  .object({ id: cuid("sesión") })
  .strict();

export const agentDeviceFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    state: z.enum(AGENT_API_STATES).optional(),
    isActive: boolQuery,
    assetId: cuid("activo").optional(),
    ...pagination,
  })
  .strict();

export const linkAgentAssetSchema = z
  .object({
    expectedUpdatedAt,
    assetId: nullableId("activo"),
  })
  .strict();

const agentAssetSchema = createAssetSchema.superRefine((asset, ctx) => {
  if (asset.status !== "IN_STOCK") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "El alta desde un agente sólo admite activos disponibles en stock",
    });
  }
});

export const registerAgentAssetSchema = z
  .object({
    expectedUpdatedAt,
    asset: agentAssetSchema,
    custody: assignAssetSchema.optional(),
  })
  .strict();

export const agentDeviceTransitionSchema = z
  .object({ expectedUpdatedAt })
  .strict();

export const snapshotFiltersSchema = z
  .object({ ...pagination, pageSize: z.coerce.number().int().min(1).max(20).default(10) })
  .strict();

export const metricFiltersSchema = z
  .object({
    from: z.string().datetime("from debe ser una fecha ISO válida").optional(),
    to: z.string().datetime("to debe ser una fecha ISO válida").optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(288),
  })
  .strict()
  .refine(
    (data) => !data.from || !data.to || new Date(data.from) <= new Date(data.to),
    { path: ["to"], message: "to debe ser posterior a from" },
  );

export const startRemoteSessionSchema = z
  .object({ protocol: z.enum(["SSH", "VNC"]) })
  .strict();

const machineGuidSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^\{|\}$/g, "").toLowerCase())
  .refine(
    (value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      ),
    "MachineGuid inválido",
  );

const hostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/, "Hostname inválido");

export const machineEnrollSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Token inválido"),
    deviceSecret: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, "Secreto de dispositivo inválido"),
    machineGuid: machineGuidSchema,
    hostname: hostnameSchema,
    agentVersion: safeText(100),
    osName: nullableText(200),
    osVersion: nullableText(100),
  })
  .strict();

const serviceStateSchema = z
  .object({
    available: z.boolean(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

const hardwareInventorySchema = z
  .object({
    manufacturer: nullableText(200),
    model: nullableText(200),
    serialNumber: nullableText(200),
    biosVersion: nullableText(200),
  })
  .strict();

const cpuInventorySchema = z
  .object({
    model: nullableText(300),
    cores: z.number().int().min(1).max(1024).optional(),
    logicalProcessors: z.number().int().min(1).max(2048).optional(),
  })
  .strict();

const memoryModuleSchema = z
  .object({
    capacityBytes: nonNegativeBytes,
    manufacturer: nullableText(200),
    partNumber: nullableText(200),
    serialNumber: nullableText(200),
  })
  .strict();

const softwareSchema = z
  .object({
    name: safeText(300),
    version: nullableText(100),
    publisher: nullableText(200),
  })
  .strict();

const networkAdapterSchema = z
  .object({
    name: safeText(200),
    description: nullableText(300),
    macAddress: canonicalMac.optional(),
    ipAddresses: z.array(canonicalIp).max(16).optional(),
  })
  .strict();

export const agentInventorySchema = z
  .object({
    collectedAt: z.string().datetime("collectedAt debe ser una fecha ISO válida").optional(),
    hardware: hardwareInventorySchema.optional(),
    cpu: cpuInventorySchema.optional(),
    memoryModules: z.array(memoryModuleSchema).max(32).optional(),
    software: z.array(softwareSchema).max(500).optional(),
    networkAdapters: z.array(networkAdapterSchema).max(64).optional(),
  })
  .strict();

const diskSchema = z
  .object({
    name: safeText(200),
    totalBytes: nonNegativeBytes,
    usedBytes: nonNegativeBytes,
  })
  .strict()
  .refine((disk) => disk.usedBytes <= disk.totalBytes, {
    path: ["usedBytes"],
    message: "usedBytes no puede superar totalBytes",
  });

export const machineHeartbeatSchema = z
  .object({
    hostname: hostnameSchema,
    username: nullableText(255),
    ipAddresses: z.array(canonicalIp).max(32).default([]),
    macAddresses: z.array(canonicalMac).max(32).default([]),
    uptimeSeconds: z.number().int().min(0).max(2_147_483_647),
    cpuPercent: z.number().min(0).max(100).nullable().optional(),
    ram: z
      .object({
        totalBytes: nonNegativeBytes,
        usedBytes: nonNegativeBytes,
      })
      .strict()
      .refine((ram) => ram.usedBytes <= ram.totalBytes, {
        path: ["usedBytes"],
        message: "usedBytes no puede superar totalBytes",
      }),
    battery: z
      .object({
        percent: z.number().int().min(0).max(100).nullable().optional(),
        charging: z.boolean().nullable().optional(),
      })
      .strict()
      .optional(),
    disks: z.array(diskSchema).max(64).default([]),
    services: z
      .object({
        ssh: serviceStateSchema,
        vnc: serviceStateSchema,
      })
      .strict(),
    os: z
      .object({
        name: safeText(200),
        version: nullableText(100),
        build: nullableText(100),
      })
      .strict(),
    agentVersion: safeText(100),
    inventory: agentInventorySchema.optional(),
  })
  .strict();

export type EnrollmentTokenFilters = z.infer<typeof enrollmentTokenFiltersSchema>;
export type CreateEnrollmentTokenRequest = z.infer<typeof createEnrollmentTokenSchema>;
export type AgentDeviceFilters = z.infer<typeof agentDeviceFiltersSchema>;
export type LinkAgentAssetRequest = z.infer<typeof linkAgentAssetSchema>;
export type RegisterAgentAssetRequest = z.infer<typeof registerAgentAssetSchema>;
export type AgentDeviceTransitionRequest = z.infer<typeof agentDeviceTransitionSchema>;
export type SnapshotFilters = z.infer<typeof snapshotFiltersSchema>;
export type MetricFilters = z.infer<typeof metricFiltersSchema>;
export type StartRemoteSessionRequest = z.infer<typeof startRemoteSessionSchema>;
export type MachineEnrollRequest = z.infer<typeof machineEnrollSchema>;
export type MachineHeartbeatRequest = z.infer<typeof machineHeartbeatSchema>;
