import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { UserRole } from "@prisma/client";
import {
  getAnthropicClient,
  isAnthropicConfigured,
  RESOURCE_DRAFT_MODEL,
} from "../lib/anthropic";

// System prompt estable — se cachea con cache_control: ephemeral. Conviene
// que no cambie entre llamadas para aprovechar el prompt cache de Anthropic
// (~0.1x el costo en lecturas cacheadas).
const SYSTEM_PROMPT = `Sos un editor de base de conocimiento técnico de una empresa argentina. Tu trabajo es transformar la resolución de un ticket de soporte en un artículo reutilizable.

Reglas:
- Usás español rioplatense (voseo cuando corresponda; tono profesional pero cercano).
- Lenguaje GENÉRICO: nunca incluyas nombres propios reales de usuarios, agentes o clientes. Reemplazá por roles ("el usuario", "el solicitante", "soporte"). Tampoco incluyas datos sensibles (contraseñas, tokens, correos personales, números de empleado, IPs internas, rutas privadas).
- El artículo debe servir para QUE OTRO USUARIO con el mismo problema lo resuelva sin abrir un ticket.
- Si la información del ticket es ambigua o incompleta, ESCRIBÍ lo que se puede deducir y dejá al editor humano completar el resto (no inventes datos técnicos).

Estructura del contenido (markdown):
1. Breve descripción del problema (1-2 párrafos).
2. Sección "## Pasos para resolver" con lista numerada de pasos accionables.
3. (Opcional) Sección "## Advertencias" si hay riesgos.
4. (Opcional) Sección "## Si no funciona" con próximos pasos (por ejemplo, abrir un ticket nuevo).

Categorías disponibles y cuándo usar cada una:
- HOW_TO: tutorial paso a paso (caso más común para tickets resueltos).
- POLICY: política o norma interna.
- FAQ: pregunta frecuente con respuesta corta.
- ANNOUNCEMENT: aviso o noticia.
- GLOSSARY: definición de término.
- LINK: link externo útil.
- OTHER: cuando ninguna de las anteriores aplica.

Devolvé únicamente el JSON estructurado que te pide el schema. Sin prosa adicional.`;

// Schema del output. output_config.format con json_schema garantiza que
// la respuesta parsea como este shape exacto.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description:
        "Título descriptivo del artículo (3-15 palabras). Empieza con verbo de acción cuando es un HOW_TO (ej: 'Configurar VPN desde casa').",
    },
    excerpt: {
      type: "string",
      description:
        "Resumen muy corto (1-2 oraciones, máximo 200 caracteres). Se muestra en el listado de recursos.",
    },
    category: {
      type: "string",
      enum: [
        "HOW_TO",
        "POLICY",
        "FAQ",
        "ANNOUNCEMENT",
        "GLOSSARY",
        "LINK",
        "OTHER",
      ],
    },
    content: {
      type: "string",
      description: "Contenido completo del artículo en markdown.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description:
        "Hasta 5 tags cortos en minúscula sin espacios (usá guiones), descriptivos del tema. Ej: ['vpn', 'red', 'configuracion'].",
    },
  },
  required: ["title", "excerpt", "category", "content", "tags"],
  additionalProperties: false,
} as const;

export interface ResourceDraft {
  title: string;
  excerpt: string;
  category:
    | "HOW_TO"
    | "POLICY"
    | "FAQ"
    | "ANNOUNCEMENT"
    | "GLOSSARY"
    | "LINK"
    | "OTHER";
  content: string;
  tags: string[];
}

