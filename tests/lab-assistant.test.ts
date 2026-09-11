import { vi, describe, it, beforeEach, expect } from "vitest";
import { createHash } from "node:crypto";

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

// Las herramientas se prueban aparte (lab-assistant-tools.test.ts); acá se
// prueba la máquina de estados: encolar, reclamar, ejecutar herramientas,
// las guardias contra respuestas inventadas, cerrar y vencer lo colgado.
vi.mock("../src/services/lab.assistant.tools", () => ({
  TOOLS: [
    {
      type: "function",
      function: { name: "buscar_muestras", description: "x", parameters: { type: "object", properties: {} } },
    },
  ],
  catalogoParaPrompt: vi.fn().mockResolvedValue("CATALOGO DE PRUEBA"),
  executeTool: vi.fn(),
}));

import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import { signAccessToken } from "./helpers";
import { executeTool } from "../src/services/lab.assistant.tools";
import LabAssistantService from "../src/services/lab.assistant.service";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const BASE = "/api/glutenlab/assistant";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const usuario = signAccessToken({ role: "USER", id: "u-com" });
const conModulo = () => prismaMock.moduleGrant.findFirst.mockResolvedValue({ level: "VIEWER" } as any);

const SECRET = "x".repeat(43);
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const relayHeaders = { "x-service-client": "glutenlab-ia-test", Authorization: `Bearer ${SECRET}` };
const conRelayCreds = (scopes = ["lab:llm"]) =>
  prismaMock.serviceClient.findFirst.mockResolvedValue({
    id: "sc",
    slug: "glutenlab-ia-test",
    isActive: true,
    secretHash: sha256(SECRET),
    scopes,
  } as any);
const relayOnline = () =>
  prismaMock.labAssistantRelay.findFirst.mockResolvedValue({
    slug: "glutenlab-ia-test",
    lastSeenAt: new Date(),
    model: "qwen2.5:7b",
    info: { gpu: true, version: "1.0.0" },
  } as any);

const ahora = new Date();
const PREGUNTA = "¿Qué muestras hay?";
const pedido = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  userId: "u-com",
  status: "RUNNING",
  question: PREGUNTA,
  messages: [
    { role: "system", content: "S" },
    { role: "user", content: PREGUNTA },
  ],
  answer: null,
  toolTrace: null,
  error: null,
  model: "qwen2.5:7b",
  steps: 0,
  createdAt: ahora,
  startedAt: ahora,
  finishedAt: null,
  ...over,
});

/** Una consulta que ya consultó una herramienta y tiene su resultado en la conversación. */
const pedidoConConsulta = (over: Record<string, unknown> = {}) =>
  pedido({
    steps: 1,
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: PREGUNTA },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "buscar_muestras", arguments: {} } }] },
      { role: "tool", tool_name: "buscar_muestras", content: '{"muestras":[{"accesion":"A-0001-0"},{"accesion":"A-0002-3"}]}' },
    ],
    toolTrace: [{ tool: "buscar_muestras", args: {}, ok: true, summary: "buscar_muestras: 2 muestras", ms: 50 }],
    ...over,
  });

const ultimoUpdate = () =>
  prismaMock.labAssistantRequest.update.mock.calls[prismaMock.labAssistantRequest.update.mock.calls.length - 1][0]
    .data as any;

describe("GET /assistant/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("informa disponible con el relé latiendo, y el modelo/GPU que reportó", async () => {
    conModulo();
    relayOnline();
    prismaMock.labAssistantRequest.count.mockResolvedValue(1);

    const res = await request(app).get(`${BASE}/status`).set(auth(usuario));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ available: true, model: "qwen2.5:7b", gpu: true, queued: 1 });
  });

  it("sin latido reciente figura desconectado", async () => {
    conModulo();
    prismaMock.labAssistantRelay.findFirst.mockResolvedValue({
      slug: "x",
      lastSeenAt: new Date(Date.now() - 10 * 60_000),
      model: "qwen2.5:7b",
      info: {},
    } as any);
    prismaMock.labAssistantRequest.count.mockResolvedValue(0);

    const res = await request(app).get(`${BASE}/status`).set(auth(usuario));
    expect(res.body.data.available).toBe(false);
  });
});

