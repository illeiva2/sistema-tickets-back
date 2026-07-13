import { isIP } from "node:net";
import { z } from "zod";

export const NETWORK_DEVICE_TYPES = [
  "ROUTER",
  "SWITCH",
  "ACCESS_POINT",
  "FIREWALL",
  "SERVER",
  "NAS",
  "PRINTER",
  "CAMERA",
  "UPS",
  "OTHER",
] as const;

export const NETWORK_DEVICE_STATUSES = [
  "ACTIVE",
  "INACTIVE",
  "MAINTENANCE",
  "RETIRED",
] as const;

export const NETWORK_LINK_TYPES = [
  "ETHERNET",
  "FIBER",
  "WIFI",
  "WAN",
  "VPN",
  "VIRTUAL",
  "OTHER",
] as const;

const idSchema = (label: string) => z.string().cuid(`ID de ${label} inválido`);

const nullableText = (max: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().max(max).nullable().optional(),
  );

const nullableId = (label: string) =>
  z.preprocess(
    (value) => (value === "" ? null : value),
    idSchema(label).nullable().optional(),
  );

const expectedUpdatedAt = z
  .string()
  .datetime("expectedUpdatedAt debe ser una fecha ISO válida");

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

const booleanQuery = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

const managementIpSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  z
    .string()
    .trim()
    .max(45)
    .refine((value) => isIP(value) !== 0, "Dirección IP inválida")
    .transform((value) => value.toLowerCase())
    .nullable()
    .optional(),
);

const macAddressSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const compact = value.trim().replace(/[.\-:\s]/g, "");
    if (!compact) return null;
    return compact.toUpperCase();
  },
  z
    .string()
    .regex(/^[0-9A-F]{12}$/, "Dirección MAC inválida")
    .transform((value) => value.match(/.{2}/g)!.join(":"))
    .nullable()
    .optional(),
);

const vlanItemSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .superRefine((value, ctx) => {
    const match = /^(\d{1,4})(?:-([\p{L}\p{N}][\p{L}\p{N}_. ]{0,63}))?$/u.exec(value);
    const vlanId = match ? Number(match[1]) : 0;
    if (!match || vlanId < 1 || vlanId > 4094) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "VLAN inválida; use 1..4094 y etiqueta opcional (ej. 20-VoIP)",
      });
    }
  });

const vlansSchema = z
  .array(vlanItemSchema)
  .max(256)
  .transform((items) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = item.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

const adminUrlSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  z
    .string()
    .trim()
    .max(1000)
    .url("URL de administración inválida")
    .superRefine((value, ctx) => {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "La URL debe usar http o https",
        });
      }
      if (url.username || url.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "La URL no puede contener usuario ni contraseña",
        });
      }
    })
    .nullable()
    .optional(),
);

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug inválido")
  .optional();

export const siteIdParamsSchema = z.object({ id: idSchema("sitio") }).strict();
export const deviceIdParamsSchema = z
  .object({ id: idSchema("dispositivo") })
  .strict();
export const linkIdParamsSchema = z.object({ id: idSchema("enlace") }).strict();
export const topologyViewIdParamsSchema = z
  .object({ id: idSchema("vista") })
  .strict();

export const siteFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    isActive: booleanQuery,
    ...pagination,
  })
  .strict();

export const createSiteSchema = z
  .object({
    name: z.string().trim().min(2, "Nombre requerido").max(200),
    slug: slugSchema,
    address: nullableText(500),
    description: nullableText(5000),
  })
  .strict();

export const updateSiteSchema = z
  .object({
    expectedUpdatedAt,
    name: z.string().trim().min(2).max(200).optional(),
    slug: slugSchema,
    address: nullableText(500),
    description: nullableText(5000),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => Object.keys(data).some((key) => key !== "expectedUpdatedAt"),
    "Debe enviar al menos un campo para actualizar",
  );

const deviceFields = {
  name: z.string().trim().min(2, "Nombre requerido").max(200),
  type: z.enum(NETWORK_DEVICE_TYPES),
  status: z.enum(NETWORK_DEVICE_STATUSES),
  siteId: idSchema("sitio"),
  managementIp: managementIpSchema,
  macAddress: macAddressSchema,
  vlans: vlansSchema,
  location: nullableText(300),
  adminUrl: adminUrlSchema,
  notes: nullableText(10000),
  secretsRef: nullableText(500),
  assetId: nullableId("activo"),
};

export const deviceFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    siteId: idSchema("sitio").optional(),
    type: z.enum(NETWORK_DEVICE_TYPES).optional(),
    status: z.enum(NETWORK_DEVICE_STATUSES).optional(),
    isActive: booleanQuery,
    ...pagination,
  })
  .strict();

export const createDeviceSchema = z
  .object({
    ...deviceFields,
    status: deviceFields.status.default("ACTIVE"),
    vlans: deviceFields.vlans.default([]),
  })
  .strict();

