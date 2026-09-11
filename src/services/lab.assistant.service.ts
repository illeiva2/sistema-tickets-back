import { EventEmitter } from "node:events";
import type { LabAssistantRequest, Prisma } from "@prisma/client";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { fechaPlantaHoy } from "./lab.report.service";
import { TOOLS, catalogoParaPrompt, executeTool } from "./lab.assistant.tools";

/**
 * Asistente de laboratorio: preguntas en lenguaje natural sobre las muestras
 * y sus análisis, respondidas por un modelo que corre EN EL MOLINO (Ollama en
 * srv-mf-03), no en la nube.
 *
 * Cómo se reparte el trabajo:
 * - El backend (acá) arma la conversación, decide qué herramientas existen,
 *   las ejecuta con los permisos del usuario y guarda todo para auditar.
 * - El relé del molino solo acerca el modelo: pide un turno (long-poll), se lo
 *   pasa a Ollama y devuelve la respuesta. No abre puertos ni ve credenciales
 *   de usuarios.
 *
 * Por eso una consulta es una máquina de estados y no una llamada: cada turno
 * del modelo es un LabAssistantJob; cuando el relé trae el resultado, este
 * service ejecuta las herramientas pedidas y encola el turno siguiente, hasta
 * que el modelo responde sin pedir nada más. El navegador pregunta por el
 * estado cada tanto.
 *
 * Un modelo chico (7-8B) inventa cuando no encuentra: en la primera prueba
 * respondió con una ficha entera fabricada, sin consultar nada. Por eso hay
 * GUARDIAS estructurales, independientes del prompt y del modelo: una
 * respuesta con datos tiene que salir de una herramienta llamada en esta
 * misma consulta, una accesión citada tiene que haber aparecido en algún
 * resultado, y repetir la respuesta anterior no cuenta como responder.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface RelayInfo {
  model?: string;
  version?: string;
  gpu?: boolean;
}

export interface TraceEntry {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  ms: number;
}

/** Lo que trae el relé después de un turno del modelo. */
export interface JobResultBody {
  message?: { role?: string; content?: string | null; tool_calls?: ToolCall[] };
  error?: string;
  model?: string;
  durationMs?: number;
  doneReason?: string;
}

