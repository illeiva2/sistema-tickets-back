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

// Mock del cliente de Anthropic para no llamar a la API real en tests.
const mockMessagesCreate = vi.fn();
vi.mock("../src/lib/anthropic", () => ({
  isAnthropicConfigured: () => true,
  getAnthropicClient: () => ({
    messages: { create: mockMessagesCreate },
  }),
  RESOURCE_DRAFT_MODEL: "claude-opus-4-7",
}));

import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const makeResource = (overrides: Partial<any> = {}) => ({
  id: "r-1",
  slug: "como-configurar-vpn",
  title: "Cómo configurar el VPN",
  content: "Pasos para configurar el VPN…",
  excerpt: "Tutorial breve",
  category: "HOW_TO",
  tags: ["vpn", "red"],
  isPublished: true,
  viewCount: 0,
  authorId: "admin-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  author: { id: "admin-1", name: "Admin", email: "admin@test.local" },
  ...overrides,
});

describe("GET /api/resources", () => {
  beforeEach(() => vi.clearAllMocks());

  it("USER ve solo publicados", async () => {
    prismaMock.resource.findMany.mockResolvedValueOnce([makeResource()] as any);
    prismaMock.resource.count.mockResolvedValueOnce(1);

    const token = signAccessToken({ role: "USER" });
    await request(app).get("/api/resources").set(auth(token));

    const call = prismaMock.resource.findMany.mock.calls[0][0] as any;
    expect(call.where.isPublished).toBe(true);
  });

  it("ADMIN sin includeDrafts también filtra publicados", async () => {
    prismaMock.resource.findMany.mockResolvedValueOnce([] as any);
    prismaMock.resource.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ role: "ADMIN" });
    await request(app).get("/api/resources").set(auth(token));

    const call = prismaMock.resource.findMany.mock.calls[0][0] as any;
    expect(call.where.isPublished).toBe(true);
  });

  it("ADMIN con includeDrafts=true ve borradores", async () => {
    prismaMock.resource.findMany.mockResolvedValueOnce([] as any);
    prismaMock.resource.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ role: "ADMIN" });
    await request(app)
      .get("/api/resources?includeDrafts=true")
      .set(auth(token));

    const call = prismaMock.resource.findMany.mock.calls[0][0] as any;
    expect(call.where.isPublished).toBeUndefined();
  });

  it("filtra por category", async () => {
    prismaMock.resource.findMany.mockResolvedValueOnce([] as any);
    prismaMock.resource.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ role: "USER" });
    await request(app)
      .get("/api/resources?category=POLICY")
      .set(auth(token));

    const call = prismaMock.resource.findMany.mock.calls[0][0] as any;
    expect(call.where.category).toBe("POLICY");
  });

  it("rechaza category inválida", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/resources?category=INVENTADA")
      .set(auth(token));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/resources/:idOrSlug", () => {
  beforeEach(() => vi.clearAllMocks());

  it("acepta slug y devuelve el recurso publicado", async () => {
    prismaMock.resource.findFirst.mockResolvedValueOnce(makeResource() as any);
    prismaMock.resource.update.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/resources/como-configurar-vpn")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("Cómo configurar el VPN");
  });

  it("404 para borrador cuando el user no es ADMIN", async () => {
    prismaMock.resource.findFirst.mockResolvedValueOnce(
      makeResource({ isPublished: false }) as any,
    );

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/resources/como-configurar-vpn")
      .set(auth(token));
    expect(res.status).toBe(404);
  });

  it("ADMIN puede leer borradores", async () => {
    prismaMock.resource.findFirst.mockResolvedValueOnce(
      makeResource({ isPublished: false }) as any,
    );
    prismaMock.resource.update.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .get("/api/resources/r-1")
      .set(auth(token));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/resources", () => {
  beforeEach(() => vi.clearAllMocks());

  it("USER no puede crear", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/resources")
      .set(auth(token))
      .send({ title: "Test", content: "x", category: "HOW_TO" });
    expect(res.status).toBe(403);
  });

  it("AGENT no puede crear", async () => {
    const token = signAccessToken({ role: "AGENT" });
    const res = await request(app)
      .post("/api/resources")
      .set(auth(token))
      .send({ title: "Test", content: "x", category: "HOW_TO" });
    expect(res.status).toBe(403);
  });

  it("ADMIN crea con slug derivado del título", async () => {
    prismaMock.resource.findUnique.mockResolvedValue(null);
    prismaMock.resource.create.mockResolvedValueOnce(
      makeResource({
        slug: "como-configurar-el-vpn",
        title: "Cómo configurar el VPN",
      }) as any,
    );

    const token = signAccessToken({ id: "admin-1", role: "ADMIN" });
    const res = await request(app)
      .post("/api/resources")
      .set(auth(token))
      .send({
        title: "Cómo configurar el VPN",
        content: "Pasos: 1) abrir, 2) clickear...",
        category: "HOW_TO",
      });

    expect(res.status).toBe(201);
    const call = prismaMock.resource.create.mock.calls[0][0] as any;
    expect(call.data.slug).toBe("como-configurar-el-vpn");
    expect(call.data.authorId).toBe("admin-1");
  });

  it("rechaza título muy corto", async () => {
    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .post("/api/resources")
      .set(auth(token))
      .send({ title: "x", content: "y", category: "HOW_TO" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/resources/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ADMIN edita", async () => {
    prismaMock.resource.findUnique.mockResolvedValueOnce(makeResource() as any);
    prismaMock.resource.update.mockResolvedValueOnce(
      makeResource({ title: "Nuevo título" }) as any,
    );

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .patch("/api/resources/r-1")
      .set(auth(token))
      .send({ title: "Nuevo título" });
    expect(res.status).toBe(200);
  });

  it("USER no puede editar", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .patch("/api/resources/r-1")
      .set(auth(token))
      .send({ title: "Hack" });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/resources/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ADMIN elimina", async () => {
    prismaMock.resource.findUnique.mockResolvedValueOnce(makeResource() as any);
    prismaMock.resource.delete.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .delete("/api/resources/r-1")
      .set(auth(token));
    expect(res.status).toBe(200);
  });

  it("USER no puede eliminar", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .delete("/api/resources/r-1")
      .set(auth(token));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/resources/suggest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rechaza query muy corto", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/resources/suggest?q=a")
      .set(auth(token));
    expect(res.status).toBe(400);
  });

  it("ordena resultados por relevancia (matches en title pesan más)", async () => {
    prismaMock.resource.findMany.mockResolvedValueOnce([
      {
        id: "r-1",
        slug: "vpn",
        title: "Cómo configurar el VPN",
        excerpt: "Tutorial",
        category: "HOW_TO",
        tags: ["red"],
        content: "Pasos...",
      },
      {
        id: "r-2",
        slug: "outlook",
        title: "Outlook no sincroniza",
        excerpt: "FAQ común",
        category: "FAQ",
        tags: ["mail"],
        content: "Vpn problemas...", // matchea "vpn" pero solo en content
      },
    ] as any);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/resources/suggest?q=vpn")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // r-1 tiene "vpn" en title (peso 3), r-2 solo en content (peso 1).
    expect(res.body.data[0].id).toBe("r-1");
    expect(res.body.data[1].id).toBe("r-2");
  });

  it("filtra los que no matchean nada", async () => {
    prismaMock.resource.findMany.mockResolvedValueOnce([] as any);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/resources/suggest?q=algoraro")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe("GET /api/resources — orden y pinned", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listado ordena por isPinned DESC, updatedAt DESC", async () => {
    prismaMock.resource.findMany.mockResolvedValueOnce([] as any);
    prismaMock.resource.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ role: "USER" });
    await request(app).get("/api/resources").set(auth(token));

    const call = prismaMock.resource.findMany.mock.calls[0][0] as any;
    expect(call.orderBy).toEqual([
      { isPinned: "desc" },
      { updatedAt: "desc" },
    ]);
  });
});

