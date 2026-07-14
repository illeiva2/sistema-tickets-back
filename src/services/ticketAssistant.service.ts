import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { config } from "../config";
import { UserRole } from "@prisma/client";
import {
  getAnthropicClient,
  isAnthropicConfigured,
  ASSISTANT_MODEL,
} from "../lib/anthropic";
import { buscarKb, isFinnegansKbConfigured } from "../lib/finnegansKb";
import { ResourcesService } from "./resources.service";

// Asistente conversacional para la creación de tickets.
//
// Flujo: el usuario describe su problema; el asistente busca contexto en
// dos fuentes (la documentación oficial de Finnegans en bc.finneg.com y la
// KB interna "resources") y arma una respuesta corta y accionable con
// Claude, citando los artículos. Si el contexto no alcanza, recomienda
// crear el ticket — nunca inventa funcionalidades del ERP.
//
// El servidor inyecta el contexto de búsqueda SOLO en el último mensaje
// del usuario, de forma no persistente: el cliente guarda la conversación
// "limpia" y la reenvía entera en cada turno, así el historial no acumula
// bloques de contexto viejos.

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantFuente {
  titulo: string;
  url: string;
  origen: "oficial" | "interno";
}

export interface AssistantReply {
  reply: string;
  fuentes: AssistantFuente[];
}

const MAX_CONTEXT_ARTICLES = 4; // por fuente
const MAX_QUERY_CHARS = 250;
const MAX_OUTPUT_TOKENS = 700;

const SYSTEM_PROMPT = `Sos el asistente de soporte interno de GRF, una empresa agropecuaria argentina que usa el ERP Finnegans. Un empleado está por crear un ticket de soporte y tu trabajo es ayudarlo a resolver el problema antes, si es posible.

En cada consulta vas a recibir un bloque [ARTICULOS] con resultados de dos fuentes: la documentación oficial de Finnegans (bc.finneg.com) y la base de conocimiento interna de GRF. Usá SOLO esa información para orientar al usuario.

Reglas:
- Respondé en español argentino, claro y al grano. Máximo ~150 palabras.
- Si un artículo aplica, resumí los pasos clave y citá el link en markdown: [título](url).
- No inventes funcionalidades, menúes ni pasos del ERP que no estén en los artículos.
- Si la información no alcanza para resolver el problema, decilo honestamente y recomendá crear el ticket con una buena descripción.
- Si el problema es de hardware, red, accesos/permisos o algo urgente que requiere acción del equipo de IT, recomendá directamente crear el ticket.
- Nunca pidas datos personales ni credenciales.`;

// Construye la consulta de retrieval combinando el primer mensaje del user
// (el problema original) con el último (la repregunta), acotado.
const construirConsultaRetrieval = (messages: AssistantMessage[]): string => {
  const userMsgs = messages.filter((m) => m.role === "user");
  const primero = userMsgs[0]?.content ?? "";
  const ultimo = userMsgs[userMsgs.length - 1]?.content ?? "";
  const base = primero === ultimo ? primero : `${primero} ${ultimo}`;
  return base.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
};

const urlInterna = (slug: string): string => {
  const base = config.frontendUrl?.replace(/\/+$/, "") || "";
  return `${base}/resources/${slug}`;
};

