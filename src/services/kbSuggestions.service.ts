import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { UserRole } from "@prisma/client";
import {
  buscarKb,
  isFinnegansKbConfigured,
  type KbSugerencia,
} from "../lib/finnegansKb";

// Sugerencias de la Base de Conocimiento OFICIAL de Finnegans (bc.finneg.com)
// — documentacion viva del ERP — para complementar la KB interna (resources).
//
// Privacidad: la consulta que se manda a bc.finneg.com se construye SOLO con
// el titulo del ticket (nunca descripcion, comentarios ni datos de personas).
// El titulo es la señal mas limpia para la busqueda por keywords de Discourse
// y minimiza la exposicion de datos internos a un servicio externo.

export type { KbSugerencia };

const MAX_QUERY_CHARS = 120;

const construirConsulta = (titulo: string): string =>
  (titulo || "").trim().slice(0, MAX_QUERY_CHARS);

const assertKbDisponible = () => {
  if (!isFinnegansKbConfigured()) {
    throw new ApiError(
      "KB_NOT_CONFIGURED",
      "La Base de Conocimiento de Finnegans esta deshabilitada en el servidor.",
      503,
    );
  }
};

export class KbSuggestionsService {
  // Sugerencias para un ticket existente. Solo staff; ademas un AGENT solo
  // puede pedirlas sobre tickets que puede ver (asignado a el, sin asignar,
  // o compartido con el) — misma regla de visibilidad que el resto del
  // modulo de tickets.
  static async forTicket(
    ticketId: string,
    userId: string,
    userRole: UserRole,
    limit = 5,
  ): Promise<{ consulta: string; sugerencias: KbSugerencia[] }> {
    assertKbDisponible();

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, title: true, assigneeId: true },
    });
    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    if (userRole === UserRole.AGENT) {
      const esMio = ticket.assigneeId === userId;
      const sinAsignar = ticket.assigneeId === null;
      if (!esMio && !sinAsignar) {
        const share = await prisma.ticketShare.findUnique({
          where: {
            ticketId_sharedWithId: { ticketId, sharedWithId: userId },
          },
          select: { id: true },
        });
        if (!share) {
          throw new ApiError(
            "FORBIDDEN",
            "Este ticket está asignado a otro técnico",
            403,
          );
        }
      }
    }

    const consulta = construirConsulta(ticket.title);
    if (!consulta) {
      return { consulta: "", sugerencias: [] };
    }

    const sugerencias = await buscarKb(consulta, limit);
    logger.info(
      { ticketId, total: sugerencias.length },
      "Sugerencias de KB oficial para ticket",
    );
    return { consulta, sugerencias };
  }

  // Busqueda libre en la KB oficial (cualquier usuario autenticado; el
  // corpus de bc.finneg.com es publico). No toca la base de datos.
  static async buscarLibre(
    q: string,
    limit = 5,
  ): Promise<{ consulta: string; sugerencias: KbSugerencia[] }> {
    assertKbDisponible();
    const consulta = construirConsulta(q);
    if (!consulta) {
      return { consulta: "", sugerencias: [] };
    }
    const sugerencias = await buscarKb(consulta, limit);
    return { consulta, sugerencias };
  }
}

export default KbSuggestionsService;