describe("GET /api/resources/pinned", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Devuelve recursos pinned publicados (default limit 5)", async () => {
    const pinned = makeResource({ id: "r-pin-1", isPinned: true });
    prismaMock.resource.findMany.mockResolvedValueOnce([pinned] as any);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/resources/pinned")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("r-pin-1");

    const call = prismaMock.resource.findMany.mock.calls[0][0] as any;
    expect(call.where.isPinned).toBe(true);
    expect(call.where.isPublished).toBe(true);
    expect(call.take).toBe(5);
  });

  it("Filtra por categoria cuando viene en query", async () => {
    prismaMock.resource.findMany.mockResolvedValueOnce([] as any);

    const token = signAccessToken({ role: "USER" });
    await request(app)
      .get("/api/resources/pinned?category=ANNOUNCEMENT&limit=3")
      .set(auth(token));

    const call = prismaMock.resource.findMany.mock.calls[0][0] as any;
    expect(call.where.category).toBe("ANNOUNCEMENT");
    expect(call.take).toBe(3);
  });

  it("Rechaza categoria invalida", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/resources/pinned?category=NOPE")
      .set(auth(token));

    expect(res.status).toBe(400);
  });
});

describe("GET /api/resources/pinned — filtros showAsModal y pinExpiresAt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Excluye recursos con showAsModal=true (esos van al modal)", async () => {
    prismaMock.resource.findMany.mockResolvedValueOnce([] as any);
    const token = signAccessToken({ role: "USER" });
    await request(app).get("/api/resources/pinned").set(auth(token));
    const call = prismaMock.resource.findMany.mock.calls[0][0] as any;
    expect(call.where.showAsModal).toBe(false);
  });

  it("Filtra pin expirado (pinExpiresAt > now O null)", async () => {
    prismaMock.resource.findMany.mockResolvedValueOnce([] as any);
    const token = signAccessToken({ role: "USER" });
    await request(app).get("/api/resources/pinned").set(auth(token));
    const call = prismaMock.resource.findMany.mock.calls[0][0] as any;
    expect(call.where.OR).toEqual([
      { pinExpiresAt: null },
      { pinExpiresAt: { gt: expect.any(Date) } },
    ]);
  });
});

