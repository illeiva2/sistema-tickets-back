import { vi, describe, it, beforeEach, expect } from "vitest";

vi.mock("../src/lib/database", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { prisma: mockDeep() };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: "test" }),
      verify: vi.fn().mockResolvedValue(true),
    }),
  },
}));

import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import {
  signAccessToken,
  makeUser,
  makeTicket,
  makeAgent,
  makeAdmin,
} from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("POST /api/tickets — crear ticket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("crea un ticket sin categoría", async () => {
    const created = makeTicket({ id: "t-1", title: "Mi ticket" });
    prismaMock.ticket.create.mockResolvedValueOnce(created as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/tickets")
      .set(auth(token))
      .send({
        title: "Mi ticket",
        description: "descripción suficiente",
        priority: "MEDIUM",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe("t-1");
    expect(prismaMock.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Mi ticket",
          priority: "MEDIUM",
          category: null,
        }),
      }),
    );
  });

  it("crea un ticket con categoría SOFTWARE", async () => {
    const created = makeTicket({ category: "SOFTWARE" });
    prismaMock.ticket.create.mockResolvedValueOnce(created as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/tickets")
      .set(auth(token))
      .send({
        title: "Bug en ERP",
        description: "el ERP tira 500 al loguear",
        priority: "HIGH",
        category: "SOFTWARE",
      });

    expect(res.status).toBe(201);
    expect(prismaMock.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "SOFTWARE" }),
      }),
    );
  });

  it("rechaza priority inválida", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app).post("/api/tickets").set(auth(token)).send({
      title: "x",
      description: "y",
      priority: "OMG",
    });

    expect(res.status).toBe(400);
  });

  it("rechaza category inválida", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app).post("/api/tickets").set(auth(token)).send({
      title: "x",
      description: "y",
      priority: "LOW",
      category: "MARKETING",
    });

    expect(res.status).toBe(400);
  });

  it("requiere autenticación", async () => {
    const res = await request(app).post("/api/tickets").send({
      title: "x",
      description: "y",
      priority: "LOW",
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/tickets — listar con filtros", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("USER solo ve sus propios tickets", async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    await request(app).get("/api/tickets").set(auth(token));

    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requesterId: "user-1" }),
      }),
    );
  });

  it("AGENT ve todos los tickets sin filtro de requesterId", async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    await request(app).get("/api/tickets").set(auth(token));

    const call = prismaMock.ticket.findMany.mock.calls[0][0] as any;
    expect(call.where.requesterId).toBeUndefined();
  });

  it("filtra por category=ERP cuando viene en query", async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ role: "ADMIN" });
    await request(app).get("/api/tickets?category=ERP").set(auth(token));

    const call = prismaMock.ticket.findMany.mock.calls[0][0] as any;
    expect(call.where.category).toBe("ERP");
  });

  it("rechaza category inválida en filtros", async () => {
    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .get("/api/tickets?category=NOPE")
      .set(auth(token));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tickets/:id — permisos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("USER no puede ver el ticket de otro", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "other-user",
      attachments: [],
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(403);
  });

  it("USER ve su propio ticket", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "user-1",
      attachments: [],
      isRead: true,
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("t-1");
  });

  it("404 si el ticket no existe", async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce(null);
    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .get("/api/tickets/missing")
      .set(auth(token));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/tickets/:id/claim — tomar ticket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AGENT toma un ticket OPEN sin assignee", async () => {
    const ticket = makeTicket({
      id: "t-1",
      status: "OPEN",
      assigneeId: null,
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticket.update.mockResolvedValueOnce({
      ...ticket,
      assigneeId: "agent-1",
      status: "IN_PROGRESS",
      assignee: makeAgent(),
      requester: makeUser(),
    } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    prismaMock.notificationPreferences.findUnique.mockResolvedValue({
      ticketAssigned: true,
      email: false,
    } as any);
    prismaMock.notification.create.mockResolvedValue({} as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .patch("/api/tickets/t-1/claim")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assigneeId: "agent-1",
          status: "IN_PROGRESS",
        }),
      }),
    );
  });

  it("rechaza claim si el ticket ya está asignado", async () => {
    const ticket = makeTicket({
      id: "t-1",
      assigneeId: "other-agent",
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .patch("/api/tickets/t-1/claim")
      .set(auth(token));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TICKET_ALREADY_ASSIGNED");
  });

  it("USER no puede hacer claim", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .patch("/api/tickets/t-1/claim")
      .set(auth(token));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/tickets/:id/resolve — resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AGENT resuelve un ticket IN_PROGRESS", async () => {
    const ticket = makeTicket({ id: "t-1", status: "IN_PROGRESS" });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticket.update.mockResolvedValueOnce({
      ...ticket,
      status: "RESOLVED",
      requester: makeUser(),
      assignee: null,
      comments: [],
    } as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);
    prismaMock.notificationPreferences.findUnique.mockResolvedValue({
      statusChanged: true,
      email: false,
    } as any);
    prismaMock.notification.create.mockResolvedValue({} as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .post("/api/tickets/t-1/resolve")
      .set(auth(token))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("RESOLVED");
  });

  it("rechaza resolver un ticket ya CLOSED", async () => {
    const ticket = makeTicket({ id: "t-1", status: "CLOSED" });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ role: "AGENT" });
    const res = await request(app)
      .post("/api/tickets/t-1/resolve")
      .set(auth(token))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");
  });

  it("USER no puede resolver", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/tickets/t-1/resolve")
      .set(auth(token))
      .send({});
    expect(res.status).toBe(403);
  });
});

