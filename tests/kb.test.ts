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
import { signAccessToken } from "./helpers";
import { __clearKbCaches } from "../src/lib/finnegansKb";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// ─── Fixtures de la API de Discourse ─────────────────────────────────────────

const SEARCH_FIXTURE = {
  posts: [
    { topic_id: 4743, blurb: "Cómo cargar una carta de porte..." },
    // Segundo post del MISMO topic: debe deduplicarse.
    { topic_id: 4743, blurb: "Otra respuesta del mismo tema" },
    { topic_id: 900, blurb: "Emisión de CPE automotor" },
    // Post sin topic correspondiente: debe saltearse.
    { topic_id: 99999, blurb: "Huérfano" },
  ],
  topics: [
    {
      id: 4743,
      title: "Traslado venta de granos - Carga de una carta de porte",
      slug: "traslado-venta-de-granos",
      category_id: 45,
      tags: [{ name: "instructivo" }, { name: "carta-de-porte" }],
    },
    {
      id: 900,
      title: "CPE automotor",
      slug: "cpe-automotor",
      category_id: 45,
      // Variante: tags como strings.
      tags: ["cpe"],
    },
  ],
};

const CATEGORIES_FIXTURE = {
  category_list: {
    categories: [
      { id: 45, name: "Comercialización de granos" },
      { id: 1, name: "Compras" },
    ],
  },
};

// Mock del fetch global: responde según el path.
const mockFetchOk = () => {
  const fn = vi.fn(async (url: any) => {
    const u = String(url);
    const body = u.includes("/categories.json")
      ? CATEGORIES_FIXTURE
      : SEARCH_FIXTURE;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};

describe("GET /api/kb/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    __clearKbCaches();
  });

  it("devuelve configured=true por default", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app).get("/api/kb/status").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(true);
  });

  it("requiere autenticación", async () => {
    const res = await request(app).get("/api/kb/status");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/kb/buscar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    __clearKbCaches();
  });

  it("mapea resultados de Discourse (dedupe por topic, tags mixtos, categoría)", async () => {
    mockFetchOk();
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/kb/buscar?q=carta%20de%20porte&limit=5")
      .set(auth(token));

    expect(res.status).toBe(200);
    const { consulta, sugerencias } = res.body.data;
    expect(consulta).toBe("carta de porte");
    // 4743 (una vez, deduplicado) + 900. El huérfano 99999 se saltea.
    expect(sugerencias).toHaveLength(2);
    expect(sugerencias[0]).toMatchObject({
      topicId: 4743,
      titulo: "Traslado venta de granos - Carga de una carta de porte",
      url: "https://bc.finneg.com/t/traslado-venta-de-granos/4743",
      categoria: "Comercialización de granos",
      tags: ["instructivo", "carta-de-porte"],
    });
    expect(sugerencias[1].tags).toEqual(["cpe"]);
  });

  it("query vacía devuelve lista vacía sin llamar a Discourse", async () => {
    const fetchMock = mockFetchOk();
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/kb/buscar?q=%20%20")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.sugerencias).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("upstream 500 → 502 KB_UPSTREAM_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "boom",
      })),
    );
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/kb/buscar?q=algo")
      .set(auth(token));

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("KB_UPSTREAM_ERROR");
  });

  it("timeout (AbortError) → 504 KB_TIMEOUT", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("aborted");
        (err as any).name = "AbortError";
        throw err;
      }),
    );
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/kb/buscar?q=algo")
      .set(auth(token));

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe("KB_TIMEOUT");
  });
});

describe("GET /api/kb/tickets/:ticketId/suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    __clearKbCaches();
  });

  it("USER no tiene acceso (403)", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/kb/tickets/t-1/suggestions")
      .set(auth(token));
    expect(res.status).toBe(403);
  });

  it("404 si el ticket no existe", async () => {
    mockFetchOk();
    prismaMock.ticket.findUnique.mockResolvedValueOnce(null);
    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .get("/api/kb/tickets/missing/suggestions")
      .set(auth(token));
    expect(res.status).toBe(404);
  });

  it("AGENT no puede sobre ticket asignado a otro (sin share)", async () => {
    mockFetchOk();
    prismaMock.ticket.findUnique.mockResolvedValueOnce({
      id: "t-1",
      title: "Error al emitir CPE",
      assigneeId: "otro-agente",
    } as any);
    prismaMock.ticketShare.findUnique.mockResolvedValueOnce(null);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .get("/api/kb/tickets/t-1/suggestions")
      .set(auth(token));

    expect(res.status).toBe(403);
  });

  it("AGENT assignee obtiene sugerencias con consulta = título del ticket", async () => {
    mockFetchOk();
    prismaMock.ticket.findUnique.mockResolvedValueOnce({
      id: "t-1",
      title: "Error al cargar carta de porte",
      assigneeId: "agent-1",
    } as any);

    const token = signAccessToken({ id: "agent-1", role: "AGENT" });
    const res = await request(app)
      .get("/api/kb/tickets/t-1/suggestions")
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.consulta).toBe("Error al cargar carta de porte");
    expect(res.body.data.sugerencias.length).toBeGreaterThan(0);
  });

  it("ADMIN puede sobre cualquier ticket", async () => {
    mockFetchOk();
    prismaMock.ticket.findUnique.mockResolvedValueOnce({
      id: "t-1",
      title: "Conciliación bancaria no cierra",
      assigneeId: "otro-agente",
    } as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .get("/api/kb/tickets/t-1/suggestions")
      .set(auth(token));

    expect(res.status).toBe(200);
  });
});
