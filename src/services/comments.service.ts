import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
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

  static async create(ticketId: string, authorId: string, message: string) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        assignee: { select: { id: true, name: true, email: true } },
        requester: { select: { id: true, name: true, email: true } },
      },
    });
    if (!ticket)
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);

    const comment = await prisma.comment.create({
      data: { ticketId, authorId, message },
      include: {
        author: { select: { id: true, name: true, email: true, role: true } },
      },
    });

    // Send notification to assignee if ticket is assigned and comment is not from assignee
    if (ticket.assignee && ticket.assignee.id !== authorId) {
      // Send notification asynchronously (don't block the response)
      NotificationsService.notifyCommentAdded(
        ticketId,
        comment.id,
        authorId,
      ).catch((error) => {
        console.error("Failed to send comment notification:", error);
      });
    }

    return comment;
  }
}

export default CommentsService;
