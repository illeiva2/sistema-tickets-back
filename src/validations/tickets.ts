import { z } from "zod";

export const createTicketSchema = z.object({
  title: z.string().min(1, "Título requerido").max(200, "Título muy largo"),
  description: z
    .string()
    .min(1, "Descripción requerida")
    .max(5000, "Descripción muy larga"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"], {
    errorMap: () => ({ message: "Prioridad inválida" }),
  }),
});

export const updateTicketSchema = z.object({
  title: z
    .string()
    .min(1, "Título requerido")
    .max(200, "Título muy largo")
    .optional(),
  description: z
    .string()
    .min(1, "Descripción requerida")
    .max(5000, "Descripción muy larga")
    .optional(),
  status: z
    .enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"], {
      errorMap: () => ({ message: "Estado inválido" }),
    })
    .optional(),
  priority: z
    .enum(["LOW", "MEDIUM", "HIGH", "URGENT"], {
      errorMap: () => ({ message: "Prioridad inválida" }),
    })
    .optional(),
  assigneeId: z.string().cuid("ID de asignado inválido").optional(),
});

export const ticketFiltersSchema = z.object({
  q: z.string().optional(),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  requesterId: z.string().cuid().optional(),
  assigneeId: z.string().cuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
  sortBy: z
    .enum(["createdAt", "updatedAt", "title", "priority", "status"])
    .optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export type CreateTicketRequest = z.infer<typeof createTicketSchema>;
export type UpdateTicketRequest = z.infer<typeof updateTicketSchema>;
export type TicketFilters = z.infer<typeof ticketFiltersSchema>;
