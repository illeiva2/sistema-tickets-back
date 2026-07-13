import { z } from "zod";

export const EMPLOYMENT_STATUSES = [
  "ACTIVE",
  "ON_LEAVE",
  "TERMINATED",
] as const;

const nullableText = (max: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().max(max).nullable().optional(),
  );

const employeeNumberSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  z
    .string()
    .trim()
    .max(50, "El legajo es demasiado largo")
    .transform((value) => value.toUpperCase())
    .nullable()
    .optional(),
);

const workEmailSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  z
    .string()
    .trim()
    .email("Email laboral inválido")
    .max(254)
    .transform((value) => value.toLowerCase())
    .nullable()
    .optional(),
);

const nullableDate = z
  .union([
    z.string().datetime(),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida"),
    z.literal(""),
    z.null(),
  ])
  .optional();

const personFields = {
  employeeNumber: employeeNumberSchema,
  firstName: z.string().trim().min(1, "Nombre requerido").max(100),
  lastName: z.string().trim().min(1, "Apellido requerido").max(100),
  jobTitle: nullableText(150),
  workEmail: workEmailSchema,
  workPhone: nullableText(50),
  status: z.enum(EMPLOYMENT_STATUSES).optional().default("ACTIVE"),
  startDate: nullableDate,
  endDate: nullableDate,
  departmentId: z.string().cuid("ID de sector inválido").nullable().optional(),
  notes: nullableText(10000),
};

const validateDateCoherence = (
  data: { status?: string; startDate?: string | null; endDate?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (
    data.status !== undefined &&
    data.status !== "TERMINATED" &&
    data.endDate !== undefined &&
    data.endDate !== null &&
    data.endDate !== ""
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endDate"],
      message: "endDate sólo corresponde a personal desvinculado",
    });
  }

  if (
    data.startDate &&
    data.endDate &&
    new Date(data.endDate).getTime() < new Date(data.startDate).getTime()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endDate"],
      message: "endDate no puede ser anterior a startDate",
    });
  }
};

export const createPersonSchema = z
  .object(personFields)
  .strict()
  .superRefine(validateDateCoherence);

export const updatePersonSchema = z
  .object({
    expectedUpdatedAt: z
      .string()
      .datetime("expectedUpdatedAt debe ser una fecha ISO válida"),
    employeeNumber: employeeNumberSchema,
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    jobTitle: nullableText(150),
    workEmail: workEmailSchema,
    workPhone: nullableText(50),
    status: z.enum(EMPLOYMENT_STATUSES).optional(),
    startDate: nullableDate,
    endDate: nullableDate,
    departmentId: z
      .string()
      .cuid("ID de sector inválido")
      .nullable()
      .optional(),
    notes: nullableText(10000),
  })
  .strict()
  .superRefine((data, ctx) => {
    validateDateCoherence(data, ctx);
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

export const peopleFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(EMPLOYMENT_STATUSES).optional(),
    departmentId: z.string().cuid("ID de sector inválido").optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const personIdParamsSchema = z
  .object({ id: z.string().cuid("ID de persona inválido") })
  .strict();

export type CreatePersonRequest = z.infer<typeof createPersonSchema>;
export type UpdatePersonRequest = z.infer<typeof updatePersonSchema>;
export type PeopleFilters = z.infer<typeof peopleFiltersSchema>;
