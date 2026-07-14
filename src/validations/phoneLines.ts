import { z } from "zod";

export const PHONE_CARRIERS = [
  "CLARO",
  "MOVISTAR",
  "PERSONAL",
  "TUENTI",
  "OTHER",
] as const;

export const PHONE_LINE_STATUSES = [
  "ACTIVE",
  "AVAILABLE",
  "SUSPENDED",
  "CANCELLED",
] as const;

export const CURRENCIES = ["ARS", "USD"] as const;

const nullableText = (max: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().max(max).nullable().optional(),
  );

const nullableDate = z
  .union([
    z.string().datetime({ offset: true, message: "Fecha inválida" }),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida"),
    z.literal(""),
    z.null(),
  ])
  .optional();

const phoneNumberSchema = z
  .string()
  .trim()
  .regex(
    /^\+[1-9]\d{7,14}$/,
    "El número debe estar en formato E.164, por ejemplo +5493415551234",
  );

const nullableIccid = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  z
    .string()
    .trim()
    .regex(/^\d{19,20}$/, "El ICCID debe tener 19 o 20 dígitos")
    .nullable()
    .optional(),
);

const requiredIccid = z
  .string()
  .trim()
  .regex(/^\d{19,20}$/, "El ICCID debe tener 19 o 20 dígitos");

const nullableDecimal = z.preprocess(
  (value) => {
    if (value === "" || value === null || value === undefined) return value === undefined ? undefined : null;
    return typeof value === "number" ? String(value) : value;
  },
  z
    .string()
    .trim()
    .regex(/^\d{1,8}(?:\.\d{1,2})?$/, "Importe inválido")
    .nullable()
    .optional(),
);

const nullableDataAllowance = z.preprocess(
  (value) => {
    if (value === "" || value === null || value === undefined) return value === undefined ? undefined : null;
    return typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : value;
  },
  z.number().int().min(0).max(100_000).nullable().optional(),
);

const expectedUpdatedAtSchema = z.string().datetime({
  offset: true,
  message: "expectedUpdatedAt debe ser una fecha ISO válida",
});

const validateCarrier = (
  data: { carrier?: string; carrierOther?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (data.carrier === "OTHER" && !data.carrierOther) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["carrierOther"],
      message: "Indicá el nombre de la operadora",
    });
  }
  if (data.carrier && data.carrier !== "OTHER" && data.carrierOther) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["carrierOther"],
      message: "carrierOther sólo corresponde cuando carrier es OTHER",
    });
  }
};

const editableFields = {
  phoneNumber: phoneNumberSchema,
  carrier: z.enum(PHONE_CARRIERS),
  carrierOther: nullableText(100),
  planName: nullableText(150),
  dataAllowanceGb: nullableDataAllowance,
  monthlyCost: nullableDecimal,
  currency: z.enum(CURRENCIES),
  simIccid: nullableIccid,
  status: z.enum(PHONE_LINE_STATUSES),
  contractEndsAt: nullableDate,
  notes: nullableText(10_000),
};

export const createPhoneLineSchema = z
  .object({
    ...editableFields,
    currency: editableFields.currency.optional().default("ARS"),
    status: editableFields.status.optional().default("AVAILABLE"),
    carrierOther: editableFields.carrierOther,
    planName: editableFields.planName,
    dataAllowanceGb: editableFields.dataAllowanceGb,
    monthlyCost: editableFields.monthlyCost,
    simIccid: editableFields.simIccid,
    contractEndsAt: editableFields.contractEndsAt,
    notes: editableFields.notes,
  })
  .strict()
  .superRefine((data, ctx) => {
    validateCarrier(data, ctx);
    if (data.status === "ACTIVE") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Usá el endpoint de asignación para activar una línea",
      });
    }
  });

export const updatePhoneLineSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    phoneNumber: editableFields.phoneNumber.optional(),
    carrier: editableFields.carrier.optional(),
    carrierOther: editableFields.carrierOther,
    planName: editableFields.planName,
    dataAllowanceGb: editableFields.dataAllowanceGb,
    monthlyCost: editableFields.monthlyCost,
    currency: editableFields.currency.optional(),
    simIccid: editableFields.simIccid,
    status: editableFields.status.optional(),
    contractEndsAt: editableFields.contractEndsAt,
    notes: editableFields.notes,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (Object.keys(data).every((field) => field === "expectedUpdatedAt")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Debe enviar al menos un campo para actualizar",
      });
    }
  });

export const phoneLineFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(PHONE_LINE_STATUSES).optional(),
    carrier: z.enum(PHONE_CARRIERS).optional(),
    holderId: z.string().cuid("ID de persona inválido").optional(),
    assetId: z.string().cuid("ID de activo inválido").optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const phoneLineIdParamsSchema = z
  .object({ id: z.string().cuid("ID de línea inválido") })
  .strict();

export const deletePhoneLineSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
  })
  .strict();

export const assignPhoneLineSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    personId: z.string().cuid("ID de persona inválido"),
    assetId: z.string().cuid("ID de activo inválido").nullable().optional(),
    note: nullableText(1000),
  })
  .strict();

export const returnPhoneLineSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    returnNote: nullableText(1000),
  })
  .strict();

export const simChangeFiltersSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const createSimChangeSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    newIccid: requiredIccid,
    changedAt: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z
        .string()
        .datetime({ offset: true, message: "changedAt debe ser una fecha ISO válida" })
        .optional(),
    ),
    reason: nullableText(250),
    notes: nullableText(10_000),
  })
  .strict();

export type CreatePhoneLineRequest = z.infer<typeof createPhoneLineSchema>;
export type UpdatePhoneLineRequest = z.infer<typeof updatePhoneLineSchema>;
export type PhoneLineFilters = z.infer<typeof phoneLineFiltersSchema>;
export type DeletePhoneLineRequest = z.infer<typeof deletePhoneLineSchema>;
export type AssignPhoneLineRequest = z.infer<typeof assignPhoneLineSchema>;
export type ReturnPhoneLineRequest = z.infer<typeof returnPhoneLineSchema>;
export type SimChangeFilters = z.infer<typeof simChangeFiltersSchema>;
export type CreateSimChangeRequest = z.infer<typeof createSimChangeSchema>;