export class TicketAssistantService {
  static async chat(
    messages: AssistantMessage[],
    userId: string,
    userRole: UserRole,
  ): Promise<AssistantReply> {
    if (!isAnthropicConfigured()) {
      throw new ApiError(
        "ASSISTANT_NOT_CONFIGURED",
        "El asistente no está disponible: falta configurar la API de IA en el servidor.",
        503,
      );
    }

    const consulta = construirConsultaRetrieval(messages);
    if (!consulta) {
      throw new ApiError(
        "EMPTY_QUERY",
        "Contanos el problema para poder ayudarte.",
        400,
      );
    }

    // ── Retrieval en paralelo, tolerante a fallas por fuente ────────────────
    const deptPromise = prisma.user
      .findUnique({ where: { id: userId }, select: { departmentId: true } })
      .then((u) => u?.departmentId ?? null)
      .catch(() => null);

    const [oficiales, internas] = await Promise.all([
      isFinnegansKbConfigured()
        ? buscarKb(consulta, MAX_CONTEXT_ARTICLES).catch((err) => {
            logger.warn({ err }, "Asistente: fallo retrieval KB oficial");
            return [];
          })
        : Promise.resolve([]),
      deptPromise.then((deptId) =>
        ResourcesService.suggest(
          consulta,
          MAX_CONTEXT_ARTICLES,
          userRole,
          deptId,
        ).catch((err) => {
          logger.warn({ err }, "Asistente: fallo retrieval KB interna");
          return [];
        }),
      ),
    ]);

    const fuentes: AssistantFuente[] = [
      ...oficiales.map((o) => ({
        titulo: o.titulo,
        url: o.url,
        origen: "oficial" as const,
      })),
      ...internas.map((i) => ({
        titulo: i.title,
        url: urlInterna(i.slug),
        origen: "interno" as const,
      })),
    ];

    // ── Bloque de contexto para el modelo ───────────────────────────────────
    const lineasContexto: string[] = [];
    for (const o of oficiales) {
      lineasContexto.push(
        `- [${o.titulo}](${o.url}) (documentación oficial Finnegans${o.categoria ? `, ${o.categoria}` : ""}): ${o.extracto || "(sin extracto)"}`,
      );
    }
    for (const i of internas) {
      lineasContexto.push(
        `- [${i.title}](${urlInterna(i.slug)}) (KB interna GRF): ${i.excerpt || "(sin resumen)"}`,
      );
    }
    const bloqueContexto =
      lineasContexto.length > 0
        ? lineasContexto.join("\n")
        : "(No se encontraron artículos relacionados en ninguna fuente.)";

    // ── Armar la conversación: contexto solo en el último mensaje user ─────
    const ultimoUserIdx = messages
      .map((m, idx) => ({ m, idx }))
      .filter((x) => x.m.role === "user")
      .map((x) => x.idx)
      .pop();

    const llmMessages = messages.map((m, idx) =>
      idx === ultimoUserIdx
        ? {
            role: m.role,
            content: `[ARTICULOS]\n${bloqueContexto}\n\n[CONSULTA DEL USUARIO]\n${m.content}`,
          }
        : { role: m.role, content: m.content },
    );

    try {
      const client = getAnthropicClient();
      const response = await client.messages.create({
        model: ASSISTANT_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            // System estable → cacheable entre llamadas.
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: llmMessages,
      });

      logger.info(
        { userId, turnos: messages.length, usage: response.usage },
        "Respuesta del asistente de tickets",
      );

      const textBlock = response.content.find((b) => b.type === "text") as
        | { type: "text"; text: string }
        | undefined;

      return {
        reply: textBlock?.text?.trim() || "No pude generar una respuesta.",
        fuentes,
      };
    } catch (err: any) {
      if (err instanceof ApiError) throw err;
      const status = err?.status ?? err?.statusCode;
      if (status === 401 || status === 403) {
        logger.error({ err }, "Asistente: credenciales de Anthropic rechazadas");
        throw new ApiError(
          "ASSISTANT_AUTH_ERROR",
          "El asistente no está disponible: la API de IA rechazó las credenciales (verificá la API key y los créditos).",
          503,
        );
      }
      if (status === 429) {
        throw new ApiError(
          "ASSISTANT_RATE_LIMITED",
          "El asistente está recibiendo muchas consultas. Probá de nuevo en unos segundos.",
          429,
        );
      }
      logger.error({ err }, "Asistente: error llamando a Anthropic");
      throw new ApiError(
        "ASSISTANT_ERROR",
        "El asistente no pudo responder. Podés crear el ticket normalmente.",
        502,
      );
    }
  }
}

export default TicketAssistantService;