describe("POST /api/tickets/:id/close — cerrar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requiere comentario", async () => {
    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .post("/api/tickets/t-1/close")
      .set(auth(token))
      .send({});
    expect(res.status).toBe(400);
  });

  it("USER cierra su propio ticket con comentario", async () => {
    const ticket = makeTicket({
      id: "t-1",
      status: "RESOLVED",
      requesterId: "user-1",
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.comment.create.mockResolvedValueOnce({} as any);
    prismaMock.ticket.update.mockResolvedValueOnce({
      ...ticket,
      status: "CLOSED",
      closedAt: new Date(),
      requester: makeUser(),
      assignee: null,
      comments: [],
    } as any);
    prismaMock.notificationPreferences.findUnique.mockResolvedValue({
      statusChanged: true,
      email: false,
    } as any);
    prismaMock.notification.create.mockResolvedValue({} as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .post("/api/tickets/t-1/close")
      .set(auth(token))
      .send({ comment: "todo OK" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("CLOSED");
  });

  it("USER no puede cerrar ticket de otro", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "other",
      status: "OPEN",
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .post("/api/tickets/t-1/close")
      .set(auth(token))
      .send({ comment: "x" });

    expect(res.status).toBe(403);
  });
});

describe("GET /api/tickets/triage-counts — triage AGENT/ADMIN", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("USER no tiene acceso al triage", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/tickets/triage-counts")
      .set(auth(token));
    expect(res.status).toBe(403);
  });

  it("AGENT recibe contadores fresh/unassigned/unread/mine", async () => {
    // Las 4 llamadas a count en orden: fresh, unassigned, unread, mine.
    prismaMock.ticket.count
      .mockResolvedValueOnce(2 as any)
      .mockResolvedValueOnce(5 as any)
      .mockResolvedValueOnce(3 as any)
      .mockResolvedValueOnce(7 as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .get("/api/tickets/triage-counts")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      fresh: 2,
      unassigned: 5,
      unread: 3,
      mine: 7,
    });
  });

  it("ADMIN recibe contadores", async () => {
    prismaMock.ticket.count
      .mockResolvedValueOnce(0 as any)
      .mockResolvedValueOnce(0 as any)
      .mockResolvedValueOnce(0 as any)
      .mockResolvedValueOnce(0 as any);

    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    const res = await request(app)
      .get("/api/tickets/triage-counts")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      fresh: 0,
      unassigned: 0,
      unread: 0,
      mine: 0,
    });
  });
});

describe("GET /api/tickets — filtros de triage e isRead per-user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AGENT con filter=fresh aplica where assigneeId:null + reads:none", async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(0 as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .get("/api/tickets?filter=fresh")
      .set(auth(token));

    expect(res.status).toBe(200);
    const callArgs = prismaMock.ticket.findMany.mock.calls[0][0] as any;
    expect(callArgs.where.assigneeId).toBeNull();
    expect(callArgs.where.reads).toEqual({ none: { userId: "agent-1" } });
    expect(callArgs.where.status).toEqual({
      in: ["OPEN", "IN_PROGRESS"],
    });
  });

  it("AGENT recibe isRead=true cuando hay TicketRead suyo", async () => {
    const ticketRead = makeTicket({ id: "t-1", isRead: false });
    prismaMock.ticket.findMany.mockResolvedValueOnce([
      { ...ticketRead, reads: [{ id: "tr-1" }], _count: { comments: 0 } },
    ] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(1 as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app).get("/api/tickets").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].isRead).toBe(true);
    expect(res.body.data.data[0].reads).toBeUndefined();
  });

  it("AGENT recibe isRead=false cuando no hay TicketRead suyo", async () => {
    const ticketRead = makeTicket({ id: "t-1", isRead: true });
    prismaMock.ticket.findMany.mockResolvedValueOnce([
      { ...ticketRead, reads: [], _count: { comments: 0 } },
    ] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(1 as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app).get("/api/tickets").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].isRead).toBe(false);
  });

  it("USER no aplica filtros de triage (filter=fresh ignorado)", async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(0 as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .get("/api/tickets?filter=fresh")
      .set(auth(token));

    expect(res.status).toBe(200);
    const callArgs = prismaMock.ticket.findMany.mock.calls[0][0] as any;
    // No hay where.reads para USER
    expect(callArgs.where.reads).toBeUndefined();
    // requesterId aplicado por la regla de visibilidad de USER
    expect(callArgs.where.requesterId).toBe("user-1");
  });
});

describe("GET /api/tickets/:id — upsert TicketRead per-user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AGENT al abrir ticket dispara upsert en TicketRead", async () => {
    const ticket = {
      ...makeTicket({ id: "t-1" }),
      comments: [],
      attachments: [],
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticketRead.upsert.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
    expect(prismaMock.ticketRead.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_ticketId: { userId: "agent-1", ticketId: "t-1" } },
      }),
    );
    expect(res.body.data.isRead).toBe(true);
  });

  it("USER al abrir su propio ticket NO dispara upsert", async () => {
    const ticket = {
      ...makeTicket({ id: "t-1", requesterId: "user-1" }),
      comments: [],
      attachments: [],
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
    expect(prismaMock.ticketRead.upsert).not.toHaveBeenCalled();
  });
});

// Suppress unused-import warnings — los helpers se usan a futuro.
void makeAdmin;