describe("GET /api/resources/modal-pinned", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Devuelve solo pinned + showAsModal=true + no expirados", async () => {
    const r = makeResource({
      id: "r-modal",
      isPinned: true,
      showAsModal: true,
    });
    prismaMock.resource.findMany.mockResolvedValueOnce([r] as any);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/resources/modal-pinned")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("r-modal");

    const call = prismaMock.resource.findMany.mock.calls[0][0] as any;
    expect(call.where.showAsModal).toBe(true);
    expect(call.where.isPinned).toBe(true);
    expect(call.where.isPublished).toBe(true);
    expect(call.where.OR).toEqual([
      { pinExpiresAt: null },
      { pinExpiresAt: { gt: expect.any(Date) } },
    ]);
  });

  it("Requiere autenticacion", async () => {
    const res = await request(app).get("/api/resources/modal-pinned");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/resources/:id — campos modal-pinned", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ADMIN puede setear showAsModal y pinExpiresAt", async () => {
    const existing = makeResource({ id: "r-1" });
    prismaMock.resource.findUnique.mockResolvedValueOnce(existing as any);
    prismaMock.resource.update.mockResolvedValueOnce({
      ...existing,
      isPinned: true,
      showAsModal: true,
      pinExpiresAt: new Date("2026-06-01T00:00:00Z"),
    } as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .patch("/api/resources/r-1")
      .set(auth(token))
      .send({
        isPinned: true,
        showAsModal: true,
        pinExpiresAt: "2026-06-01T00:00:00Z",
      });

    expect(res.status).toBe(200);
    const call = prismaMock.resource.update.mock.calls[0][0] as any;
    expect(call.data.showAsModal).toBe(true);
    expect(call.data.pinExpiresAt).toBeInstanceOf(Date);
  });

  it("ADMIN puede limpiar pinExpiresAt mandando null", async () => {
    const existing = makeResource({ id: "r-1" });
    prismaMock.resource.findUnique.mockResolvedValueOnce(existing as any);
    prismaMock.resource.update.mockResolvedValueOnce(existing as any);

    const token = signAccessToken({ role: "ADMIN" });
    await request(app)
      .patch("/api/resources/r-1")
      .set(auth(token))
      .send({ pinExpiresAt: null });

    const call = prismaMock.resource.update.mock.calls[0][0] as any;
    expect(call.data.pinExpiresAt).toBeNull();
  });
});