export interface AssistantRequestDto {
  id: string;
  status: string;
  question: string;
  answer: string | null;
  toolTrace: { tool: string; summary: string; ok: boolean; ms: number }[];
  error: string | null;
  model: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/**
 * Modelo a pedir. Sin variable, lo decide el relé (que sabe qué tiene
 * descargado): así cambiar de modelo es tocar el env del servidor del molino,
 * no redesplegar el backend.
 */
const MODEL = process.env.GLUTENLAB_IA_MODEL?.trim() || null;
/** Rondas (herramientas o controles) por consulta. Un 7B que no cierra en cinco no va a cerrar en diez. */
const MAX_STEPS = 5;
const MAX_HISTORY = 12;
/** Un resultado de herramienta más largo que esto se recorta: el contexto del modelo es finito (8k). */
const MAX_TOOL_JSON = 14_000;
/** Una consulta que no cerró en este tiempo se da por perdida y se le avisa al usuario. */
const REQUEST_TIMEOUT_MS = 150_000;
/** Sin latido del relé en esta ventana, el asistente figura desconectado. */
const RELAY_ONLINE_MS = 90_000;
/** Cada cuánto, como mucho, vuelve a mirar la base un long-poll que espera trabajo. */
const POLL_STEP_MS = 5_000;
const OPTIONS = { temperature: 0.2, num_ctx: 8192 };

/** Nombre de las entradas de traza que no son herramientas sino guardias del sistema. */
const CONTROL = "(control)";
const ACCESION_RE = /\b[MA]-\d{4}-\d\b/g;

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/**
 * Despierta a los long-polls cuando entra un trabajo, así el relé arranca al
 * instante en vez de esperar el próximo ciclo. Es en memoria: con más de una
 * instancia del backend el otro proceso lo ve igual en su próxima mirada a la
 * base (POLL_STEP_MS), solo un poco más tarde.
 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

const esperarTrabajo = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(listo, ms);
    function listo() {
      clearTimeout(timer);
      bus.off("job", listo);
      resolve();
    }
    bus.once("job", listo);
  });

const json = (v: unknown) => v as unknown as Prisma.InputJsonValue;

export class LabAssistantService {
  // ─── Usuarios ──────────────────────────────────────────────────────────────

  static async status() {
    const [relay, queued] = await Promise.all([
      prisma.labAssistantRelay.findFirst({ orderBy: { lastSeenAt: "desc" } }),
      prisma.labAssistantRequest.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
    ]);
    const info = (relay?.info ?? {}) as { gpu?: boolean; version?: string };
    return {
      available: !!relay && Date.now() - relay.lastSeenAt.getTime() < RELAY_ONLINE_MS,
      model: relay?.model ?? null,
      gpu: info.gpu ?? null,
      relayVersion: info.version ?? null,
      relayLastSeenAt: relay?.lastSeenAt ?? null,
      queued,
    };
  }

  static async ask(userId: string, question: string, history: HistoryTurn[]): Promise<AssistantRequestDto> {
    const q = question.trim();
    if (q.length < 2) throw new ApiError("VALIDATION_ERROR", "Escribí una pregunta", 400);

    if (!(await this.relayOnline())) {
      throw new ApiError(
        "ASSISTANT_OFFLINE",
        "El asistente no está disponible ahora: el servidor del molino no está conectado.",
        503,
      );
    }
    // Una a la vez por usuario: el modelo del molino atiende de a uno, y dos
    // preguntas en paralelo del mismo usuario se pisarían en pantalla.
    const enCurso = await prisma.labAssistantRequest.count({
      where: { userId, status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (enCurso > 0) {
      throw new ApiError("ASSISTANT_BUSY", "Todavía estoy respondiendo tu consulta anterior; esperá un momento.", 409);
    }

    const catalogo = await catalogoParaPrompt();
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt(catalogo) },
      ...history.slice(-MAX_HISTORY).map((h) => ({ role: h.role, content: h.content.slice(0, 4000) })),
      { role: "user", content: q },
    ];

    const creada = await prisma.labAssistantRequest.create({
      data: {
        userId,
        status: "QUEUED",
        question: q,
        messages: json(messages),
        model: MODEL,
        jobs: { create: { payload: json(this.payload(messages)) } },
      },
    });
    bus.emit("job");
    return this.toDto(creada);
  }

  /** Solo las propias: la consulta lleva la pregunta y la respuesta de alguien. */
  static async get(userId: string, id: string): Promise<AssistantRequestDto | null> {
    const r = await prisma.labAssistantRequest.findFirst({ where: { id, userId } });
    return r ? this.toDto(r) : null;
  }

  // ─── Relé ──────────────────────────────────────────────────────────────────

  /**
   * Long-poll del relé: registra su presencia y devuelve el trabajo pendiente
   * más viejo, o `null` si en `waitMs` no entró ninguno. Reclamar es atómico
   * (updateMany condicionado): si hubiera dos relés, uno solo se lo lleva.
   */
  static async nextJob(slug: string, waitMs: number, info: RelayInfo) {
    const ahora = new Date();
    await prisma.labAssistantRelay.upsert({
      where: { slug },
      create: { slug, lastSeenAt: ahora, model: info.model ?? null, info: json(info) },
      update: { lastSeenAt: ahora, model: info.model ?? null, info: json(info) },
    });
    // El relé pasa por acá cada ~25 s: es el lugar natural para vencer lo colgado.
    void this.sweep(ahora).catch((err) => logger.error({ err }, "Falló el barrido del asistente"));

    const limite = Date.now() + Math.max(0, waitMs);
    for (;;) {
      const job = await this.claim(slug);
      if (job) return { job };
      const restante = limite - Date.now();
      if (restante <= 0) return { job: null };
      await esperarTrabajo(Math.min(POLL_STEP_MS, restante));
    }
  }