describe("POST /assistant/ask", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sin acceso al módulo es 403", async () => {
    prismaMock.moduleGrant.findFirst.mockResolvedValue(null);
    const res = await request(app).post(`${BASE}/ask`).set(auth(usuario)).send({ question: "hola?" });
    expect(res.status).toBe(403);
    expect(prismaMock.labAssistantRequest.create).not.toHaveBeenCalled();
  });

  it("con el relé desconectado es 503 y no encola nada", async () => {
    conModulo();
    prismaMock.labAssistantRelay.findFirst.mockResolvedValue(null);

    const res = await request(app).post(`${BASE}/ask`).set(auth(usuario)).send({ question: "¿Qué muestras hay?" });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ASSISTANT_OFFLINE");
    expect(prismaMock.labAssistantRequest.create).not.toHaveBeenCalled();
  });

  it("con una consulta propia en curso es 409", async () => {
    conModulo();
    relayOnline();
    prismaMock.labAssistantRequest.count.mockResolvedValue(1);

    const res = await request(app).post(`${BASE}/ask`).set(auth(usuario)).send({ question: "¿Y ahora?" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ASSISTANT_BUSY");
  });

  it("encola la consulta con su primer turno: system con reglas, catálogo y fecha, historial y pregunta", async () => {
    conModulo();
    relayOnline();
    prismaMock.labAssistantRequest.count.mockResolvedValue(0);
    prismaMock.labAssistantRequest.create.mockImplementation(
      async ({ data }: any) => pedido({ ...data, id: "r-nueva", status: "QUEUED", startedAt: null }) as any,
    );

    const res = await request(app)
      .post(`${BASE}/ask`)
      .set(auth(usuario))
      .send({
        question: "  ¿Cuál fue el W más alto del mes?  ",
        history: [
          { role: "user", content: "hola" },
          { role: "assistant", content: "¡Hola! ¿Qué querés saber?" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: "r-nueva", status: "QUEUED", question: "¿Cuál fue el W más alto del mes?" });
    // La respuesta al usuario no expone la conversación interna.
    expect(res.body.data.messages).toBeUndefined();

    const data = prismaMock.labAssistantRequest.create.mock.calls[0][0].data as any;
    expect(data.userId).toBe("u-com");
    const msgs = data.messages;
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("CATALOGO DE PRUEBA");
    expect(msgs[0].content).toMatch(/Hoy es \w+ \d{4}-\d{2}-\d{2}/);
    expect(msgs[0].content).toMatch(/Nunca inventes/);
    expect(msgs[0].content).toMatch(/buscar_muestras con texto=/);
    // Sin ejemplos de accesión realistas: en la prueba el modelo copió uno del prompt.
    expect(msgs[0].content).not.toMatch(/\b[MA]-\d{4}-\d\b/);
    expect(msgs.slice(1)).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "¡Hola! ¿Qué querés saber?" },
      { role: "user", content: "¿Cuál fue el W más alto del mes?" },
    ]);
    const payload = data.jobs.create.payload;
    // Sin GLUTENLAB_IA_MODEL el modelo lo decide el relé: el payload no lo fija.
    expect(payload.model).toBeUndefined();
    expect(payload).toMatchObject({ stream: false, keep_alive: "30m" });
    expect(payload.tools[0].function.name).toBe("buscar_muestras");
    expect(payload.messages).toEqual(msgs);
  });

  it("valida la pregunta (400) antes de mirar el relé", async () => {
    conModulo();
    const res = await request(app).post(`${BASE}/ask`).set(auth(usuario)).send({ question: "a" });
    expect(res.status).toBe(400);
    expect(prismaMock.labAssistantRelay.findFirst).not.toHaveBeenCalled();
  });
});

describe("GET /assistant/requests/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("devuelve la consulta propia con la traza pública (sin argumentos internos)", async () => {
    conModulo();
    prismaMock.labAssistantRequest.findFirst.mockResolvedValue(
      pedido({
        status: "DONE",
        answer: "Hay 3 muestras.",
        toolTrace: [{ tool: "buscar_muestras", args: { desde: "2026-09-01" }, ok: true, summary: "3 muestras", ms: 120 }],
      }) as any,
    );

    const res = await request(app).get(`${BASE}/requests/r1`).set(auth(usuario));

    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe("Hay 3 muestras.");
    expect(res.body.data.toolTrace).toEqual([{ tool: "buscar_muestras", summary: "3 muestras", ok: true, ms: 120 }]);
    expect(prismaMock.labAssistantRequest.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: "r1", userId: "u-com" } });
  });

  it("una consulta ajena es 404", async () => {
    conModulo();
    prismaMock.labAssistantRequest.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`${BASE}/requests/r-otro`).set(auth(usuario));
    expect(res.status).toBe(404);
  });
});