describe("POST /api/resources/draft-from-ticket/:ticketId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMessagesCreate.mockReset();
  });

  const draftResponse = {
    title: "Cómo configurar VPN desde casa",
    excerpt: "Pasos para conectarse a la red corporativa por VPN desde fuera de la oficina.",
    category: "HOW_TO",
    content:
      "# Cómo configurar VPN\n\nEl usuario necesita acceso remoto...\n\n## Pasos para resolver\n1. Bajar el cliente VPN\n2. Importar el perfil...",
    tags: ["vpn", "red", "configuracion"],
  };

  it("USER no puede generar borradores", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/resources/draft-from-ticket/t-1")
      .set(auth(token));
    expect(res.status).toBe(403);
  });

  it("AGENT genera draft de un ticket RESOLVED", async () => {
    const ticket = {
      id: "t-1",
      ticketNumber: 42,
      title: "No me conecta el VPN",
      description: "Cuando intento entrar tira error",
      status: "RESOLVED",
      priority: "MEDIUM",
      category: "RED",
      comments: [
        {
          message: "Probá actualizar el cliente",
          author: { role: "AGENT", name: "Agente" },
        },
        {
          message: "[TICKET RESUELTO] Listo, andaba el cliente desactualizado.",
          author: { role: "AGENT", name: "Agente" },
        },
      ],
      requester: { id: "u-1", name: "User" },
      assignee: { id: "agent-1", name: "Agente" },
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(draftResponse) }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .post("/api/resources/draft-from-ticket/t-1")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("Cómo configurar VPN desde casa");
    expect(res.body.data.category).toBe("HOW_TO");
    expect(res.body.data.tags).toEqual(["vpn", "red", "configuracion"]);
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
  });

  it("Rechaza tickets que no están resueltos ni cerrados", async () => {
    const ticket = {
      id: "t-1",
      ticketNumber: 42,
      title: "x",
      description: "y",
      status: "OPEN",
      priority: "MEDIUM",
      comments: [],
      requester: { id: "u-1", name: "User" },
      assignee: null,
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .post("/api/resources/draft-from-ticket/t-1")
      .set(auth(token));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("404 si el ticket no existe", async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce(null);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .post("/api/resources/draft-from-ticket/missing")
      .set(auth(token));

    expect(res.status).toBe(404);
  });

  it("Sanitiza tags: lowercase y max 5", async () => {
    const ticket = {
      id: "t-1",
      ticketNumber: 1,
      title: "x",
      description: "y",
      status: "RESOLVED",
      priority: "LOW",
      comments: [],
      requester: { id: "u-1", name: "User" },
      assignee: null,
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...draftResponse,
            tags: ["VPN", "Red", "Config", "  ", "tag4", "tag5", "tag6"],
          }),
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const token = signAccessToken({ id: "agent-1", role: "ADMIN" });
    const res = await request(app)
      .post("/api/resources/draft-from-ticket/t-1")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.tags).toEqual(["vpn", "red", "config", "tag4", "tag5"]);
  });

  it("Maneja errores de Anthropic con respuesta clara", async () => {
    const ticket = {
      id: "t-1",
      ticketNumber: 1,
      title: "x",
      description: "y",
      status: "CLOSED",
      priority: "LOW",
      comments: [],
      requester: { id: "u-1", name: "User" },
      assignee: null,
    };
    prismaMock.ticket.findUnique.mockResolvedValueOnce(ticket as any);
    mockMessagesCreate.mockRejectedValueOnce({ status: 429, message: "rate limit" });

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .post("/api/resources/draft-from-ticket/t-1")
      .set(auth(token));

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("AI_RATE_LIMIT");
  });
});

describe("PATCH /api/resources/:id — togglear isPinned", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ADMIN puede pinear un recurso", async () => {
    const existing = makeResource({ id: "r-1", isPinned: false });
    prismaMock.resource.findUnique.mockResolvedValueOnce(existing as any);
    prismaMock.resource.update.mockResolvedValueOnce({
      ...existing,
      isPinned: true,
    } as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .patch("/api/resources/r-1")
      .set(auth(token))
      .send({ isPinned: true });

    expect(res.status).toBe(200);
    expect(res.body.data.isPinned).toBe(true);
  });

  it("USER no puede modificar pinned", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .patch("/api/resources/r-1")
      .set(auth(token))
      .send({ isPinned: true });

    expect(res.status).toBe(403);
  });
});
