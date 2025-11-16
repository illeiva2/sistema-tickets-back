import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { UserRole } from "@prisma/client";
import { TicketFilters } from "../validations/tickets";
import { NotificationsService } from "./notifications.service";
import FilePreviewService from "./filePreview.service";
import path from "path";

type StatusLiteral = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

export class TicketsService {
  static async getTickets(
    filters: TicketFilters,
    userId: string,
    userRole: UserRole,
  ) {
    const {
      q,
      status,
      priority,
      requesterId,
      assigneeId,
      dateFrom,
      dateTo,
      page = 1,
      pageSize = 20,
      sortBy = "createdAt",
      sortDir = "desc",
    } = filters;

    const where: any = {};

    // Apply filters based on user role
    if (userRole === UserRole.USER) {
      where.requesterId = userId;
    }

    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }

    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (requesterId) where.requesterId = requesterId;
    if (assigneeId) where.assigneeId = assigneeId;

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    const skip = (page - 1) * pageSize;
    const orderBy = { [sortBy]: sortDir };

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        include: {
          requester: {
            select: { id: true, name: true, email: true },
          },
          assignee: {
            select: { id: true, name: true, email: true },
          },
        },
        orderBy,
        skip,
        take: pageSize,
      }),
      prisma.ticket.count({ where }),
    ]);

    return {
      data: tickets,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  static async getTicketById(id: string, userId: string, userRole: UserRole) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: {
        requester: {
          select: { id: true, name: true, email: true },
        },
        assignee: {
          select: { id: true, name: true, email: true },
        },
        comments: {
          include: {
            author: {
              select: { id: true, name: true, email: true },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        attachments: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    // Check permissions
    if (userRole === UserRole.USER && ticket.requesterId !== userId) {
      throw new ApiError(
        "FORBIDDEN",
        "No tienes permisos para ver este ticket",
        403,
      );
    }

    // Enriquecer attachments con información de vista previa
    if (ticket.attachments && ticket.attachments.length > 0) {
      const enrichedAttachments = await Promise.all(
        ticket.attachments.map(async (attachment: any) => {
          try {
            const filePath = path.join(process.cwd(), attachment.storageUrl);
            const previewInfo = await FilePreviewService.getFilePreviewInfo(
              filePath,
              attachment.mimeType,
              attachment.fileName,
            );

            const displayInfo = FilePreviewService.getFileDisplayInfo(
              attachment.fileName,
              attachment.mimeType,
              attachment.sizeBytes,
            );

            return {
              ...attachment,
              previewInfo,
              displayInfo,
            };
          } catch (error) {
            console.error(
              `Error enriching attachment ${attachment.id}:`,
              error,
            );
            // Fallback a información básica
            return {
              ...attachment,
              previewInfo: {
                type: "other",
                canPreview: false,
                icon: "📎",
              },
              displayInfo: FilePreviewService.getFileDisplayInfo(
                attachment.fileName,
                attachment.mimeType,
                attachment.sizeBytes,
              ),
            };
          }
        }),
      );

      ticket.attachments = enrichedAttachments;
    }

    return ticket;
  }

  static async createTicket(data: any, userId: string) {
    const ticket = await prisma.ticket.create({
      data: {
        title: data.title,
        description: data.description,
        priority: data.priority,
        requesterId: userId,
      },
      include: {
        requester: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        entity: "ticket",
        entityId: ticket.id,
        action: "ticket_created",
        actorId: userId,
      },
    });

    logger.info(`Ticket created: ${ticket.id} by user: ${userId}`);
    return ticket;
  }

  static async updateTicket(
    id: string,
    data: any,
    userId: string,
    userRole: UserRole,
  ) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { requester: true },
    });

    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    // Check permissions
    if (userRole === UserRole.USER) {
      if (ticket.requesterId !== userId) {
        throw new ApiError(
          "FORBIDDEN",
          "No tienes permisos para editar este ticket",
          403,
        );
      }
      // Users can only update title and description
      const rest = { ...data } as Record<string, unknown>;
      delete rest.title;
      delete rest.description;
      if (Object.keys(rest).length > 0) {
        throw new ApiError(
          "FORBIDDEN",
          "No tienes permisos para modificar estos campos",
          403,
        );
      }
    }

    // Only ADMIN can assign tickets
    if (
      Object.prototype.hasOwnProperty.call(data, "assigneeId") &&
      userRole !== UserRole.ADMIN
    ) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo los administradores pueden asignar tickets",
        403,
      );
    }

    // Validate status transitions (agents/admin can set any status)
    if (data.status && data.status !== ticket.status) {
      if (userRole === UserRole.USER) {
        const validTransitions = this.getValidStatusTransitions(
          ticket.status,
          userRole,
        );
        if (!validTransitions.includes(data.status)) {
          throw new ApiError(
            "INVALID_STATUS",
            "Transición de estado no válida",
            400,
          );
        }
      }

      // Set closedAt when status is CLOSED
      if (data.status === "CLOSED") {
        data.closedAt = new Date();
      } else if (ticket.status === "CLOSED" && data.status !== "CLOSED") {
        data.closedAt = null;
      }
    }

    const updatedTicket = await prisma.ticket.update({
      where: { id },
      data,
      include: {
        requester: {
          select: { id: true, name: true, email: true },
        },
        assignee: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    // Audit logs for notable updates
    const logs: Array<Promise<any>> = [];
    if (data.status) {
      const action =
        data.status === "RESOLVED" ? "ticket_resolved" : "ticket_updated";
      logs.push(
        prisma.auditLog.create({
          data: { entity: "ticket", entityId: id, action, actorId: userId },
        }),
      );
    }
    if (Object.prototype.hasOwnProperty.call(data, "assigneeId")) {
      logs.push(
        prisma.auditLog.create({
          data: {
            entity: "ticket",
            entityId: id,
            action: "ticket_assigned_updated",
            actorId: userId,
          },
        }),
      );
    }
    if (Object.prototype.hasOwnProperty.call(data, "priority")) {
      logs.push(
        prisma.auditLog.create({
          data: {
            entity: "ticket",
            entityId: id,
            action: "ticket_priority_updated",
            actorId: userId,
          },
        }),
      );
    }
    if (logs.length > 0) {
      await Promise.all(logs);
    }

    // Send notifications for important changes
    const notificationPromises: Array<Promise<void>> = [];

    // Notify when ticket is assigned to someone
    if (
      Object.prototype.hasOwnProperty.call(data, "assigneeId") &&
      data.assigneeId &&
      data.assigneeId !== ticket.assigneeId
    ) {
      const assignee = await prisma.user.findUnique({
        where: { id: data.assigneeId },
        select: { name: true, email: true },
      });

      if (assignee) {
        notificationPromises.push(
          NotificationsService.notifyTicketAssigned(id, data.assigneeId),
        );
      }
    }

    // Notify when status changes
    if (data.status && data.status !== ticket.status) {
      notificationPromises.push(
        NotificationsService.notifyStatusChanged(
          id,
          ticket.status,
          data.status,
          userId,
        ),
      );
    }

    // Notify when priority changes
    if (data.priority && data.priority !== ticket.priority) {
      notificationPromises.push(
        NotificationsService.notifyPriorityChanged(
          id,
          ticket.priority,
          data.priority,
          userId,
        ),
      );
    }

    // Send notifications asynchronously (don't block the response)
    if (notificationPromises.length > 0) {
      Promise.allSettled(notificationPromises).then((results) => {
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          logger.warn(
            `Failed to send ${failed} notifications for ticket ${id}`,
          );
        }
      });
    }

    logger.info(`Ticket updated: ${id} by user: ${userId}`);
    return updatedTicket;
  }

  static async closeTicket(
    id: string,
    userId: string,
    userRole: UserRole,
    comment: string,
  ) {
    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    // Only ticket requester can close their own tickets
    if (userRole === UserRole.USER && ticket.requesterId !== userId) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo puedes cerrar tus propios tickets",
        403,
      );
    }

    // Validate comment is provided
    if (!comment || comment.trim().length === 0) {
      throw new ApiError(
        "MISSING_COMMENT",
        "Debes proporcionar un comentario para cerrar el ticket",
        400,
      );
    }

    // Create the closing comment
    await prisma.comment.create({
      data: {
        ticketId: id,
        authorId: userId,
        message: `[TICKET CERRADO] ${comment}`,
      },
    });

    // Update ticket status to CLOSED
    const updatedTicket = await prisma.ticket.update({
      where: { id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
      },
      include: {
        requester: {
          select: { id: true, name: true, email: true },
        },
        assignee: {
          select: { id: true, name: true, email: true },
        },
        comments: {
          include: {
            author: {
              select: { id: true, name: true, email: true },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    // Send notification about ticket closure
    await NotificationsService.notifyStatusChanged(
      id,
      ticket.status,
      "CLOSED",
      userId,
    );

    logger.info(`Ticket closed: ${id} by user: ${userId}`);
    return updatedTicket;
  }

  static async reopenTicket(
    id: string,
    userId: string,
    userRole: UserRole,
    comment: string,
  ) {
    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    // Only AGENTS and ADMIN can reopen tickets
    if (userRole === UserRole.USER) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo los agentes y administradores pueden reabrir tickets",
        403,
      );
    }

    // Validate comment is provided
    if (!comment || comment.trim().length === 0) {
      throw new ApiError(
        "MISSING_COMMENT",
        "Debes proporcionar un comentario para reabrir el ticket",
        400,
      );
    }

    // Create the reopening comment
    await prisma.comment.create({
      data: {
        ticketId: id,
        authorId: userId,
        message: `[TICKET REABIERTO] ${comment}`,
      },
    });

    // Update ticket status to OPEN
    const updatedTicket = await prisma.ticket.update({
      where: { id },
      data: {
        status: "OPEN",
        closedAt: null,
      },
      include: {
        requester: {
          select: { id: true, name: true, email: true },
        },
        assignee: {
          select: { id: true, name: true, email: true },
        },
        comments: {
          include: {
            author: {
              select: { id: true, name: true, email: true },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    // Send notification about ticket reopening
    await NotificationsService.notifyStatusChanged(
      id,
      ticket.status,
      "OPEN",
      userId,
    );

    logger.info(`Ticket reopened: ${id} by user: ${userId}`);
    return updatedTicket;
  }

  static async deleteTicket(id: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo los administradores pueden eliminar tickets",
        403,
      );
    }

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    await prisma.ticket.delete({ where: { id } });
    logger.info(`Ticket deleted: ${id}`);
  }

  private static getValidStatusTransitions(
    currentStatus: StatusLiteral,
    userRole: UserRole,
  ): StatusLiteral[] {
    const transitions: Record<StatusLiteral, StatusLiteral[]> = {
      OPEN: ["IN_PROGRESS"],
      IN_PROGRESS: ["RESOLVED"],
      RESOLVED: ["CLOSED", "OPEN"],
      CLOSED: ["OPEN"],
    };

    const validTransitions = transitions[currentStatus] || [];

    // Only AGENT and ADMIN can reopen tickets
    if (currentStatus === "CLOSED" && userRole === UserRole.USER) {
      return validTransitions.filter((status) => status !== "OPEN");
    }

    return validTransitions;
  }
}