describe("relé: GET /assistant/jobs/next", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.labAssistantRelay.upsert.mockResolvedValue({} as any);
    prismaMock.labAssistantRequest.findMany.mockResolvedValue([]); // barrido: nada colgado
  });

  it("sin credencial de servicio es 401; con otro scope, 403", async () => {
    const sin = await request(app).get(`${BASE}/jobs/next`);
    expect(sin.status).toBe(401);

    conRelayCreds(["lab:ingest"]);
    const otro = await request(app).get(`${BASE}/jobs/next?wait=0`).set(relayHeaders);
    expect(otro.status).toBe(403);
    expect(prismaMock.labAssistantRelay.upsert).not.toHaveBeenCalled();
  });

  it("registra el latido y reclama el trabajo pendiente más viejo de forma atómica", async () => {
    conRelayCreds();
    prismaMock.labAssistantJob.findFirst.mockResolvedValue({
      id: "j1",
      requestId: "r1",
      payload: { messages: [] },
    } as any);
    prismaMock.labAssistantJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.labAssistantRequest.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).get(`${BASE}/jobs/next?wait=0&model=qwen2.5:7b&gpu=1&version=1.0.0`).set(relayHeaders);

    expect(res.status).toBe(200);
    expect(res.body.data.job).toMatchObject({ id: "j1", payload: { messages: [] } });

    const upsert = prismaMock.labAssistantRelay.upsert.mock.calls[0][0] as any;
    expect(upsert.where).toEqual({ slug: "glutenlab-ia-test" });
    expect(upsert.update).toMatchObject({ model: "qwen2.5:7b", info: { gpu: true, version: "1.0.0" } });

    expect(prismaMock.labAssistantJob.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "j1", status: "PENDING" },
      data: { status: "CLAIMED", claimedBy: "glutenlab-ia-test" },
    });
    expect(prismaMock.labAssistantRequest.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "r1", status: "QUEUED" },
      data: { status: "RUNNING" },
    });
  });

  it("si otro relé se lo llevó primero (updateMany 0), no lo devuelve", async () => {
    conRelayCreds();
    prismaMock.labAssistantJob.findFirst.mockResolvedValue({ id: "j1", requestId: "r1", payload: {} } as any);
    prismaMock.labAssistantJob.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).get(`${BASE}/jobs/next?wait=0`).set(relayHeaders);

    expect(res.status).toBe(200);
    expect(res.body.data.job).toBeNull();
    expect(prismaMock.labAssistantRequest.updateMany).not.toHaveBeenCalled();
  });

  it("sin trabajo devuelve null al vencer la espera", async () => {
    conRelayCreds();
    prismaMock.labAssistantJob.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`${BASE}/jobs/next?wait=0`).set(relayHeaders);
    expect(res.body.data).toEqual({ job: null });
  });
});

