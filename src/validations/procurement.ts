import { z } from "zod";

export const PURCHASE_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "ORDERED",
  "RECEIVED",
  "CANCELLED",
] as const;

export const CURRENCIES = ["ARS", "USD"] as const;

const nullableText = (max: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().max(max).nullable().optional(),
  );

const optionalId = (label: string) =>
  z.preprocess(
    (value) => (value === "" ? null : value),
    z.string().cuid(`ID de ${label} inválido`).nullable().optional(),
  );

const cuitSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === ""
      ? null
      : typeof value === "string"
        ? value.replace(/[-\s]/g, "")
        : value,
  z
    .string()
    .regex(/^\d{11}$/, "CUIT inválido")
    .nullable()
    .optional(),
);

const websiteSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().url("Sitio web inválido").max(500).nullable().optional(),
);

const supplierFields = {
  name: z.string().trim().min(2, "Nombre requerido").max(200),
  cuit: cuitSchema,
  contactName: nullableText(200),
  email: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z
      .string()
      .trim()
      .email("Email inválido")
      .max(254)
      .transform((value) => value.toLowerCase())
      .nullable()
      .optional(),
  ),
  phone: nullableText(100),
  website: websiteSchema,
  address: nullableText(500),
  categories: z
    .array(z.string().trim().min(1).max(80))
    .max(30)
    .transform((items) => [...new Set(items)]),
  notes: nullableText(10000),
};

export const createSupplierSchema = z.object(supplierFields).strict();

export const updateSupplierSchema = z
  .object({
    expectedUpdatedAt: z
      .string()
      .datetime("expectedUpdatedAt debe ser una fecha ISO válida"),
    name: supplierFields.name.optional(),
    cuit: cuitSchema,
    contactName: supplierFields.contactName,
    email: supplierFields.email,
    phone: supplierFields.phone,
    website: supplierFields.website,
    address: supplierFields.address,
    categories: supplierFields.categories.optional(),
    notes: supplierFields.notes,
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) =>
      Object.keys(data).some((field) => field !== "expectedUpdatedAt"),
    { message: "Debe enviar al menos un campo para actualizar" },
  );

export const supplierFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    isActive: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const supplierIdParamsSchema = z
  .object({ id: z.string().cuid("ID de proveedor inválido") })
  .strict();

const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, "Monto inválido");

const exchangeRateSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  z
    .union([
      z
        .string()
        .trim()
        .regex(/^\d{1,8}(?:\.\d{1,4})?$/, "Cotización inválida")
        .refine((value) => Number(value) > 0, "La cotización debe ser positiva"),
      z.number().positive().max(99_999_999.9999),
      z.null(),
    ])
    .optional(),
);

export const purchaseItemSchema = z
  .object({
    description: z.string().trim().min(2, "Descripción requerida").max(500),
    quantity: z.coerce.number().int().min(1).max(10000),
    unitPrice: moneySchema,
  })
  .strict();

const purchaseEditableFields = {
  supplierId: optionalId("proveedor"),
  currency: z.enum(CURRENCIES),
  exchangeRate: exchangeRateSchema,
  justification: z
    .string()
    .trim()
    .min(3, "Justificación requerida")
    .max(10000),
  invoiceNumber: nullableText(200),
  notes: nullableText(10000),
  items: z
    .array(purchaseItemSchema)
    .min(1, "Debe cargar al menos un ítem")
    .max(100),
};

export const createPurchaseSchema = z
  .object(purchaseEditableFields)
  .strict()
  .superRefine((data, ctx) => {
    if (data.currency === "ARS" && data.exchangeRate !== undefined && data.exchangeRate !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exchangeRate"],
        message: "La cotización solo corresponde a compras en USD",
      });
    }
  });

export const updatePurchaseSchema = z
  .object({
    expectedUpdatedAt: z
      .string()
      .datetime("expectedUpdatedAt debe ser una fecha ISO válida"),
    supplierId: purchaseEditableFields.supplierId,
    currency: purchaseEditableFields.currency.optional(),
    exchangeRate: exchangeRateSchema,
    justification: purchaseEditableFields.justification.optional(),
    invoiceNumber: purchaseEditableFields.invoiceNumber,
    notes: purchaseEditableFields.notes,
    items: purchaseEditableFields.items.optional(),
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
    if (data.currency === "ARS" && data.exchangeRate !== undefined && data.exchangeRate !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exchangeRate"],
        message: "La cotización solo corresponde a compras en USD",
      });
    }
  });

export const purchaseFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(PURCHASE_STATUSES).optional(),
    supplierId: z.string().cuid("ID de proveedor inválido").optional(),
    requestedById: z.string().cuid("ID de solicitante inválido").optional(),
    currency: z.enum(CURRENCIES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const purchaseIdParamsSchema = z
  .object({ id: z.string().cuid("ID de compra inválido") })
  .strict();

export const purchaseTransitionSchema = z
  .object({
    expectedUpdatedAt: z
      .string()
      .datetime("expectedUpdatedAt debe ser una fecha ISO válida"),
  })
  .strict();

export const cancelPurchaseSchema = z
  .object({
    expectedUpdatedAt: z
      .string()
      .datetime("expectedUpdatedAt debe ser una fecha ISO válida"),
    reason: z.string().trim().min(3, "Motivo requerido").max(1000),
  })
  .strict();

export type SupplierFilters = z.infer<typeof supplierFiltersSchema>;
export type CreateSupplierRequest = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierRequest = z.infer<typeof updateSupplierSchema>;
export type PurchaseFilters = z.infer<typeof purchaseFiltersSchema>;
export type CreatePurchaseRequest = z.infer<typeof createPurchaseSchema>;
export type UpdatePurchaseRequest = z.infer<typeof updatePurchaseSchema>;
export type PurchaseTransitionRequest = z.infer<typeof purchaseTransitionSchema>;
export type CancelPurchaseRequest = z.infer<typeof cancelPurchaseSchema>;
