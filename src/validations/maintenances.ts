import { z } from "zod";

export const MAINTENANCE_TYPES = [
  "PREVENTIVE",
  "CORRECTIVE",
  "UPGRADE",
] as const;

export const MAINTENANCE_STATUSES = [
  "SCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;

export const CURRENCIES = ["ARS", "USD"] as const;

const isRealCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
};

const dateTimeValue = z
  .string()
  .datetime({ offset: true })
  .refine(isRealCalendarDate, "Fecha de calendario inválida");

const filterDateValue = z
  .union([
    z.string().datetime({ offset: true }),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida"),
  ])
  .refine(isRealCalendarDate, "Fecha de calendario inválida");

const nullableDate = z.preprocess(
  (value) => (value === "" ? null : value),
  dateTimeValue.nullable().optional(),
);

const nullableId = (label: string) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().cuid(`ID de ${label} inválido`).nullable().optional(),
  );

const decimalAmount = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z
    .union([
      z
        .number()
        .finite()
        .nonnegative()
        .max(999999999999.99)
        .multipleOf(0.01, "El monto admite hasta 2 decimales"),
      z
        .string()
        .regex(
          /^\d{1,12}(?:\.\d{1,2})?$/,
          "El monto debe tener hasta 12 enteros y 2 decimales",
        ),
    ])
    .transform((value) => String(value)),
);

const nullableAmount = z.preprocess(
  (value) => (value === "" || value === null ? null : value),
  decimalAmount.nullable().optional(),
);

export const maintenancePartSchema = z
  .object({
    name: z.string().trim().min(1, "Nombre de repuesto requerido").max(200),
    quantity: z.number().int().positive().max(100000),
    unitCost: z.preprocess(
      (value) => (value === "" || value === null ? null : value),
      decimalAmount.nullable().optional(),
    ),
  })
  .strict();

const maintenanceFields = {
  assetId: z.string().cuid("ID de activo inválido"),
  type: z.enum(MAINTENANCE_TYPES),
  status: z.enum(MAINTENANCE_STATUSES).optional().default("SCHEDULED"),
  scheduledAt: nullableDate,
  performedAt: nullableDate,
  description: z
    .string()
    .trim()
    .min(1, "Descripción requerida")
    .max(10000),
  performedById: nullableId("técnico"),
  supplierId: nullableId("proveedor"),
  costAmount: nullableAmount,
  currency: z.enum(CURRENCIES).optional().default("ARS"),
  parts: z.array(maintenancePartSchema).max(200).nullable().optional(),
  ticketId: nullableId("ticket"),
};

const validateRequiredDates = (
  data: {
    status?: string;
    scheduledAt?: string | null;
    performedAt?: string | null;
    performedById?: string | null;
    supplierId?: string | null;
  },
  ctx: z.RefinementCtx,
) => {
  if (data.status === "SCHEDULED" && !data.scheduledAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scheduledAt"],
      message: "scheduledAt es obligatorio para un mantenimiento programado",
    });
  }
  if (data.status === "COMPLETED" && !data.performedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["performedAt"],
      message: "performedAt es obligatorio para un mantenimiento completado",
    });
  }
  if (
    data.status === "COMPLETED" &&
    !data.performedById &&
    !data.supplierId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["performedById"],
      message: "Un mantenimiento completado requiere técnico y/o proveedor",
    });
  }
  if (data.status && data.status !== "COMPLETED" && data.performedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["performedAt"],
      message: "performedAt sólo corresponde a un mantenimiento completado",
    });
  }
};

export const createMaintenanceSchema = z
  .object(maintenanceFields)
  .strict()
  .superRefine(validateRequiredDates);

export const updateMaintenanceSchema = z
  .object({
    expectedUpdatedAt: z
      .string()
      .datetime({ offset: true, message: "expectedUpdatedAt debe ser una fecha ISO válida" }),
    assetId: z.string().cuid("ID de activo inválido").optional(),
    type: z.enum(MAINTENANCE_TYPES).optional(),
    status: z.enum(MAINTENANCE_STATUSES).optional(),
    scheduledAt: nullableDate,
    performedAt: nullableDate,
    description: z.string().trim().min(1).max(10000).optional(),
    performedById: nullableId("técnico"),
    supplierId: nullableId("proveedor"),
    costAmount: nullableAmount,
    currency: z.enum(CURRENCIES).optional(),
    parts: z.array(maintenancePartSchema).max(200).nullable().optional(),
    ticketId: nullableId("ticket"),
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

export const maintenanceFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    type: z.enum(MAINTENANCE_TYPES).optional(),
    status: z.enum(MAINTENANCE_STATUSES).optional(),
    assetId: z.string().cuid("ID de activo inválido").optional(),
    supplierId: z.string().cuid("ID de proveedor inválido").optional(),
    scheduledFrom: filterDateValue.optional(),
    scheduledTo: filterDateValue.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .superRefine((data, ctx) => {
    const scheduledTo = data.scheduledTo
      ? new Date(data.scheduledTo)
      : null;
    if (scheduledTo && /^\d{4}-\d{2}-\d{2}$/.test(data.scheduledTo!)) {
      scheduledTo.setUTCHours(23, 59, 59, 999);
    }
    if (
      data.scheduledFrom &&
      scheduledTo &&
      new Date(data.scheduledFrom).getTime() >
        scheduledTo.getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduledTo"],
        message: "scheduledTo no puede ser anterior a scheduledFrom",
      });
    }
  });

export const maintenanceIdParamsSchema = z
  .object({ id: z.string().cuid("ID de mantenimiento inválido") })
  .strict();

export type CreateMaintenanceRequest = z.infer<
  typeof createMaintenanceSchema
>;
export type UpdateMaintenanceRequest = z.infer<
  typeof updateMaintenanceSchema
>;
export type MaintenanceFilters = z.infer<typeof maintenanceFiltersSchema>;
