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

  it("USER solo ve sus propios tickets (via AND requesterId)", async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    await request(app).get("/api/tickets").set(auth(token));

    const call = prismaMock.ticket.findMany.mock.calls[0][0] as any;
    expect(call.where.AND).toEqual(
      expect.arrayContaining([{ requesterId: "user-1" }]),
    );
  });

  it("AGENT solo ve sus tickets + sin asignar (visibilidad restringida)", async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    await request(app).get("/api/tickets").set(auth(token));

    const call = prismaMock.ticket.findMany.mock.calls[0][0] as any;
    // AGENT no puede ver assignados a otros: AND incluye OR(self, null).
    expect(call.where.AND).toEqual(
      expect.arrayContaining([
        { OR: [{ assigneeId: "agent-1" }, { assigneeId: null }] },
      ]),
    );
  });

  it("ADMIN ve todos los tickets sin filtro de visibilidad", async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    await request(app).get("/api/tickets").set(auth(token));

    const call = prismaMock.ticket.findMany.mock.calls[0][0] as any;
    // ADMIN no agrega visibilidad. Si no hay filtros, no debe haber AND.
    expect(call.where.AND).toBeUndefined();
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

  it("AGENT no puede ver ticket asignado a otro agente", async () => {
    const ticket = makeTicket({
      id: "t-1",
      assigneeId: "other-agent",
      attachments: [],
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(403);
  });

  it("AGENT puede ver ticket sin asignar", async () => {
    const ticket = {
      ...makeTicket({ id: "t-1", assigneeId: null, isRead: false }),
      attachments: [],
      comments: [],
      reads: [],
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticketRead.upsert.mockResolvedValueOnce({} as any);
    prismaMock.ticket.update.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
  });

  it("AGENT puede ver ticket asignado a sí mismo", async () => {
    const ticket = {
      ...makeTicket({ id: "t-1", assigneeId: "agent-1", isRead: true }),
      attachments: [],
      comments: [],
      reads: [],
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticketRead.upsert.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
  });
});

describe("GET /api/tickets/:id — isRead global, viewers, auto-progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AGENT al abrir marca isRead=true global y registra TicketRead", async () => {
    const ticket = {
      ...makeTicket({ id: "t-1", isRead: false, assigneeId: null }),
      attachments: [],
      comments: [],
      reads: [],
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticketRead.upsert.mockResolvedValueOnce({} as any);
    prismaMock.ticket.update.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.isRead).toBe(true);
    expect(prismaMock.ticketRead.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_ticketId: { userId: "agent-1", ticketId: "t-1" } },
      }),
    );
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t-1" },
        data: { isRead: true },
      }),
    );
  });

  it("AGENT no dispara update isRead si ya estaba en true", async () => {
    const ticket = {
      ...makeTicket({ id: "t-1", isRead: true, assigneeId: null }),
      attachments: [],
      comments: [],
      reads: [],
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticketRead.upsert.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
    // Solo el upsert de TicketRead se llama; ticket.update no, salvo
    // que dispare auto-progress (no aplica acá: no es assignee).
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  it("Auto-progress OPEN -> IN_PROGRESS cuando assignee abre el ticket", async () => {
    const ticket = {
      ...makeTicket({
        id: "t-1",
        status: "OPEN",
        assigneeId: "agent-1",
        isRead: true,
      }),
      attachments: [],
      comments: [],
      reads: [],
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticketRead.upsert.mockResolvedValueOnce({} as any);
    prismaMock.ticket.update.mockResolvedValueOnce({} as any);
    prismaMock.auditLog.create.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("IN_PROGRESS");
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t-1" },
        data: { status: "IN_PROGRESS" },
      }),
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ticket_auto_progressed",
          actorId: "agent-1",
        }),
      }),
    );
  });

  it("NO auto-progress si quien abre no es el assignee", async () => {
    const ticket = {
      ...makeTicket({
        id: "t-1",
        status: "OPEN",
        assigneeId: "other-agent",
        isRead: true,
      }),
      attachments: [],
      comments: [],
      reads: [],
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    // ADMIN abre un ticket asignado a otro agente
    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
    // No debe haber update de status.
    const updateCalls = prismaMock.ticket.update.mock.calls;
    const statusUpdates = updateCalls.filter(
      (c: any) => c[0]?.data?.status,
    );
    expect(statusUpdates).toHaveLength(0);
  });

  it("Devuelve viewers (lista de quienes vieron) para staff", async () => {
    const ticket = {
      ...makeTicket({ id: "t-1", isRead: true, assigneeId: null }),
      attachments: [],
      comments: [],
      reads: [
        {
          id: "tr-1",
          userId: "agent-2",
          ticketId: "t-1",
          lastReadAt: new Date("2026-01-01T10:00:00Z"),
          user: {
            id: "agent-2",
            name: "Pedro Agente",
            email: "pedro@x.com",
          },
        },
      ],
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticketRead.upsert.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.viewers).toHaveLength(1);
    expect(res.body.data.viewers[0].user.name).toBe("Pedro Agente");
    expect(res.body.data.reads).toBeUndefined();
  });

  it("Para USER no incluye viewers", async () => {
    const ticket = {
      ...makeTicket({ id: "t-1", requesterId: "user-1" }),
      attachments: [],
      comments: [],
      reads: [
        {
          id: "tr-1",
          userId: "agent-1",
          ticketId: "t-1",
          lastReadAt: new Date(),
          user: { id: "agent-1", name: "x", email: "x@x.com" },
        },
      ],
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app).get("/api/tickets/t-1").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.viewers).toBeUndefined();
    expect(res.body.data.reads).toBeUndefined();
  });
});

