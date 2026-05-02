import type { TicketPriority } from "@prisma/client";

/**
 * Horas de SLA por prioridad. Determinan cuándo vence un ticket si no se
 * resuelve. Se aplican al crear el ticket y se recalculan si cambia la
 * prioridad (preservando createdAt como base).
 */
export const SLA_HOURS: Record<TicketPriority, number> = {
  URGENT: 4,
  HIGH: 24,
  MEDIUM: 72,
  LOW: 168,
};

export const calculateDueAt = (
  priority: TicketPriority,
  createdAt: Date,
): Date => {
  const hours = SLA_HOURS[priority];
  return new Date(createdAt.getTime() + hours * 60 * 60 * 1000);
};

export const isOverdue = (
  dueAt: Date | null | undefined,
  status: string,
): boolean => {
  if (!dueAt) return false;
  if (status === "RESOLVED" || status === "CLOSED") return false;
  return dueAt.getTime() < Date.now();
};
