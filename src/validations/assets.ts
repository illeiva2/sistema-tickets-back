import { z } from "zod";

export const ASSET_TYPES = [
  "DESKTOP",
  "NOTEBOOK",
  "PHONE",
  "TABLET",
  "MONITOR",
  "PRINTER",
  "PERIPHERAL",
  "NETWORK_DEVICE",
  "SERVER",
  "OTHER",
] as const;

export const ASSET_STATUSES = [
  "IN_STOCK",
  "ASSIGNED",
  "IN_REPAIR",
  "RETIRED",
  "LOST",
] as const;

const assetTagSchema = z
  .string()
  .trim()
  .min(3, "El código de activo debe tener al menos 3 caracteres")
  .max(32, "El código de activo es demasiado largo")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]*$/,
    "El código de activo solo puede contener letras, números y guiones",
  )
  .transform((value) => value.toUpperCase());

const nullableText = (max: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().max(max).nullable().optional(),
  );

const nullableDate = z
  .union([
    z.string().datetime(),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida"),
    z.literal(""),
    z.null(),
  ])
  .optional();

const sensitiveSpecKeys = new Set([
  "password",
  "passwd",
  "pass",
  "pwd",
  "pin",
  "contrasena",
  "clave",
  "credential",
  "credentials",
  "credencial",
  "secret",
  "token",
  "phonenumber",
  "mobilephone",
  "telefono",
  "numerolinea",
  "numerodelinea",
  "nrolinea",
  "linenumber",
  "iccid",
  "simiccid",
]);

const normalizeSpecKey = (key: string) =>
  key
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();

const findSensitiveSpecPath = (
  value: unknown,
  path: string[] = [],
): string[] | null => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveSpecPath(value[index], [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }

  if (!value || typeof value !== "object") return null;

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (sensitiveSpecKeys.has(normalizeSpecKey(key))) return nextPath;
    const found = findSensitiveSpecPath(nestedValue, nextPath);
    if (found) return found;
  }

  return null;
};

const specsSchema = z
  .record(z.unknown())
  .superRefine((specs, ctx) => {
    const sensitivePath = findSensitiveSpecPath(specs);
    if (sensitivePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: sensitivePath,
        message:
          "Specs no puede contener contraseñas, credenciales, secretos, números de línea ni ICCID",
      });
    }
  });

const createAssetFields = {
  assetTag: assetTagSchema.optional(),
  type: z.enum(ASSET_TYPES),
  status: z.enum(ASSET_STATUSES).optional().default("IN_STOCK"),
  brand: z.string().trim().min(1, "Marca requerida").max(100),
  model: z.string().trim().min(1, "Modelo requerido").max(150),
  serialNumber: nullableText(150),
  specs: specsSchema.nullable().optional(),
  notes: nullableText(10000),
  secretsRef: nullableText(500),
  location: nullableText(500),
  warrantyUntil: nullableDate,
  purchaseItemId: z.string().cuid("ID de compra inválido").nullable().optional(),
  retirementReason: nullableText(1000),
};

export const createAssetSchema = z
  .object(createAssetFields)
  .strict()
  .superRefine((data, ctx) => {
    if (data.status === "ASSIGNED") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Usá el endpoint de asignación para marcar un activo como asignado",
      });
    }
  });

export const updateAssetSchema = z
  .object({
    expectedUpdatedAt: z
      .string()
      .datetime("expectedUpdatedAt debe ser una fecha ISO válida"),
    assetTag: assetTagSchema.optional(),
    type: z.enum(ASSET_TYPES).optional(),
    status: z.enum(ASSET_STATUSES).optional(),
    brand: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().min(1).max(150).optional(),
    serialNumber: nullableText(150),
    specs: specsSchema.nullable().optional(),
    notes: nullableText(10000),
    secretsRef: nullableText(500),
    location: nullableText(500),
    warrantyUntil: nullableDate,
    purchaseItemId: z.string().cuid("ID de compra inválido").nullable().optional(),
    retirementReason: nullableText(1000),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      Object.keys(data).filter((field) => field !== "expectedUpdatedAt")
        .length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Debe enviar al menos un campo para actualizar",
      });
    }
  });

export const assetFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(ASSET_TYPES).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  assignedPersonId: z.string().cuid("ID de persona inválido").optional(),
  assignedDepartmentId: z.string().cuid("ID de sector inválido").optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const assetIdParamsSchema = z.object({
  id: z.string().cuid("ID de activo inválido"),
});

export const assignAssetSchema = z
  .object({
    personId: z.string().cuid("ID de persona inválido").nullable().optional(),
    departmentId: z
      .string()
      .cuid("ID de sector inválido")
      .nullable()
      .optional(),
    note: nullableText(1000),
  })
  .strict()
  .refine((data) => Boolean(data.personId || data.departmentId), {
    message: "Debe indicar una persona y/o un sector",
    path: ["personId"],
  });

export const returnAssetSchema = z
  .object({ returnNote: nullableText(1000) })
  .strict();

export type CreateAssetRequest = z.infer<typeof createAssetSchema>;
export type UpdateAssetRequest = z.infer<typeof updateAssetSchema>;
export type AssetFilters = z.infer<typeof assetFiltersSchema>;
export type AssignAssetRequest = z.infer<typeof assignAssetSchema>;
export type ReturnAssetRequest = z.infer<typeof returnAssetSchema>;
