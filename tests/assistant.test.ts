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

// Anthropic mockeado con flag mutable para poder testear el 503.
const mockMessagesCreate = vi.fn();
let anthropicConfigured = true;
vi.mock("../src/lib/anthropic", () => ({
  isAnthropicConfigured: () => anthropicConfigured,
  getAnthropicClient: () => ({ messages: { create: mockMessagesCreate } }),
  ASSISTANT_MODEL: "claude-haiku-4-5-20251001",
  RESOURCE_DRAFT_MODEL: "claude-opus-4-7",
}));

// KB de Finnegans mockeada (el cliente real pega a bc.finneg.com).
const mockBuscarKb = vi.fn();
let kbConfigured = true;
vi.mock("../src/lib/finnegansKb", () => ({
  isFinnegansKbConfigured: () => kbConfigured,
  buscarKb: (...args: unknown[]) => mockBuscarKb(...args),
  __clearKbCaches: () => {},
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

const KB_FIXTURE = [
  {
    topicId: 4743,
    titulo: "Carga de una carta de porte",
    slug: "carga-carta-porte",
    url: "https://bc.finneg.com/t/carga-carta-porte/4743",
    extracto: "Pasos para cargar una CPE...",
    categoria: "Comercialización de granos",
    tags: ["cpe"],
  },
];

const CLAUDE_REPLY = {
  content: [
    {
      type: "text",
      text: "Probá estos pasos: [Carga de una carta de porte](https://bc.finneg.com/t/carga-carta-porte/4743).",
    },
  ],
  usage: { input_tokens: 500, output_tokens: 90 },
};

const chatBody = (content = "No puedo emitir una carta de porte") => ({
  messages: [{ role: "user", content }],
});

describe("POST /api/assistant/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anthropicConfigured = true;
    kbConfigured = true;
    prismaMock.user.findUnique.mockResolvedValue({
      departmentId: null,
    } as any);
    prismaMock.resource.findMany.mockResolvedValue([] as any);
  });

  it("requiere autenticación", async () => {
    const res = await request(app)
      .post("/api/assistant/chat")
      .send(chatBody());
    expect(res.status).toBe(401);
  });

  it("valida el body (último mensaje debe ser del usuario)", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/assistant/chat")
      .set(auth(token))
      .send({
        messages: [
          { role: "user", content: "hola" },
          { role: "assistant", content: "hola!" },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("503 si la IA no está configurada", async () => {
    anthropicConfigured = false;
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/assistant/chat")
      .set(auth(token))
      .send(chatBody());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ASSISTANT_NOT_CONFIGURED");
  });

  it("happy path: responde con reply + fuentes de ambas KB", async () => {
    mockBuscarKb.mockResolvedValueOnce(KB_FIXTURE);
    prismaMock.resource.findMany.mockResolvedValueOnce([
      {
        id: "r-1",
        slug: "emitir-carta-porte",
        title: "Cómo emitir una carta de porte",
        excerpt: "Guía interna",
        category: "HOW_TO",
        tags: ["cpe"],
        content: "Pasos internos...",
      },
    ] as any);
    mockMessagesCreate.mockResolvedValueOnce(CLAUDE_REPLY);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/assistant/chat")
      .set(auth(token))
      .send(chatBody());

    expect(res.status).toBe(200);
    expect(res.body.data.reply).toContain("Probá estos pasos");
    const origenes = res.body.data.fuentes.map((f: any) => f.origen);
    expect(origenes).toContain("oficial");
    expect(origenes).toContain("interno");

    // El modelo recibe el contexto inyectado en el último mensaje user.
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-haiku-4-5-20251001");
    const lastMsg = call.messages[call.messages.length - 1];
    expect(lastMsg.content).toContain("[ARTICULOS]");
    expect(lastMsg.content).toContain("[CONSULTA DEL USUARIO]");
  });

  it("si la KB oficial falla, responde igual con lo que haya", async () => {
    mockBuscarKb.mockRejectedValueOnce(new Error("kb caída"));
    mockMessagesCreate.mockResolvedValueOnce(CLAUDE_REPLY);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/assistant/chat")
      .set(auth(token))
      .send(chatBody());

    expect(res.status).toBe(200);
    expect(res.body.data.reply).toBeTruthy();
  });

  it("Anthropic 401 → 503 ASSISTANT_AUTH_ERROR (key sin créditos)", async () => {
    mockBuscarKb.mockResolvedValueOnce([]);
    mockMessagesCreate.mockRejectedValueOnce({ status: 401 });

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/assistant/chat")
      .set(auth(token))
      .send(chatBody());

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ASSISTANT_AUTH_ERROR");
  });
});

describe("GET /api/assistant/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anthropicConfigured = true;
  });

  it("devuelve configured", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/assistant/status")
      .set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(true);
  });
});
