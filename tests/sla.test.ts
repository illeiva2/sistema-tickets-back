import { describe, it, expect } from "vitest";
import { calculateDueAt, isOverdue, SLA_HOURS } from "../src/lib/sla";

describe("SLA: calculateDueAt", () => {
  const base = new Date("2026-05-01T10:00:00.000Z");

  it("URGENT vence 4h después", () => {
    const due = calculateDueAt("URGENT", base);
    expect(due.toISOString()).toBe("2026-05-01T14:00:00.000Z");
  });

  it("HIGH vence 24h después", () => {
    const due = calculateDueAt("HIGH", base);
    expect(due.toISOString()).toBe("2026-05-02T10:00:00.000Z");
  });

  it("MEDIUM vence 72h después", () => {
    const due = calculateDueAt("MEDIUM", base);
    expect(due.toISOString()).toBe("2026-05-04T10:00:00.000Z");
  });

  it("LOW vence 168h (7 días) después", () => {
    const due = calculateDueAt("LOW", base);
    expect(due.toISOString()).toBe("2026-05-08T10:00:00.000Z");
  });

  it("SLA_HOURS está completo para todas las prioridades", () => {
    expect(SLA_HOURS.URGENT).toBe(4);
    expect(SLA_HOURS.HIGH).toBe(24);
    expect(SLA_HOURS.MEDIUM).toBe(72);
    expect(SLA_HOURS.LOW).toBe(168);
  });
});

describe("SLA: isOverdue", () => {
  const past = new Date(Date.now() - 60 * 60 * 1000); // 1h atrás
  const future = new Date(Date.now() + 60 * 60 * 1000); // 1h adelante

  it("dueAt en el pasado y status activo → vencido", () => {
    expect(isOverdue(past, "OPEN")).toBe(true);
    expect(isOverdue(past, "IN_PROGRESS")).toBe(true);
  });

  it("dueAt en el pasado pero ticket RESOLVED/CLOSED → no vencido", () => {
    expect(isOverdue(past, "RESOLVED")).toBe(false);
    expect(isOverdue(past, "CLOSED")).toBe(false);
  });

  it("dueAt en el futuro → no vencido sin importar status", () => {
    expect(isOverdue(future, "OPEN")).toBe(false);
    expect(isOverdue(future, "IN_PROGRESS")).toBe(false);
  });

  it("dueAt nullo → no vencido", () => {
    expect(isOverdue(null, "OPEN")).toBe(false);
    expect(isOverdue(undefined, "OPEN")).toBe(false);
  });
});
