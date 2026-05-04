import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { calculateDueAt } from "../lib/sla";
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
      category,
      requesterId,
      assigneeId,
      dateFrom,
      dateTo,
      page = 1,
      pageSize = 20,
      sortBy = "createdAt",
      sortDir = "desc",
      filter,
    } = filters;

    const where: any = {};
    // Construimos la lista de condiciones AND para no pisar `where.OR`
    // entre visibilidad y busqueda.
    const andConditions: any[] = [];

    // Reglas de visibilidad por rol:
    // - USER: solo sus tickets (donde es requester).
    // - AGENT: tickets asignados a el + tickets sin asignar. (Los compartidos
    //   se suman en PR-B via TicketShare.)
    // - ADMIN: todos.
    if (userRole === UserRole.USER) {
      andConditions.push({ requesterId: userId });
    } else if (userRole === UserRole.AGENT) {
      andConditions.push({
        OR: [{ assigneeId: userId }, { assigneeId: null }],
      });
    }

    if (q) {
      andConditions.push({
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      });
    }

    if (status) (where as any).status = status;
    if (priority) (where as any).priority = priority;
    if (category) (where as any).category = category;
    if (requesterId) (where as any).requesterId = requesterId;

    if (assigneeId) {
      if (assigneeId === "null") {
        (where as any).assigneeId = null;
      } else {
        (where as any).assigneeId = assigneeId;
      }
    }

    if (dateFrom || dateTo) {
      (where as any).createdAt = {};
      if (dateFrom) (where as any).createdAt.gte = new Date(dateFrom);
      if (dateTo) (where as any).createdAt.lte = new Date(dateTo);
    }

    // Triage filters: solo para AGENT/ADMIN. Limitan a tickets activos.
    // `unread` usa el isRead GLOBAL del ticket (no per-user).
    const isStaff = userRole === UserRole.AGENT || userRole === UserRole.ADMIN;
    if (filter && isStaff) {
      const activeStatus = { in: ["OPEN" as const, "IN_PROGRESS" as const] };
      if (filter === "unassigned") {
        (where as any).assigneeId = null;
        (where as any).status = activeStatus;
      } else if (filter === "unread") {
        (where as any).isRead = false;
        (where as any).status = activeStatus;
      } else if (filter === "fresh") {
        (where as any).assigneeId = null;
        (where as any).isRead = false;
        (where as any).status = activeStatus;
      } else if (filter === "mine") {
        (where as any).assigneeId = userId;
        (where as any).status = activeStatus;
      }
    }

    if (andConditions.length > 0) {
      (where as any).AND = andConditions;
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
          _count: {
            select: { comments: true },
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

  // Contadores para el panel de triage en el dashboard de AGENT/ADMIN.
  // Respeta la visibilidad del rol: AGENT solo cuenta sobre lo que ve
  // (sus tickets + sin asignar); ADMIN cuenta todo el sistema.
  static async getTriageCounts(userId: string, userRole: UserRole) {
    if (userRole !== UserRole.AGENT && userRole !== UserRole.ADMIN) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo agentes y administradores pueden ver el triage",
        403,
      );
    }

    const activeStatus = { in: ["OPEN" as const, "IN_PROGRESS" as const] };
    // Visibilidad per-rol como condicion adicional (AND) en cada count.
    const visibilityFor = (extra: any): any => {
      if (userRole === UserRole.AGENT) {
        return {
          AND: [
            { OR: [{ assigneeId: userId }, { assigneeId: null }] },
            extra,
          ],
        };
      }
      return extra;
    };

    const [fresh, unassigned, unread, mine] = await Promise.all([
      prisma.ticket.count({
        where: visibilityFor({
          status: activeStatus,
          assigneeId: null,
          isRead: false,
        }),
      }),
      prisma.ticket.count({
        where: visibilityFor({ status: activeStatus, assigneeId: null }),
      }),
      prisma.ticket.count({
        where: visibilityFor({ status: activeStatus, isRead: false }),
      }),
      prisma.ticket.count({
        where: { status: activeStatus, assigneeId: userId },
      }),
    ]);

    return { fresh, unassigned, unread, mine };
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
        // Lista de quienes vieron el ticket (staff). Solo se usa cuando
        // el viewer es staff; para USER se descarta antes de devolver.
        reads: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
          orderBy: { lastReadAt: "desc" },
        },
      },
    });

    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    // Visibilidad:
    // - USER: solo si es requester.
    // - AGENT: solo si es assignee, sin asignar, o (en PR-B) compartido.
    // - ADMIN: todos.
    if (userRole === UserRole.USER) {
      if (ticket.requesterId !== userId) {
        throw new ApiError(
          "FORBIDDEN",
          "No tienes permisos para ver este ticket",
          403,
        );
      }
    } else if (userRole === UserRole.AGENT) {
      const isMine = ticket.assigneeId === userId;
      const isUnassigned = ticket.assigneeId === null;
      if (!isMine && !isUnassigned) {
        throw new ApiError(
          "FORBIDDEN",
          "Este ticket está asignado a otro técnico",
          403,
        );
      }
    }

    // Marcar globalmente como leido y registrar quien fue.
    if (userRole === UserRole.AGENT || userRole === UserRole.ADMIN) {
      const now = new Date();

      try {
        await prisma.ticketRead.upsert({
          where: { userId_ticketId: { userId, ticketId: id } },
          update: { lastReadAt: now },
          create: { userId, ticketId: id, lastReadAt: now },
        });
      } catch (err) {
        logger.warn({ err }, "No se pudo registrar TicketRead");
      }

      // isRead global: si nadie del staff lo habia visto antes, marcamos true.
      if (!ticket.isRead) {
        try {
          await prisma.ticket.update({
            where: { id },
            data: { isRead: true },
          });
        } catch (err) {
          logger.warn({ err }, "No se pudo marcar isRead");
        }
        ticket.isRead = true;
      }

      // Auto-transicion OPEN -> IN_PROGRESS cuando el ASSIGNEE abre el
      // ticket. La idea: si el assignee ya lo esta mirando, hay trabajo
      // empezado; refleja eso en el estado.
      if (
        ticket.status === "OPEN" &&
        ticket.assigneeId === userId
      ) {
        try {
          await prisma.ticket.update({
            where: { id },
            data: { status: "IN_PROGRESS" },
          });
          await prisma.auditLog.create({
            data: {
              entity: "ticket",
              entityId: id,
              action: "ticket_auto_progressed",
              actorId: userId,
            },
          });
          ticket.status = "IN_PROGRESS";
        } catch (err) {
          logger.warn(
            { err },
            "No se pudo auto-progresar OPEN -> IN_PROGRESS",
          );
        }
      }
    }

    // Para USER no devolvemos la lista de viewers (son staff).
    if (userRole === UserRole.USER) {
      (ticket as any).reads = undefined;
    } else {
      // Renombramos `reads` a `viewers` para que el front no se confunda
      // con el TicketRead per-user (que ya no se usa para isRead).
      (ticket as any).viewers = ((ticket as any).reads ?? []).map(
        (r: any) => ({
          user: r.user,
          lastReadAt: r.lastReadAt,
        }),
      );
      (ticket as any).reads = undefined;
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

  static async getTicketAudit(id: string, userId: string, userRole: UserRole) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      select: { id: true, requesterId: true },
    });
    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }
    if (userRole === UserRole.USER && ticket.requesterId !== userId) {
      throw new ApiError(
        "FORBIDDEN",
        "No tienes permisos para ver el historial de este ticket",
        403,
      );
    }

    const logs = await prisma.auditLog.findMany({
      where: { entity: "ticket", entityId: id },
      include: {
        actor: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return logs;
  }

  static async createTicket(data: any, userId: string) {
    const now = new Date();
    const ticket = await prisma.ticket.create({
      data: {
        title: data.title,
        description: data.description,
        priority: data.priority,
        category: data.category ?? null,
        requesterId: userId,
        dueAt: calculateDueAt(data.priority, now),
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
      // USER puede editar title, description y category de su ticket.
      // El cambio de category solo se permite mientras el ticket este
      // activo (OPEN o IN_PROGRESS): no queremos reclasificar tickets
      // ya resueltos/cerrados.
      const rest = { ...data } as Record<string, unknown>;
      delete rest.title;
      delete rest.description;
      delete rest.category;
      if (Object.keys(rest).length > 0) {
        throw new ApiError(
          "FORBIDDEN",
          "No tienes permisos para modificar estos campos",
          403,
        );
      }
      if (
        Object.prototype.hasOwnProperty.call(data, "category") &&
        ticket.status !== "OPEN" &&
        ticket.status !== "IN_PROGRESS"
      ) {
        throw new ApiError(
          "INVALID_STATUS",
          "No se puede cambiar la categoría de un ticket resuelto o cerrado",
          400,
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

    // Si cambia la prioridad, recalcular dueAt sobre el createdAt original.
    if (data.priority && data.priority !== ticket.priority) {
      data.dueAt = calculateDueAt(data.priority, ticket.createdAt);
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

    // Si el ticket tiene asignado, vuelve a IN_PROGRESS (preserva contexto).
    // Si no, queda en OPEN para que alguien lo tome.
    const newStatus: StatusLiteral = ticket.assigneeId ? "IN_PROGRESS" : "OPEN";

    const updatedTicket = await prisma.ticket.update({
      where: { id },
      data: {
        status: newStatus,
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

    await NotificationsService.notifyStatusChanged(
      id,
      ticket.status,
      newStatus,
      userId,
    );

    logger.info(`Ticket reopened: ${id} by user: ${userId} (-> ${newStatus})`);
    return updatedTicket;
  }

  static async resolveTicket(
    id: string,
    userId: string,
    userRole: UserRole,
    comment?: string,
  ) {
    if (userRole === UserRole.USER) {
      throw new ApiError(
        "FORBIDDEN",
        "Solo los agentes y administradores pueden resolver tickets",
        403,
      );
    }

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    if (ticket.status === "RESOLVED" || ticket.status === "CLOSED") {
      throw new ApiError(
        "INVALID_STATUS",
        "El ticket ya está resuelto o cerrado",
        400,
      );
    }

    if (comment && comment.trim().length > 0) {
      await prisma.comment.create({
        data: {
          ticketId: id,
          authorId: userId,
          message: `[TICKET RESUELTO] ${comment.trim()}`,
        },
      });
    }

    const updatedTicket = await prisma.ticket.update({
      where: { id },
      data: { status: "RESOLVED" },
      include: {
        requester: { select: { id: true, name: true, email: true } },
        assignee: { select: { id: true, name: true, email: true } },
        comments: {
          include: {
            author: { select: { id: true, name: true, email: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        entity: "ticket",
        entityId: id,
        action: "ticket_resolved",
        actorId: userId,
      },
    });

    await NotificationsService.notifyStatusChanged(
      id,
      ticket.status,
      "RESOLVED",
      userId,
    );

    logger.info(`Ticket resolved: ${id} by user: ${userId}`);
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

  static async claimTicket(id: string, userId: string) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { requester: true },
    });

    if (!ticket) {
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);
    }

    if (ticket.assigneeId) {
      throw new ApiError(
        "TICKET_ALREADY_ASSIGNED",
        "Este ticket ya está asignado a otro técnico",
        400,
      );
    }

    // Actualizar ticket
    const updatedTicket = await prisma.ticket.update({
      where: { id },
      data: {
        assigneeId: userId,
        status: ticket.status === "OPEN" ? "IN_PROGRESS" : ticket.status,
      },
      include: {
        requester: {
          select: { id: true, name: true, email: true },
        },
        assignee: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        entity: "ticket",
        entityId: id,
        action: "ticket_claimed",
        actorId: userId,
      },
    });

    // Notificar al solicitante
    try {
      await NotificationsService.notifyTicketAssigned(id, userId);
    } catch (error) {
      logger.error({ err: error }, "Error sending notification for ticket claim");
    }

    logger.info(`Ticket claimed: ${id} by agent: ${userId}`);
    return updatedTicket;
  }
}
