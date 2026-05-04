import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { UserRole } from "@prisma/client";
import { NotificationsService } from "./notifications.service";

export class CommentsService {
  static async listByTicket(ticketId: string, page = 1, pageSize = 20) {
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket)
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);

    const skip = (page - 1) * pageSize;
    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where: { ticketId },
        include: {
          author: { select: { id: true, name: true, email: true, role: true } },
        },
        orderBy: { createdAt: "asc" },
        skip,
        take: pageSize,
      }),
      prisma.comment.count({ where: { ticketId } }),
    ]);

    return {
      data: comments,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  static async create(
    ticketId: string,
    authorId: string,
    message: string,
    authorRole?: UserRole,
  ) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        assignee: { select: { id: true, name: true, email: true } },
        requester: { select: { id: true, name: true, email: true } },
      },
    });
    if (!ticket)
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);

    // Verificar visibilidad: el author necesita poder VER el ticket para
    // poder comentar. Replicamos la logica de getTicketById.
    if (authorRole === UserRole.USER) {
      if (ticket.requesterId !== authorId) {
        throw new ApiError(
          "FORBIDDEN",
          "No tenés permisos para comentar en este ticket",
          403,
        );
      }
    } else if (authorRole === UserRole.AGENT) {
      const isMine = ticket.assigneeId === authorId;
      const isUnassigned = ticket.assigneeId === null;
      if (!isMine && !isUnassigned) {
        const share = await prisma.ticketShare.findUnique({
          where: {
            ticketId_sharedWithId: {
              ticketId,
              sharedWithId: authorId,
            },
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
    // ADMIN siempre puede.

    const comment = await prisma.comment.create({
      data: { ticketId, authorId, message },
      include: {
        author: { select: { id: true, name: true, email: true, role: true } },
      },
    });

    // Si el comentario lo hace el REQUESTER (el usuario que creo el ticket),
    // invalidamos isRead global: hay info nueva del cliente que el staff
    // necesita ver en su bandeja "sin leer". Si lo hace el assignee u otro
    // staff, no tocamos isRead (ellos ya estan en el caso).
    if (authorId === ticket.requesterId && ticket.isRead) {
      try {
        await prisma.ticket.update({
          where: { id: ticketId },
          data: { isRead: false },
        });
      } catch (error) {
        console.error("No se pudo invalidar isRead tras comentario:", error);
      }
    }

    // El service decide a quien notificar (requester si no es nota interna,
    // assignee si lo hay y no es el autor). Disparamos siempre y dejamos que
    // notifyCommentAdded haga el filtro correcto.
    NotificationsService.notifyCommentAdded(
      ticketId,
      comment.id,
      authorId,
    ).catch((error) => {
      console.error("Failed to send comment notification:", error);
    });

    return comment;
  }
}

export default CommentsService;
