import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
  buscarKb,
  isFinnegansKbConfigured,
  type KbModo,
  type KbResultado,
} from "../lib/finnegansKb";

// Sugerencias de la Base de Conocimiento OFICIAL de Finnegans (bc.finneg.com)
// para asistir al agente que gestiona un ticket. Complementa la KB interna
// ("resources"): esto trae documentacion oficial del ERP.
//
// Privacidad: solo mandamos titulo + descripcion + categoria del ticket al
// servicio de busqueda (que es LOCAL, no un LLM). No enviamos comentarios,
// nombres ni datos de contacto para minimizar exposicion de datos personales.

export interface KbSugerencia {
  id: number | string;
  titulo: string;
  categoria: string;
  tags: string[];
  url: string;
  extracto: string;
  score: number;
}

// Recorta el texto de la consulta: suficiente para dar contexto de busqueda,
// sin mandar descripciones enormes que ensucian el ranking.
const MAX_QUERY_CHARS = 500;

function construirConsulta(ticket: {
  title: string;
  description: string | null;
  category: string | null;
}): string {
  const partes = [ticket.title, ticket.category ?? "", ticket.description ?? ""]
    .map((p) => (p || "").trim())
    .filter(Boolean);
  return partes.join(". ").slice(0, MAX_QUERY_CHARS);
}

function mapear(r: KbResultado): KbSugerencia {
  return {
    id: r.id,
    titulo: r.titulo,
    categoria: r.categoria,
    tags: r.tags,
    url: r.url,
    extracto: r.extracto,
    score: r.score,
  };
}

export class KbSuggestionsService {
  // Sugerencias a partir de un ticket existente. Construye la consulta con el
  // titulo/descripcion/categoria del ticket y devuelve los top-N articulos.
  static async forTicket(
    ticketId: string,
    limit = 5,
    modo: KbModo = "hibrido",
  ): Promise<{ consulta: string; sugerencias: KbSugerencia[] }> {
    if (!isFinnegansKbConfigured()) {
      throw new ApiError(
        "KB_NOT_CONFIGURED",
        "Las sugerencias de la Base de Conocimiento no estan disponibles. Falta configurar FINNEGANS_KB_URL en el servidor.",
        503,
      );
    }

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, title: true, description: true, category: true },
    });
    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    const consulta = construirConsulta(ticket);
    if (!consulta) {
      return { consulta: "", sugerencias: [] };
    }

    const res = await buscarKb(consulta, { limite: limit, modo });
    logger.info(
      { ticketId, total: res.total, modo: res.modo_usado },
      "Sugerencias de KB para ticket",
    );
    return { consulta, sugerencias: res.resultados.map(mapear) };
  }

  // Busqueda libre en la KB (caja "Buscar en la KB"). No toca la base de datos.
  static async buscarLibre(
    q: string,
    limit = 5,
    modo: KbModo = "hibrido",
  ): Promise<{ consulta: string; sugerencias: KbSugerencia[] }> {
    if (!isFinnegansKbConfigured()) {
      throw new ApiError(
        "KB_NOT_CONFIGURED",
        "La Base de Conocimiento no esta disponible. Falta configurar FINNEGANS_KB_URL en el servidor.",
        503,
      );
    }
    const consulta = (q || "").trim();
    if (!consulta) {
      return { consulta: "", sugerencias: [] };
    }
    const res = await buscarKb(consulta, { limite: limit, modo });
    return { consulta, sugerencias: res.resultados.map(mapear) };
  }
}

export default KbSuggestionsService;