describe("relé: POST /assistant/jobs/:id/result", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conRelayCreds();
    prismaMock.labAssistantJob.update.mockResolvedValue({} as any);
    prismaMock.labAssistantRequest.update.mockResolvedValue({} as any);
  });

  const trabajo = (over: Record<string, unknown> = {}) => ({
    id: "j1",
    requestId: "r1",
    status: "CLAIMED",
    claimedBy: "glutenlab-ia-test",
    payload: {},
    request: pedido(),
    ...over,
  });

  const resultado = (body: unknown) => request(app).post(`${BASE}/jobs/j1/result`).set(relayHeaders).send(body);

  it("con tool_calls ejecuta cada herramienta, guarda la traza y encola el turno siguiente", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(trabajo() as any);
    (executeTool as any).mockResolvedValue({
      ok: true,
      summary: "buscar_muestras: 2 muestras (2026-09-01 a hoy, Acopio)",
      data: { muestras: [{ accesion: "A-0001-0" }, { accesion: "A-0002-3" }] },
    });

    const res = await resultado({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "buscar_muestras", arguments: { desde: "2026-09-01", laboratorio: "ACOPIO" } } }],
      },
      model: "qwen2.5:7b",
      durationMs: 1234,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requestId: "r1", status: "RUNNING" });
    expect(executeTool).toHaveBeenCalledWith("buscar_muestras", { desde: "2026-09-01", laboratorio: "ACOPIO" });

    const data = ultimoUpdate();
    expect(data.steps).toBe(1);
    expect(data.toolTrace[0]).toMatchObject({ tool: "buscar_muestras", ok: true, summary: expect.stringContaining("2 muestras") });
    const msgs = data.messages;
    expect(msgs[msgs.length - 2]).toMatchObject({ role: "assistant", tool_calls: [{ function: { name: "buscar_muestras" } }] });
    expect(msgs[msgs.length - 1]).toMatchObject({ role: "tool", tool_name: "buscar_muestras" });
    expect(JSON.parse(msgs[msgs.length - 1].content)).toEqual({ muestras: [{ accesion: "A-0001-0" }, { accesion: "A-0002-3" }] });
    expect(data.jobs.create.payload.messages).toEqual(msgs);
  });

  it("acepta los argumentos como texto JSON (así los manda a veces el modelo)", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(trabajo() as any);
    (executeTool as any).mockResolvedValue({ ok: true, summary: "ok", data: {} });

    await resultado({ message: { tool_calls: [{ function: { name: "ficha_muestra", arguments: '{"accesion":"A-0002-3"}' } }] } });

    expect(executeTool).toHaveBeenCalledWith("ficha_muestra", { accesion: "A-0002-3" });
  });

  it("tras consultar, una respuesta que cita accesiones vistas cierra la consulta tal cual", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(trabajo({ request: pedidoConConsulta() }) as any);

    const res = await resultado({
      message: { role: "assistant", content: "  Hay 2 muestras: A-0001-0 y A-0002-3.  " },
      model: "qwen2.5:7b",
    });

    expect(res.body.data).toEqual({ requestId: "r1", status: "DONE" });
    expect(executeTool).not.toHaveBeenCalled();
    const data = ultimoUpdate();
    expect(data).toMatchObject({ status: "DONE", answer: "Hay 2 muestras: A-0001-0 y A-0002-3." });
    expect(data.jobs).toBeUndefined();
    expect(data.toolTrace.filter((t: any) => t.tool === "(control)")).toEqual([]);
  });

  it("guardia: respuesta con datos SIN consultar nada → se le pide que consulte (otro turno)", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(trabajo() as any);

    const res = await resultado({
      message: { role: "assistant", content: "La muestra de Ferrari es la M-0012-4, con gluten húmedo 32,5 %." },
    });

    expect(res.body.data).toEqual({ requestId: "r1", status: "RUNNING" });
    const data = ultimoUpdate();
    expect(data.steps).toBe(1);
    expect(data.toolTrace[0]).toMatchObject({ tool: "(control)", ok: false, summary: expect.stringContaining("sin consulta") });
    const ultimo = data.messages[data.messages.length - 1];
    expect(ultimo.role).toBe("user");
    expect(ultimo.content).toMatch(/Control del sistema/);
    expect(ultimo.content).toMatch(/buscar_muestras con texto=/);
    expect(data.jobs.create).toBeTruthy();
  });

  it("guardia: si insiste sin consultar, se descarta el invento y se responde que no se pudo verificar", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(
      trabajo({
        request: pedido({
          steps: 1,
          toolTrace: [{ tool: "(control)", args: {}, ok: false, summary: "sin consulta: se le pidió que consulte", ms: 0 }],
          messages: [
            { role: "system", content: "S" },
            { role: "user", content: PREGUNTA },
            { role: "assistant", content: "La muestra de Ferrari es la M-0012-4." },
            { role: "user", content: "[Control del sistema] …" },
          ],
        }),
      }) as any,
    );

    const res = await resultado({ message: { role: "assistant", content: "La muestra de Ferrari es la M-0012-4, gluten 32,5 %." } });

    expect(res.body.data.status).toBe("DONE");
    const data = ultimoUpdate();
    expect(data.answer).toMatch(/No pude verificar/);
    expect(data.answer).not.toMatch(/M-0012-4/);
    expect(data.jobs).toBeUndefined();
  });

  it("guardia: un saludo sin datos ni consulta se acepta tal cual", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(trabajo() as any);

    const res = await resultado({ message: { role: "assistant", content: "¡Hola! ¿Sobre qué empresa o período querés saber?" } });

    expect(res.body.data.status).toBe("DONE");
    expect(ultimoUpdate().answer).toBe("¡Hola! ¿Sobre qué empresa o período querés saber?");
  });

  it("guardia: repetir la respuesta anterior en vez de responder la última pregunta → se le pide que responda", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(
      trabajo({
        request: pedidoConConsulta({
          question: "Pero quiero una lista de las de hoy",
          messages: [
            { role: "system", content: "S" },
            { role: "user", content: "Promedio de proteína de esta semana" },
            { role: "assistant", content: "El promedio de proteína es 9,5 %." },
            { role: "user", content: "Pero quiero una lista de las de hoy" },
            { role: "assistant", content: "", tool_calls: [{ function: { name: "buscar_muestras", arguments: {} } }] },
            { role: "tool", tool_name: "buscar_muestras", content: '{"muestras":[{"accesion":"A-0001-0"}]}' },
          ],
        }),
      }) as any,
    );

    const res = await resultado({ message: { role: "assistant", content: "El promedio de proteína es 9,5 %." } });

    expect(res.body.data.status).toBe("RUNNING");
    const data = ultimoUpdate();
    expect(data.toolTrace.at(-1)).toMatchObject({ tool: "(control)", summary: expect.stringContaining("repetida") });
    expect(data.messages.at(-1).content).toMatch(/Repetiste tu respuesta anterior/);
    expect(data.messages.at(-1).content).toContain("Pero quiero una lista de las de hoy");
  });

  it("guardia: una accesión citada que no salió de ninguna consulta queda marcada", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(trabajo({ request: pedidoConConsulta() }) as any);

    const res = await resultado({ message: { role: "assistant", content: "Las muestras son A-0001-0 y A-0099-9." } });

    expect(res.body.data.status).toBe("DONE");
    const data = ultimoUpdate();
    expect(data.answer).toMatch(/^Las muestras son A-0001-0 y A-0099-9\./);
    expect(data.answer).toMatch(/⚠ Las accesiones A-0099-9 no aparecen en los datos consultados/);
    expect(data.toolTrace.at(-1)).toMatchObject({ tool: "(control)", summary: expect.stringContaining("A-0099-9") });
  });

  it("pasado el tope de rondas no ejecuta más herramientas y cierra con un aviso", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(trabajo({ request: pedidoConConsulta({ steps: 5 }) }) as any);

    const res = await resultado({ message: { tool_calls: [{ function: { name: "buscar_muestras", arguments: {} } }] } });

    expect(res.body.data.status).toBe("DONE");
    expect(executeTool).not.toHaveBeenCalled();
    expect(ultimoUpdate().answer).toMatch(/demasiados pasos/);
  });

  it("un error del relé marca la consulta como fallida con el motivo", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(trabajo() as any);

    const res = await resultado({ error: "Ollama HTTP 500: out of memory" });

    expect(res.body.data).toEqual({ requestId: "r1", status: "FAILED" });
    expect(prismaMock.labAssistantRequest.update.mock.calls[0][0].data).toMatchObject({
      status: "FAILED",
      error: "El modelo no pudo responder: Ollama HTTP 500: out of memory",
    });
  });

  it("un trabajo ya resuelto es 409; uno inexistente, 404; sin message ni error, 400", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(trabajo({ status: "DONE" }) as any);
    expect((await resultado({ message: { content: "x" } })).status).toBe(409);

    prismaMock.labAssistantJob.findUnique.mockResolvedValue(null);
    expect((await request(app).post(`${BASE}/jobs/nope/result`).set(relayHeaders).send({ message: { content: "x" } })).status).toBe(404);

    expect((await resultado({})).status).toBe(400);
  });

  it("si la consulta ya venció, guarda el resultado pero no sigue la conversación", async () => {
    prismaMock.labAssistantJob.findUnique.mockResolvedValue(trabajo({ request: pedido({ status: "FAILED" }) }) as any);

    const res = await resultado({ message: { content: "tarde" } });

    expect(res.body.data.status).toBe("FAILED");
    expect(prismaMock.labAssistantRequest.update).not.toHaveBeenCalled();
  });
});