export const updateDeviceSchema = z
  .object({
    expectedUpdatedAt,
    name: deviceFields.name.optional(),
    type: deviceFields.type.optional(),
    status: deviceFields.status.optional(),
    siteId: deviceFields.siteId.optional(),
    managementIp: managementIpSchema,
    macAddress: macAddressSchema,
    vlans: deviceFields.vlans.optional(),
    location: deviceFields.location,
    adminUrl: adminUrlSchema,
    notes: deviceFields.notes,
    secretsRef: deviceFields.secretsRef,
    assetId: deviceFields.assetId,
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => Object.keys(data).some((key) => key !== "expectedUpdatedAt"),
    "Debe enviar al menos un campo para actualizar",
  );

const portSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  z
    .string()
    .trim()
    .max(100)
    .transform((value) => value.replace(/\s+/g, " "))
    .nullable()
    .optional(),
);

const linkFields = {
  deviceAId: idSchema("dispositivo A"),
  deviceBId: idSchema("dispositivo B"),
  portA: portSchema,
  portB: portSchema,
  type: z.enum(NETWORK_LINK_TYPES),
  vlans: vlansSchema,
  speedMbps: z.preprocess(
    (value) => (value === "" ? null : value),
    z.coerce.number().int().min(1).max(10_000_000).nullable().optional(),
  ),
  notes: nullableText(5000),
};

export const linkFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    deviceId: idSchema("dispositivo").optional(),
    siteId: idSchema("sitio").optional(),
    type: z.enum(NETWORK_LINK_TYPES).optional(),
    ...pagination,
  })
  .strict();

export const createLinkSchema = z
  .object({
    ...linkFields,
    type: linkFields.type.default("ETHERNET"),
    vlans: linkFields.vlans.default([]),
  })
  .strict()
  .refine((data) => data.deviceAId !== data.deviceBId, {
    path: ["deviceBId"],
    message: "Un dispositivo no puede enlazarse consigo mismo",
  });

export const updateLinkSchema = z
  .object({
    expectedUpdatedAt,
    deviceAId: linkFields.deviceAId.optional(),
    deviceBId: linkFields.deviceBId.optional(),
    portA: portSchema,
    portB: portSchema,
    type: linkFields.type.optional(),
    vlans: linkFields.vlans.optional(),
    speedMbps: linkFields.speedMbps,
    notes: linkFields.notes,
  })
  .strict()
  .refine(
    (data) => Object.keys(data).some((key) => key !== "expectedUpdatedAt"),
    "Debe enviar al menos un campo para actualizar",
  )
  .refine(
    (data) =>
      !data.deviceAId || !data.deviceBId || data.deviceAId !== data.deviceBId,
    { path: ["deviceBId"], message: "Un dispositivo no puede enlazarse consigo mismo" },
  );

export const deleteLinkSchema = z.object({ expectedUpdatedAt }).strict();

export const viewportSchema = z
  .object({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
    zoom: z.number().finite().min(0.05).max(8),
  })
  .strict();

export const topologyViewFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    siteId: idSchema("sitio").optional(),
    ...pagination,
  })
  .strict();

export const createTopologyViewSchema = z
  .object({
    name: z.string().trim().min(2, "Nombre requerido").max(200),
    description: nullableText(5000),
    siteId: nullableId("sitio"),
    isDefault: z.boolean().default(false),
    viewport: viewportSchema.nullable().optional(),
  })
  .strict();

export const updateTopologyViewSchema = z
  .object({
    expectedUpdatedAt,
    name: z.string().trim().min(2).max(200).optional(),
    description: nullableText(5000),
    siteId: nullableId("sitio"),
    isDefault: z.boolean().optional(),
    viewport: viewportSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (data) => Object.keys(data).some((key) => key !== "expectedUpdatedAt"),
    "Debe enviar al menos un campo para actualizar",
  );

const nodePositionSchema = z
  .object({
    deviceId: idSchema("dispositivo"),
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
  })
  .strict();

export const topologyLayoutSchema = z
  .object({
    expectedUpdatedAt,
    viewport: viewportSchema.nullable().optional(),
    nodes: z.array(nodePositionSchema).max(500),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.nodes.forEach((node, index) => {
      if (seen.has(node.deviceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "deviceId"],
          message: "El dispositivo está repetido en el layout",
        });
      }
      seen.add(node.deviceId);
    });
  });

export type SiteFilters = z.infer<typeof siteFiltersSchema>;
export type CreateSiteRequest = z.infer<typeof createSiteSchema>;
export type UpdateSiteRequest = z.infer<typeof updateSiteSchema>;
export type DeviceFilters = z.infer<typeof deviceFiltersSchema>;
export type CreateDeviceRequest = z.infer<typeof createDeviceSchema>;
export type UpdateDeviceRequest = z.infer<typeof updateDeviceSchema>;
export type LinkFilters = z.infer<typeof linkFiltersSchema>;
export type CreateLinkRequest = z.infer<typeof createLinkSchema>;
export type UpdateLinkRequest = z.infer<typeof updateLinkSchema>;
export type DeleteLinkRequest = z.infer<typeof deleteLinkSchema>;
export type TopologyViewFilters = z.infer<typeof topologyViewFiltersSchema>;
export type CreateTopologyViewRequest = z.infer<typeof createTopologyViewSchema>;
export type UpdateTopologyViewRequest = z.infer<typeof updateTopologyViewSchema>;
export type TopologyLayoutRequest = z.infer<typeof topologyLayoutSchema>;
