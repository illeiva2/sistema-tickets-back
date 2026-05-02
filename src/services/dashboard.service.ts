import { prisma } from "../lib/database";

export type DashboardPeriod = "7d" | "30d" | "90d" | "year";

const periodToDays: Record<DashboardPeriod, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  year: 365,
};

export const parsePeriod = (raw?: string): DashboardPeriod => {
  if (raw === "7d" || raw === "30d" || raw === "90d" || raw === "year") {
    return raw;
  }
  return "30d";
};

const periodStart = (period: DashboardPeriod): Date => {
  const days = periodToDays[period];
  const start = new Date();
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  return start;
};

// Selector compacto para listas de tickets en el dashboard.
const ticketListSelect = {
  id: true,
  ticketNumber: true,
  title: true,
  status: true,
  priority: true,
  category: true,
  isRead: true,
  dueAt: true,
  createdAt: true,
  updatedAt: true,
  requester: { select: { id: true, name: true, email: true } },
  assignee: { select: { id: true, name: true, email: true } },
} as const;

const hoursBetween = (later: Date, earlier: Date): number =>
  (later.getTime() - earlier.getTime()) / 36e5;

const average = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

// ─── USER ────────────────────────────────────────────────────────────────────

export async function getUserDashboard(userId: string, period: DashboardPeriod) {
  const since = periodStart(period);

  const [activeTickets, resolvedPending, recent, resolvedInPeriod, allMine] =
    await Promise.all([
      prisma.ticket.findMany({
        where: {
          requesterId: userId,
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
        select: { id: true, priority: true },
      }),
      prisma.ticket.findMany({
        where: { requesterId: userId, status: "RESOLVED" },
        select: ticketListSelect,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.ticket.findMany({
        where: { requesterId: userId },
        select: ticketListSelect,
        orderBy: { updatedAt: "desc" },
        take: 5,
      }),
      prisma.ticket.findMany({
        where: {
          requesterId: userId,
          status: { in: ["RESOLVED", "CLOSED"] },
          updatedAt: { gte: since },
        },
        select: { id: true, createdAt: true, updatedAt: true },
      }),
      prisma.ticket.findMany({
        where: { requesterId: userId },
        select: { status: true },
      }),
    ]);

  const myActiveByPriority = { LOW: 0, MEDIUM: 0, HIGH: 0, URGENT: 0 };
  for (const t of activeTickets) {
    myActiveByPriority[t.priority as keyof typeof myActiveByPriority]++;
  }

  const myStatusBreakdown = { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0, CLOSED: 0 };
  for (const t of allMine) {
    myStatusBreakdown[t.status as keyof typeof myStatusBreakdown]++;
  }

  const avgResolutionHours = average(
    resolvedInPeriod.map((t) => hoursBetween(t.updatedAt, t.createdAt)),
  );

  const myResolutionTrend = buildDailyResolved(
    resolvedInPeriod.map((t) => t.updatedAt),
    since,
  );

  return {
    role: "USER" as const,
    period,
    myActiveCount: activeTickets.length,
    myActiveByPriority,
    myStatusBreakdown,
    myResolvedPendingClose: resolvedPending,
    myRecentTickets: recent,
    avgResolutionHours,
    myResolutionTrend,
  };
}

// ─── AGENT ───────────────────────────────────────────────────────────────────

export async function getAgentDashboard(userId: string, period: DashboardPeriod) {
  const since = periodStart(period);

  const [
    inProgress,
    resolvedActive,
    unassigned,
    resolvedInPeriod,
  ] = await Promise.all([
    prisma.ticket.findMany({
      where: { assigneeId: userId, status: "IN_PROGRESS" },
      select: ticketListSelect,
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    }),
    prisma.ticket.findMany({
      where: { assigneeId: userId, status: "RESOLVED" },
      select: ticketListSelect,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.ticket.findMany({
      where: { assigneeId: null, status: "OPEN" },
      select: ticketListSelect,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 10,
    }),
    prisma.ticket.findMany({
      where: {
        assigneeId: userId,
        status: { in: ["RESOLVED", "CLOSED"] },
        updatedAt: { gte: since },
      },
      select: { id: true, createdAt: true, updatedAt: true },
    }),
  ]);

  const avgResolutionHours = average(
    resolvedInPeriod.map((t) => hoursBetween(t.updatedAt, t.createdAt)),
  );

  const myResolutionTrend = buildDailyResolved(
    resolvedInPeriod.map((t) => t.updatedAt),
    since,
  );

  return {
    role: "AGENT" as const,
    period,
    myInProgressCount: inProgress.length,
    myResolvedActiveCount: resolvedActive.length,
    resolvedInPeriodCount: resolvedInPeriod.length,
    myActiveTickets: [...inProgress, ...resolvedActive],
    unassignedTickets: unassigned,
    avgResolutionHours,
    myResolutionTrend,
  };
}

// ─── ADMIN ───────────────────────────────────────────────────────────────────

export async function getAdminDashboard(period: DashboardPeriod) {
  const since = periodStart(period);

  const now = new Date();

  const [
    statusCounts,
    priorityCounts,
    unassignedCount,
    urgentActiveCount,
    overdueCount,
    overdueTickets,
    unassignedTickets,
    ticketsCreatedInPeriod,
    ticketsResolvedInPeriod,
    auditAssignedInPeriod,
    auditResolvedInPeriod,
    auditReopenedInPeriod,
    activeAgents,
    topRequestersRaw,
  ] = await Promise.all([
    prisma.ticket.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ["priority"],
      _count: { _all: true },
      where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
    }),
    prisma.ticket.count({
      where: { assigneeId: null, status: { in: ["OPEN", "IN_PROGRESS"] } },
    }),
    prisma.ticket.count({
      where: {
        priority: "URGENT",
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    }),
    prisma.ticket.count({
      where: {
        status: { in: ["OPEN", "IN_PROGRESS"] },
        dueAt: { lt: now },
      },
    }),
    prisma.ticket.findMany({
      where: {
        status: { in: ["OPEN", "IN_PROGRESS"] },
        dueAt: { lt: now },
      },
      select: ticketListSelect,
      orderBy: { dueAt: "asc" },
      take: 10,
    }),
    prisma.ticket.findMany({
      where: { assigneeId: null, status: "OPEN" },
      select: ticketListSelect,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 10,
    }),
    prisma.ticket.findMany({
      where: { createdAt: { gte: since } },
      select: { id: true, createdAt: true },
    }),
    prisma.ticket.findMany({
      where: {
        status: { in: ["RESOLVED", "CLOSED"] },
        updatedAt: { gte: since },
      },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        assigneeId: true,
      },
    }),
    prisma.auditLog.findMany({
      where: {
        entity: "ticket",
        action: { in: ["ticket_claimed", "ticket_assigned_updated"] },
        createdAt: { gte: since },
      },
      select: { entityId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.auditLog.findMany({
      where: {
        entity: "ticket",
        action: "ticket_resolved",
        createdAt: { gte: since },
      },
      select: { entityId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.auditLog.count({
      where: {
        entity: "ticket",
        action: { contains: "reopen" },
        createdAt: { gte: since },
      } as any,
    }),
    prisma.user.findMany({
      where: { role: "AGENT", isActive: true },
      select: { id: true, name: true, email: true },
    }),
    prisma.ticket.groupBy({
      by: ["requesterId"],
      _count: { _all: true },
      where: { createdAt: { gte: since } },
      orderBy: { _count: { requesterId: "desc" } },
      take: 5,
    }),
  ]);

  // Totales por estado.
  const totalsByStatus: Record<string, number> = {
    OPEN: 0,
    IN_PROGRESS: 0,
    RESOLVED: 0,
    CLOSED: 0,
  };
  for (const row of statusCounts) {
    totalsByStatus[row.status] = row._count._all;
  }

  // Distribución por prioridad de tickets activos.
  const byPriority: Record<string, number> = {
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
    URGENT: 0,
  };
  for (const row of priorityCounts) {
    byPriority[row.priority] = row._count._all;
  }

  // Tiempo de respuesta: createdAt del ticket -> primer auditLog de
  // asignación/claim. Tomamos el más temprano por ticket.
  const firstAssignedByTicket = new Map<string, Date>();
  for (const a of auditAssignedInPeriod) {
    if (!firstAssignedByTicket.has(a.entityId)) {
      firstAssignedByTicket.set(a.entityId, a.createdAt);
    }
  }
  const ticketsByIdMap = new Map<string, Date>();
  for (const t of ticketsCreatedInPeriod) ticketsByIdMap.set(t.id, t.createdAt);
  for (const t of ticketsResolvedInPeriod)
    ticketsByIdMap.set(t.id, t.createdAt);

  const responseHours: number[] = [];
  for (const [ticketId, assignedAt] of firstAssignedByTicket.entries()) {
    const created = ticketsByIdMap.get(ticketId);
    if (created) {
      const diff = hoursBetween(assignedAt, created);
      if (diff >= 0) responseHours.push(diff);
    }
  }

  // Tiempo de resolución: createdAt del ticket -> primer auditLog de
  // resolved. Si no hay audit log usamos updatedAt como fallback.
  const firstResolvedByTicket = new Map<string, Date>();
  for (const a of auditResolvedInPeriod) {
    if (!firstResolvedByTicket.has(a.entityId)) {
      firstResolvedByTicket.set(a.entityId, a.createdAt);
    }
  }
  const resolutionHours: number[] = [];
  for (const t of ticketsResolvedInPeriod) {
    const resolvedAt = firstResolvedByTicket.get(t.id) ?? t.updatedAt;
    const diff = hoursBetween(resolvedAt, t.createdAt);
    if (diff >= 0) resolutionHours.push(diff);
  }

  const avgResponseHours = average(responseHours);
  const avgResolutionHours = average(resolutionHours);

  // Tasa de reapertura: reopens / resolved en el período.
  const reopenRate =
    ticketsResolvedInPeriod.length > 0
      ? auditReopenedInPeriod / ticketsResolvedInPeriod.length
      : null;

  // Carga por agente.
  const agentIds = activeAgents.map((a) => a.id);
  const [agentActive, agentResolved] = await Promise.all([
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: {
        assigneeId: { in: agentIds },
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: {
        assigneeId: { in: agentIds },
        status: { in: ["RESOLVED", "CLOSED"] },
        updatedAt: { gte: since },
      },
      _count: { _all: true },
    }),
  ]);

  const activeByAgent = new Map<string, number>();
  for (const r of agentActive) {
    if (r.assigneeId) activeByAgent.set(r.assigneeId, r._count._all);
  }
  const resolvedByAgent = new Map<string, number>();
  for (const r of agentResolved) {
    if (r.assigneeId) resolvedByAgent.set(r.assigneeId, r._count._all);
  }

  // Tickets resueltos en el período por agente para promedio.
  const resolvedTicketsForAgents = await prisma.ticket.findMany({
    where: {
      assigneeId: { in: agentIds },
      status: { in: ["RESOLVED", "CLOSED"] },
      updatedAt: { gte: since },
    },
    select: {
      assigneeId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const hoursByAgent = new Map<string, number[]>();
  for (const t of resolvedTicketsForAgents) {
    if (!t.assigneeId) continue;
    const arr = hoursByAgent.get(t.assigneeId) ?? [];
    arr.push(hoursBetween(t.updatedAt, t.createdAt));
    hoursByAgent.set(t.assigneeId, arr);
  }

  const agentsLoad = activeAgents
    .map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      activeCount: activeByAgent.get(a.id) ?? 0,
      resolvedInPeriod: resolvedByAgent.get(a.id) ?? 0,
      avgResolutionHours: average(hoursByAgent.get(a.id) ?? []),
    }))
    .sort((x, y) => y.activeCount - x.activeCount);

  // Tendencia: por día, creados vs resueltos.
  const trend = buildDailyTrend(
    ticketsCreatedInPeriod.map((t) => t.createdAt),
    ticketsResolvedInPeriod.map((t) => t.updatedAt),
    since,
  );

  // Top requesters: nombres.
  const requesterIds = topRequestersRaw.map((r) => r.requesterId);
  const requesters = await prisma.user.findMany({
    where: { id: { in: requesterIds } },
    select: { id: true, name: true, email: true },
  });
  const requesterById = new Map(requesters.map((u) => [u.id, u]));
  const topRequesters = topRequestersRaw
    .map((r) => {
      const u = requesterById.get(r.requesterId);
      if (!u) return null;
      return { ...u, count: r._count._all };
    })
    .filter((x): x is { id: string; name: string; email: string; count: number } => x !== null);

  return {
    role: "ADMIN" as const,
    period,
    totalsByStatus,
    byPriority,
    unassignedCount,
    urgentActiveCount,
    overdueCount,
    overdueTickets,
    unassignedTickets,
    avgResponseHours,
    avgResolutionHours,
    reopenRate,
    agentsLoad,
    createdVsResolvedTrend: trend,
    topRequesters,
  };
}

const buildDailyResolved = (
  resolvedDates: Date[],
  since: Date,
): Array<{ date: string; resolved: number }> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result: Array<{ date: string; resolved: number }> = [];
  const cursor = new Date(since);
  while (cursor <= today) {
    result.push({ date: cursor.toISOString().slice(0, 10), resolved: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  const indexByDate = new Map(result.map((r, i) => [r.date, i]));

  for (const d of resolvedDates) {
    const key = d.toISOString().slice(0, 10);
    const i = indexByDate.get(key);
    if (i !== undefined) result[i].resolved++;
  }

  return result;
};

const buildDailyTrend = (
  createdDates: Date[],
  resolvedDates: Date[],
  since: Date,
): Array<{ date: string; created: number; resolved: number }> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result: Array<{ date: string; created: number; resolved: number }> = [];
  const cursor = new Date(since);
  while (cursor <= today) {
    result.push({
      date: cursor.toISOString().slice(0, 10),
      created: 0,
      resolved: 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  const indexByDate = new Map(result.map((r, i) => [r.date, i]));

  for (const d of createdDates) {
    const key = d.toISOString().slice(0, 10);
    const i = indexByDate.get(key);
    if (i !== undefined) result[i].created++;
  }
  for (const d of resolvedDates) {
    const key = d.toISOString().slice(0, 10);
    const i = indexByDate.get(key);
    if (i !== undefined) result[i].resolved++;
  }

  return result;
};