describe("POST /api/tickets/:id/comments — comentario invalida isRead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Comentario del REQUESTER vuelve a isRead=false si estaba true", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "user-1",
      isRead: true,
      assignee: null,
      requester: makeUser(),
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.comment.create.mockResolvedValueOnce({
      id: "c-1",
      ticketId: "t-1",
      authorId: "user-1",
      message: "tengo info nueva",
      author: { id: "user-1", name: "Test User", email: "user@test.local", role: "USER" },
    } as any);
    prismaMock.ticket.update.mockResolvedValueOnce({} as any);
    prismaMock.notificationPreferences.findUnique.mockResolvedValue({
      commentAdded: true,
      email: false,
    } as any);
    prismaMock.notification.create.mockResolvedValue({} as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .post("/api/tickets/t-1/comments")
      .set(auth(token))
      .send({ message: "tengo info nueva" });

    expect(res.status).toBe(201);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t-1" },
        data: { isRead: false },
      }),
    );
  });

  it("Comentario del REQUESTER no dispara update si ya estaba isRead=false", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "user-1",
      isRead: false,
      assignee: null,
      requester: makeUser(),
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.comment.create.mockResolvedValueOnce({
      id: "c-1",
      ticketId: "t-1",
      authorId: "user-1",
      message: "otro",
      author: { id: "user-1", name: "x", email: "x@x.com", role: "USER" },
    } as any);
    prismaMock.notificationPreferences.findUnique.mockResolvedValue({
      commentAdded: true,
      email: false,
    } as any);
    prismaMock.notification.create.mockResolvedValue({} as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .post("/api/tickets/t-1/comments")
      .set(auth(token))
      .send({ message: "otro" });

    expect(res.status).toBe(201);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  it("Comentario del AGENT (no requester) NO invalida isRead", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "user-1",
      assigneeId: "agent-1",
      isRead: true,
      assignee: makeAgent(),
      requester: makeUser(),
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.comment.create.mockResolvedValueOnce({
      id: "c-1",
      ticketId: "t-1",
      authorId: "agent-1",
      message: "ya estoy en eso",
      author: {
        id: "agent-1",
        name: "Test Agent",
        email: "agent@test.local",
        role: "AGENT",
      },
    } as any);
    prismaMock.notificationPreferences.findUnique.mockResolvedValue({
      commentAdded: true,
      email: false,
    } as any);
    prismaMock.notification.create.mockResolvedValue({} as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .post("/api/tickets/t-1/comments")
      .set(auth(token))
      .send({ message: "ya estoy en eso" });

    expect(res.status).toBe(201);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/tickets/:id — USER edita category", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("USER puede cambiar la categoría de su ticket OPEN", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "user-1",
      status: "OPEN",
      category: "SOFTWARE",
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticket.update.mockResolvedValueOnce({
      ...ticket,
      category: "HARDWARE",
      requester: makeUser(),
      assignee: null,
    } as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .patch("/api/tickets/t-1")
      .set(auth(token))
      .send({ category: "HARDWARE" });

    expect(res.status).toBe(200);
    expect(res.body.data.category).toBe("HARDWARE");
  });

  it("USER puede cambiar category de IN_PROGRESS", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "user-1",
      status: "IN_PROGRESS",
      category: "OTRO",
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    prismaMock.ticket.update.mockResolvedValueOnce({
      ...ticket,
      category: "ERP",
      requester: makeUser(),
      assignee: null,
    } as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .patch("/api/tickets/t-1")
      .set(auth(token))
      .send({ category: "ERP" });

    expect(res.status).toBe(200);
    expect(res.body.data.category).toBe("ERP");
  });

  it("USER NO puede cambiar category si el ticket está RESOLVED", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "user-1",
      status: "RESOLVED",
      category: "SOFTWARE",
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .patch("/api/tickets/t-1")
      .set(auth(token))
      .send({ category: "HARDWARE" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");
  });

  it("USER NO puede cambiar category si el ticket está CLOSED", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "user-1",
      status: "CLOSED",
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .patch("/api/tickets/t-1")
      .set(auth(token))
      .send({ category: "ERP" });

    expect(res.status).toBe(400);
  });

  it("USER NO puede cambiar category de un ticket de otro user", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "other-user",
      status: "OPEN",
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .patch("/api/tickets/t-1")
      .set(auth(token))
      .send({ category: "HARDWARE" });

    expect(res.status).toBe(403);
  });

  it("USER sigue sin poder modificar priority", async () => {
    const ticket = makeTicket({
      id: "t-1",
      requesterId: "user-1",
      status: "OPEN",
    });
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "user-1", role: "USER" });
    const res = await request(app)
      .patch("/api/tickets/t-1")
      .set(auth(token))
      .send({ priority: "URGENT" });

    expect(res.status).toBe(403);
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

describe("GET /api/tickets — filtros de triage con isRead global", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AGENT con filter=fresh aplica assigneeId:null + isRead:false", async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(0 as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .get("/api/tickets?filter=fresh")
      .set(auth(token));

    expect(res.status).toBe(200);
    const callArgs = prismaMock.ticket.findMany.mock.calls[0][0] as any;
    expect(callArgs.where.assigneeId).toBeNull();
    expect(callArgs.where.isRead).toBe(false);
    expect(callArgs.where.status).toEqual({
      in: ["OPEN", "IN_PROGRESS"],
    });
  });

  it("AGENT con filter=unread aplica isRead:false (global)", async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([] as any);
    prismaMock.ticket.count.mockResolvedValueOnce(0 as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .get("/api/tickets?filter=unread")
      .set(auth(token));

    expect(res.status).toBe(200);
    const callArgs = prismaMock.ticket.findMany.mock.calls[0][0] as any;
    expect(callArgs.where.isRead).toBe(false);
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
    // USER no participa del triage: isRead no aplica.
    expect(callArgs.where.isRead).toBeUndefined();
    // requesterId aplicado por la regla de visibilidad de USER (en AND).
    expect(callArgs.where.AND).toEqual(
      expect.arrayContaining([{ requesterId: "user-1" }]),
    );
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