describe("LabAssistantService.sweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("vence lo colgado y explica según el relé esté o no conectado", async () => {
    prismaMock.labAssistantRequest.findMany.mockResolvedValue([{ id: "viejo" }] as any);
    prismaMock.labAssistantRelay.findFirst.mockResolvedValue(null);
    prismaMock.labAssistantJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.labAssistantRequest.updateMany.mockResolvedValue({ count: 1 });

    const r = await LabAssistantService.sweep(new Date("2026-09-11T15:00:00Z"));

    expect(r).toEqual({ failed: 1 });
    expect(prismaMock.labAssistantRequest.findMany.mock.calls[0][0]).toMatchObject({
      where: { status: { in: ["QUEUED", "RUNNING"] }, createdAt: { lt: new Date("2026-09-11T14:57:30Z") } },
    });
    expect(prismaMock.labAssistantJob.updateMany.mock.calls[0][0]).toMatchObject({
      where: { requestId: { in: ["viejo"] }, status: { in: ["PENDING", "CLAIMED"] } },
      data: { status: "FAILED" },
    });
    expect(prismaMock.labAssistantRequest.updateMany.mock.calls[0][0].data).toMatchObject({
      status: "FAILED",
      error: expect.stringContaining("servidor del molino no está conectado"),
    });
  });

  it("sin nada colgado no escribe", async () => {
    prismaMock.labAssistantRequest.findMany.mockResolvedValue([]);
    expect(await LabAssistantService.sweep()).toEqual({ failed: 0 });
    expect(prismaMock.labAssistantRequest.updateMany).not.toHaveBeenCalled();
  });
});