export class ResourceDraftsService {
  static async draftFromTicket(
    ticketId: string,
    userId: string,
    userRole: UserRole,
  ): Promise<ResourceDraft> {
    if (userRole !== UserRole.AGENT && userRole !== UserRole.ADMIN) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo agentes y administradores pueden generar borradores",
        403,
      );
    }

    if (!isAnthropicConfigured()) {
      throw new ApiError(
        "AI_NOT_CONFIGURED",
        "La generación de borradores con IA no está disponible. Falta configurar ANTHROPIC_API_KEY en el servidor.",
        503,
      );
    }

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        comments: {
          orderBy: { createdAt: "asc" },
          include: {
            author: { select: { id: true, name: true, role: true } },
          },
        },
        requester: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
      },
    });

    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    // Solo permitimos generar borradores de tickets que ya están cerrados
    // o resueltos. Otros estados no tienen "resolución" todavía.
    if (ticket.status !== "RESOLVED" && ticket.status !== "CLOSED") {
      throw new ApiError(
        "INVALID_STATUS",
        "Solo se pueden generar borradores desde tickets resueltos o cerrados",
        400,
      );
    }

    // Armar el contexto del ticket en formato legible. Anonimizamos nombres
    // antes de mandar al LLM, reemplazándolos por roles.
    const ticketContext = buildTicketContext(ticket);

    logger.info(
      { ticketId, userId, contextLength: ticketContext.length },
      "Generando draft de recurso desde ticket",
    );

    try {
      const client = getAnthropicClient();
      const response = await client.messages.create({
        model: RESOURCE_DRAFT_MODEL,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            // Cache del system prompt: como es estable, todas las llamadas
            // posteriores van a leerlo de cache (~10% del costo).
            cache_control: { type: "ephemeral" },
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: OUTPUT_SCHEMA,
          },
        },
        messages: [
          {
            role: "user",
            content: ticketContext,
          },
        ],
      });

      // Loggear usage para tener visibilidad de costos.
      logger.info(
        {
          ticketId,
          usage: response.usage,
        },
        "Draft generado",
      );

      // Con output_config el primer bloque text contiene JSON válido según
      // el schema. Parseamos y devolvemos.
      const textBlock = response.content.find((b) => b.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      if (!textBlock) {
        throw new Error("Respuesta sin contenido de texto");
      }

      let parsed: ResourceDraft;
      try {
        parsed = JSON.parse(textBlock.text);
      } catch (err) {
        logger.error(
          { err, raw: textBlock.text.slice(0, 500) },
          "Failed to parse AI response as JSON",
        );
        throw new Error("La IA devolvió una respuesta no parseable");
      }

      // Sanitizar tags: lowercase, max 5, sin vacíos.
      parsed.tags = (parsed.tags || [])
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 5);

      // Truncar excerpt si vino largo.
      if (parsed.excerpt && parsed.excerpt.length > 500) {
        parsed.excerpt = parsed.excerpt.slice(0, 497) + "...";
      }

      return parsed;
    } catch (err: any) {
      // Errores tipados del SDK (rate limit, auth, etc.)
      if (err?.status === 401) {
        throw new ApiError(
          "AI_AUTH_ERROR",
          "Error de autenticación con Anthropic. La API key es inválida.",
          503,
        );
      }
      if (err?.status === 429) {
        throw new ApiError(
          "AI_RATE_LIMIT",
          "Demasiadas solicitudes al servicio de IA. Probá de nuevo en unos minutos.",
          429,
        );
      }
      if (err instanceof ApiError) throw err;
      logger.error({ err }, "Error generando draft con Anthropic");
      throw new ApiError(
        "AI_GENERATION_FAILED",
        "No se pudo generar el borrador. Probá de nuevo o creá el recurso a mano.",
        502,
      );
    }
  }
}

// Construye el texto que se le manda al modelo. Reemplaza nombres por roles
// para evitar fugas de info personal en el LLM y en el output.
function buildTicketContext(ticket: any): string {
  const num = String(ticket.ticketNumber).padStart(5, "0");
  const parts: string[] = [];

  parts.push(
    `# Ticket #${num} (estado: ${ticket.status === "RESOLVED" ? "Resuelto" : "Cerrado"})`,
  );
  parts.push("");
  parts.push(`## Título original`);
  parts.push(ticket.title);
  parts.push("");
  parts.push(`## Categoría`);
  parts.push(ticket.category || "(sin categoría)");
  parts.push("");
  parts.push(`## Prioridad`);
  parts.push(ticket.priority);
  parts.push("");
  parts.push(`## Descripción del problema (palabras del solicitante)`);
  parts.push(ticket.description);
  parts.push("");

  if (Array.isArray(ticket.comments) && ticket.comments.length > 0) {
    parts.push(`## Historial de la conversación`);
    parts.push(
      "(El nombre del autor se reemplaza por su rol para anonimizar.)",
    );
    parts.push("");

    for (const c of ticket.comments) {
      const role = c.author?.role || "USER";
      // Limpiar prefijos especiales para que la IA vea el contenido como texto.
      let message: string = c.message;
      let kind = "comentario";
      if (message.startsWith("[INTERNA] ")) {
        message = message.slice("[INTERNA] ".length);
        kind = "nota interna del staff";
      } else if (message.startsWith("[TICKET CERRADO] ")) {
        message = message.slice("[TICKET CERRADO] ".length);
        kind = "comentario de cierre";
      } else if (message.startsWith("[TICKET RESUELTO] ")) {
        message = message.slice("[TICKET RESUELTO] ".length);
        kind = "comentario de resolución";
      } else if (message.startsWith("[TICKET REABIERTO] ")) {
        message = message.slice("[TICKET REABIERTO] ".length);
        kind = "comentario de reapertura";
      }

      const roleLabel =
        role === "USER"
          ? "Solicitante"
          : role === "AGENT"
            ? "Técnico"
            : "Administrador";
      parts.push(`### [${roleLabel}] (${kind})`);
      parts.push(message);
      parts.push("");
    }
  }

  parts.push(`## Tu tarea`);
  parts.push(
    "Generá un artículo reutilizable de base de conocimiento basado en este caso. Devolvé el JSON con title, excerpt, category, content (markdown) y tags.",
  );

  return parts.join("\n");
}

export default ResourceDraftsService;
