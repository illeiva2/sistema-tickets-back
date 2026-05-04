import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { UserRole } from "@prisma/client";
import { NotificationsService } from "./notifications.service";

export class TicketSharesService {
  // Compartir un ticket con otro agente. Lo puede hacer:
  // - El assignee del ticket.
  // - ADMIN.
  static async shareTicket(
    ticketId: string,
    sharedWithId: string,
    actorId: string,
    actorRole: UserRole,
    message?: string,
  ) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        title: true,
        ticketNumber: true,
        assigneeId: true,
        requesterId: true,
      },
    });
    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    // Permisos: assignee o ADMIN.
    const isAssignee = ticket.assigneeId === actorId;
    const isAdmin = actorRole === UserRole.ADMIN;
    if (!isAssignee && !isAdmin) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo el asignado o un administrador pueden compartir este ticket",
        403,
      );
    }

    // No tiene sentido compartirse con uno mismo, o con el assignee actual,
    // o con el requester (si fuese USER).
    if (sharedWithId === actorId) {
      throw new ApiError(
        "INVALID_TARGET",
        "No podés compartirte el ticket a vos mismo",
        400,
      );
    }
    if (sharedWithId === ticket.assigneeId) {
      throw new ApiError(
        "INVALID_TARGET",
        "Ese agente ya es el asignado del ticket",
        400,
      );
    }

    const target = await prisma.user.findUnique({
      where: { id: sharedWithId },
      select: { id: true, role: true, isActive: true, name: true, email: true },
    });
    if (!target || !target.isActive) {
      throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
    }
    // Solo se comparte con staff (AGENT/ADMIN). Compartir con USER no aplica.
    if (target.role === UserRole.USER) {
      throw new ApiError(
        "INVALID_TARGET",
        "Solo se puede compartir con agentes o administradores",
        400,
      );
    }

    // Upsert: si ya existe el share, actualizamos el mensaje (re-share) en
    // vez de fallar.
    const share = await prisma.ticketShare.upsert({
      where: {
        ticketId_sharedWithId: { ticketId, sharedWithId },
      },
      update: {
        message: message?.trim() || null,
        sharedById: actorId,
      },
      create: {
        ticketId,
        sharedWithId,
        sharedById: actorId,
        message: message?.trim() || null,
      },
      include: {
        sharedWith: { select: { id: true, name: true, email: true } },
        sharedBy: { select: { id: true, name: true, email: true } },
      },
    });

    // Audit + notificacion al receptor.
    try {
      await prisma.auditLog.create({
        data: {
          entity: "ticket",
          entityId: ticketId,
          action: "ticket_shared",
          actorId,
          meta: { sharedWithId, message: message ?? null },
        },
      });
    } catch (err) {
      logger.warn({ err }, "No se pudo crear audit log de share");
    }

    NotificationsService.notifyTicketShared(
      ticketId,
      sharedWithId,
      actorId,
      message,
    ).catch((err) => {
      logger.warn({ err }, "Fallo al notificar share");
    });

    return share;
  }

  // Quitar un share. Lo puede hacer:
  // - El assignee.
  // - ADMIN.
  // - El propio destinatario (puede salirse del ticket compartido).
  static async unshareTicket(
    ticketId: string,
    sharedWithId: string,
    actorId: string,
    actorRole: UserRole,
  ) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, assigneeId: true },
    });
    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    const isAssignee = ticket.assigneeId === actorId;
    const isAdmin = actorRole === UserRole.ADMIN;
    const isSelf = sharedWithId === actorId;
    if (!isAssignee && !isAdmin && !isSelf) {
      throw new ApiError(
        "FORBIDDEN",
        "No tenés permisos para quitar este share",
        403,
      );
    }

    try {
      await prisma.ticketShare.delete({
        where: {
          ticketId_sharedWithId: { ticketId, sharedWithId },
        },
      });
    } catch {
      throw new ApiError("SHARE_NOT_FOUND", "El share no existe", 404);
    }

    try {
      await prisma.auditLog.create({
        data: {
          entity: "ticket",
          entityId: ticketId,
          action: "ticket_unshared",
          actorId,
          meta: { sharedWithId },
        },
      });
    } catch (err) {
      logger.warn({ err }, "No se pudo crear audit log de unshare");
    }
  }

  // Lista los shares activos de un ticket (para el detalle).
  static async listForTicket(ticketId: string) {
    return prisma.ticketShare.findMany({
      where: { ticketId },
      include: {
        sharedWith: { select: { id: true, name: true, email: true } },
        sharedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }
}

export default TicketSharesService;