  private static async claim(slug: string) {
    const candidato = await prisma.labAssistantJob.findFirst({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: { id: true, requestId: true, payload: true },
    });
    if (!candidato) return null;
    const r = await prisma.labAssistantJob.updateMany({
      where: { id: candidato.id, status: "PENDING" },
      data: { status: "CLAIMED", claimedAt: new Date(), claimedBy: slug },
    });
    if (r.count !== 1) return null; // otro relé lo reclamó un instante antes
    await prisma.labAssistantRequest.updateMany({
      where: { id: candidato.requestId, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    return { id: candidato.id, payload: candidato.payload };
  }

  /** El relé trae el turno del modelo: se ejecutan las herramientas pedidas o se cierra la respuesta. */
  static async jobResult(slug: string, jobId: string, body: JobResultBody) {
    const job = await prisma.labAssistantJob.findUnique({ where: { id: jobId }, include: { request: true } });
    if (!job) throw new ApiError("NOT_FOUND", "No existe ese trabajo", 404);
    if (job.status !== "CLAIMED") throw new ApiError("CONFLICT", "Ese trabajo ya fue resuelto", 409);
    if (job.claimedBy && job.claimedBy !== slug) {
      throw new ApiError("FORBIDDEN", "Ese trabajo lo reclamó otro relé", 403);
    }

    const ahora = new Date();
    if (body.error || !body.message) {
      const motivo = body.error?.trim() || "respuesta vacía";
      await prisma.labAssistantJob.update({
        where: { id: jobId },
        data: { status: "FAILED", error: motivo, finishedAt: ahora },
      });
      await prisma.labAssistantRequest.update({
        where: { id: job.requestId },
        data: { status: "FAILED", error: `El modelo no pudo responder: ${motivo}`, finishedAt: ahora },
      });
      return { requestId: job.requestId, status: "FAILED" };
    }

    await prisma.labAssistantJob.update({
      where: { id: jobId },
      data: { status: "DONE", result: json(body), finishedAt: ahora },
    });
    // Llegó tarde: el barrido ya le dijo al usuario que se acabó la espera. No se sigue.
    if (job.request.status === "FAILED") return { requestId: job.requestId, status: "FAILED" };

    return this.advance(job.request, body.message, body.model);
  }

  private static async advance(
    request: LabAssistantRequest,
    message: NonNullable<JobResultBody["message"]>,
    model: string | undefined,
  ) {
    const previos = (request.messages as unknown as ChatMessage[]) ?? [];
    const toolCalls = message.tool_calls ?? [];
    const asistente: ChatMessage = {
      role: "assistant",
      content: message.content ?? "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    const messages = [...previos, asistente];
    const trace = ((request.toolTrace as unknown as TraceEntry[] | null) ?? []).slice();
    const puedeSeguir = request.steps < MAX_STEPS;

    /** Encola otro turno con más contexto (resultados de herramientas o una corrección). */
    const otroTurno = async () => {
      await prisma.labAssistantRequest.update({
        where: { id: request.id },
        data: {
          messages: json(messages),
          toolTrace: json(trace),
          steps: request.steps + 1,
          model: model ?? request.model,
          jobs: { create: { payload: json(this.payload(messages)) } },
        },
      });
      bus.emit("job");
      return { requestId: request.id, status: "RUNNING" };
    };

    if (toolCalls.length > 0 && puedeSeguir) {
      for (const call of toolCalls) {
        const name = call.function?.name ?? "";
        const args = this.parseArgs(call.function?.arguments);
        const t0 = Date.now();
        const result = await executeTool(name, args);
        trace.push({ tool: name, args, ok: result.ok, summary: result.summary, ms: Date.now() - t0 });
        messages.push({ role: "tool", tool_name: name, content: this.serializar(result.data) });
      }
      return otroTurno();
    }

    let answer = (message.content ?? "").trim();
    const consultoAlgo = trace.some((t) => t.tool !== CONTROL && t.ok);
    const yaControlado = (tipo: string) => trace.some((t) => t.tool === CONTROL && t.summary.startsWith(tipo));
    const controlar = (summary: string) => trace.push({ tool: CONTROL, args: {}, ok: false, summary, ms: 0 });
    const conDatos = /\d/.test(answer);

    // Guardia 1: respondió con datos sin haber consultado nada. Una vez se le
    // pide que consulte; si insiste, mejor un "no sé" honesto que un número inventado.
    if (!consultoAlgo && toolCalls.length === 0 && conDatos) {
      if (puedeSeguir && !yaControlado("sin consulta")) {
        controlar("sin consulta: el modelo respondió con datos sin consultar ninguna herramienta; se le pidió que consulte");
        messages.push({
          role: "user",
          content:
            "[Control del sistema] Respondiste con datos sin consultar ninguna herramienta; eso no está permitido. Llamá a la herramienta que corresponda —buscar_muestras con texto=<empresa, persona, patente o lote> para encontrar muestras; resumen_analisis para promedios y extremos; ficha_muestra solo con una accesión que ya conozcas— y respondé únicamente con lo que devuelva.",
        });
        return otroTurno();
      }
      controlar("sin consulta: se descartó una respuesta con datos que no salieron de ninguna herramienta");
      answer =
        "No pude verificar esa información en los datos del laboratorio. Probá indicando la empresa, la accesión (la que figura en la etiqueta) o el período que te interesa.";
    }

    // Guardia 2: repitió la respuesta anterior en vez de responder la última pregunta.
    const anterior = this.respuestaAnterior(previos, request.question);
    if (anterior && this.normalizar(anterior) === this.normalizar(answer) && puedeSeguir && !yaControlado("repetida")) {
      controlar("repetida: el modelo repitió la respuesta anterior; se le pidió que responda la última pregunta");
      messages.push({
        role: "user",
        content: `[Control del sistema] Repetiste tu respuesta anterior. Respondé la ÚLTIMA pregunta del usuario: «${request.question}». Si necesitás datos, llamá a una herramienta.`,
      });
      return otroTurno();
    }

    // Guardia 3: toda accesión citada tiene que haber aparecido en algún resultado.
    const vistas = new Set(
      messages.filter((m) => m.role === "tool").flatMap((m) => m.content.match(ACCESION_RE) ?? []),
    );
    const citadas = [...new Set(answer.match(ACCESION_RE) ?? [])];
    const inventadas = citadas.filter((a) => !vistas.has(a));
    if (inventadas.length > 0) {
      controlar(
        `verificación: ${inventadas.length} accesión${inventadas.length === 1 ? "" : "es"} citada${inventadas.length === 1 ? "" : "s"} no surgi${inventadas.length === 1 ? "ó" : "eron"} de las consultas (${inventadas.join(", ")})`,
      );
      answer =
        inventadas.length === citadas.length && !consultoAlgo
          ? `No encontré datos que respalden esa respuesta: menciona muestras (${inventadas.join(", ")}) que no surgieron de ninguna consulta. Reformulá indicando la empresa, la accesión o el período.`
          : `${answer}\n\n⚠ Las accesiones ${inventadas.join(", ")} no aparecen en los datos consultados: verificalas en la ficha antes de usarlas.`;
    }

    if (!answer) {
      answer =
        toolCalls.length > 0
          ? "No pude terminar la consulta: necesité demasiados pasos. Probá con una pregunta más acotada (un período, un laboratorio o una empresa)."
          : "No pude armar una respuesta con los datos disponibles.";
    }
    await prisma.labAssistantRequest.update({
      where: { id: request.id },
      data: {
        status: "DONE",
        answer,
        messages: json(messages),
        toolTrace: json(trace),
        model: model ?? request.model,
        finishedAt: new Date(),
      },
    });
    return { requestId: request.id, status: "DONE" };
  }

  /**
   * Vence las consultas colgadas. Si el relé está caído nadie reclama los
   * trabajos y, sin esto, el usuario miraría "pensando…" para siempre.
   */
  static async sweep(now = new Date()) {
    const limite = new Date(now.getTime() - REQUEST_TIMEOUT_MS);
    const colgadas = await prisma.labAssistantRequest.findMany({
      where: { status: { in: ["QUEUED", "RUNNING"] }, createdAt: { lt: limite } },
      select: { id: true },
    });
    if (colgadas.length === 0) return { failed: 0 };

    const ids = colgadas.map((c) => c.id);
    const relayOn = await this.relayOnline(now);
    await prisma.labAssistantJob.updateMany({
      where: { requestId: { in: ids }, status: { in: ["PENDING", "CLAIMED"] } },
      data: { status: "FAILED", error: "tiempo de espera agotado", finishedAt: now },
    });
    await prisma.labAssistantRequest.updateMany({
      where: { id: { in: ids } },
      data: {
        status: "FAILED",
        finishedAt: now,
        error: relayOn
          ? "El asistente tardó demasiado en responder. Probá con una pregunta más acotada."
          : "El asistente no respondió: el servidor del molino no está conectado.",
      },
    });
    logger.warn({ ids, relayOn }, "Consultas del asistente de laboratorio vencidas");
    return { failed: ids.length };
  }

  // ─── Internos ──────────────────────────────────────────────────────────────

  private static async relayOnline(now = new Date()): Promise<boolean> {
    const relay = await prisma.labAssistantRelay.findFirst({ orderBy: { lastSeenAt: "desc" } });
    return !!relay && now.getTime() - relay.lastSeenAt.getTime() < RELAY_ONLINE_MS;
  }

  /** El cuerpo que el relé le manda a Ollama tal cual. Sin `model`, el relé pone el suyo. */
  private static payload(messages: ChatMessage[]) {
    return {
      ...(MODEL ? { model: MODEL } : {}),
      messages,
      tools: TOOLS,
      stream: false,
      options: OPTIONS,
      keep_alive: "30m",
    };
  }

  private static parseArgs(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw === "string") {
      try {
        const v = JSON.parse(raw);
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  private static serializar(data: unknown): string {
    const s = JSON.stringify(data ?? null);
    return s.length > MAX_TOOL_JSON ? `${s.slice(0, MAX_TOOL_JSON)}…(recortado: pedí menos filas o un período más corto)` : s;
  }

  /**
   * La respuesta que el asistente dio a la pregunta ANTERIOR del usuario: el
   * último mensaje de assistant (con texto, sin herramientas) que está antes
   * de la pregunta de esta consulta. Los turnos de control posteriores no cuentan.
   */
  private static respuestaAnterior(previos: ChatMessage[], question: string): string | null {
    let corte = previos.length;
    for (let i = previos.length - 1; i >= 0; i--) {
      if (previos[i].role === "user" && previos[i].content === question) {
        corte = i;
        break;
      }
    }
    for (let i = corte - 1; i >= 0; i--) {
      const m = previos[i];
      if (m.role === "assistant" && !m.tool_calls?.length && m.content.trim()) return m.content;
    }
    return null;
  }

  private static normalizar(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  private static systemPrompt(catalogo: string): string {
    const hoy = fechaPlantaHoy();
    const dia = DIAS[new Date(`${hoy}T12:00:00-03:00`).getUTCDay()];
    return `Sos el asistente del laboratorio de calidad de GRF (Grupo Roberto Forzani), un molino harinero con acopio de granos en Argentina. Respondés preguntas sobre las MUESTRAS registradas y sus ANÁLISIS, y la ÚNICA fuente de datos son las herramientas.

REGLAS (en este orden de importancia):
1. Nunca inventes, estimes ni completes datos. Todo número, fecha, nombre o accesión que digas tiene que haber salido de una herramienta llamada en ESTA respuesta. Si no consultaste, no hay respuesta con datos.
2. Si el usuario nombra una empresa, una persona, una patente, una procedencia o un lote, usá buscar_muestras con texto=<ese nombre>. NUNCA adivines una accesión ni llames a ficha_muestra con una que no te dieron o que no salió de una búsqueda.
3. Respondé la ÚLTIMA pregunta del usuario. Las anteriores son solo contexto; no repitas una respuesta anterior.
4. Si el usuario dice que te equivocaste o que quería otra cosa, volvé a consultar (por lo general con buscar_muestras y otro texto o período); no reformules lo mismo.
5. Si una herramienta no devuelve datos, decilo tal cual ("no hay muestras de X en ese período") y sugerí qué cambiar. No rellenes.
6. Citá las accesiones de las muestras en las que basás cada afirmación, tal como aparecen en los resultados.
7. Si la pregunta no dice período ni laboratorio, asumí los últimos 7 días y AMBOS laboratorios, y aclaralo. "Hoy" son ambos laboratorios salvo que digan lo contrario.
8. Respondé en español argentino, breve y concreto: viñetas o una tabla corta si ayuda. Usá los valores tal como los devuelven las herramientas (con sus unidades). Un valor marcado "dudoso" está fuera de calibración: mencionalo si lo usás.
9. No des opiniones comerciales ni de precios: solo datos del laboratorio.

CONTEXTO:
- Cada muestra tiene una accesión con formato letra-cuatro dígitos-dígito verificador (A-####-# en Acopio, M-####-# en Molino), fecha y hora de toma, un tipo, una ficha con datos y los análisis de hasta cinco equipos: NIR, Gluten (Glutomatic), Falling Number, Almidón dañado (SDmatic) y Alveógrafo (AlveoLab).
- ACOPIO recibe camiones de trigo: su ficha tiene empresa, procedencia, patente, acoplado, CTG, carta de porte, chofer y silo, y se marcan alteraciones del grano. MOLINO analiza muestras internas de proceso: turno, producto y lote.
- Hoy es ${dia} ${hoy} (fecha de planta, Argentina). Las fechas para las herramientas van en formato YYYY-MM-DD.

${catalogo}`;
  }

  private static toDto(r: LabAssistantRequest): AssistantRequestDto {
    const trace = ((r.toolTrace as unknown as TraceEntry[] | null) ?? []).map((t) => ({
      tool: t.tool,
      summary: t.summary,
      ok: t.ok,
      ms: t.ms,
    }));
    return {
      id: r.id,
      status: r.status,
      question: r.question,
      answer: r.answer,
      toolTrace: trace,
      error: r.error,
      model: r.model,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    };
  }
}

export default LabAssistantService;
