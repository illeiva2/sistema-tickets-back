import { PrismaClient } from "@prisma/client";
import { createTransporter } from "../config/email";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();

export interface EmailData {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface NotificationData {
  userId: string;
  type: string;
  title: string;
  message: string;
  ticketId?: string;
  metadata?: Record<string, any>;
}

export class NotificationsService {
  /**
   * Enviar email
   */
  static async sendEmail(emailData: EmailData): Promise<boolean> {
    try {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to: emailData.to,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
      });

      logger.info(`Email sent successfully to ${emailData.to}`);
      return true;
    } catch (error) {
      logger.error("Failed to send email notification", error);
      return false;
    }
  }

  /**
   * Crear notificación en la base de datos
   */
  static async createNotification(data: NotificationData): Promise<boolean> {
    try {
      // Verificar si el usuario tiene preferencias habilitadas para este tipo
      const preferences = await this.getUserPreferences(data.userId);
      if (!preferences || !preferences[this.getPreferenceKey(data.type)]) {
        logger.info(
          `Notifications disabled for user ${data.userId} and type ${data.type}`,
        );
        return false;
      }

      // Crear la notificación
      await prisma.notification.create({
        data: {
          userId: data.userId,
          type: data.type,
          title: data.title,
          message: data.message,
          ticketId: data.ticketId,
          metadata: data.metadata,
        },
      });

      // Si las notificaciones por email están habilitadas, enviar email
      if (preferences.email) {
        const user = await prisma.user.findUnique({
          where: { id: data.userId },
          select: { email: true, name: true },
        });

        if (user) {
          await this.sendEmail({
            to: user.email,
            subject: data.title,
            html: `<p>Hola ${user.name},</p><p>${data.message}</p>`,
            text: `${data.title}\n\n${data.message}`,
          });
        }
      }

      logger.info(
        `Notification created for user ${data.userId}: ${data.title}`,
      );
      return true;
    } catch (error) {
      logger.error("Failed to create notification", error);
      return false;
    }
  }

  /**
   * Obtener notificaciones de un usuario
   */
  static async getUserNotifications(
    userId: string,
    limit: number = 50,
  ): Promise<any[]> {
    try {
      const notifications = await prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      return notifications;
    } catch (error) {
      logger.error("Failed to get user notifications", error);
      throw error;
    }
  }

  /**
   * Marcar notificación como leída
   */
  static async markAsRead(
    notificationId: string,
    userId: string,
  ): Promise<boolean> {
    try {
      await prisma.notification.updateMany({
        where: {
          id: notificationId,
          userId, // Asegurar que solo el propietario puede marcarla como leída
        },
        data: { read: true },
      });

      return true;
    } catch (error) {
      logger.error("Failed to mark notification as read", error);
      return false;
    }
  }

  /**
   * Marcar todas las notificaciones como leídas
   */
  static async markAllAsRead(userId: string): Promise<boolean> {
    try {
      await prisma.notification.updateMany({
        where: { userId, read: false },
        data: { read: true },
      });

      return true;
    } catch (error) {
      logger.error("Failed to mark all notifications as read", error);
      return false;
    }
  }

  /**
   * Obtener preferencias de notificaciones de un usuario
   */
  static async getUserPreferences(userId: string): Promise<any> {
    try {
      let preferences = await prisma.notificationPreferences.findUnique({
        where: { userId },
      });

      // Si no existen preferencias, crear las predeterminadas
      if (!preferences) {
        preferences = await prisma.notificationPreferences.create({
          data: { userId },
        });
      }

      return preferences;
    } catch (error) {
      logger.error("Failed to get user notification preferences", error);
      throw error;
    }
  }

  /**
   * Actualizar preferencias de notificaciones
   */
  static async updateUserPreferences(
    userId: string,
    updates: Partial<any>,
  ): Promise<boolean> {
    try {
      await prisma.notificationPreferences.upsert({
        where: { userId },
        update: updates,
        create: { userId, ...updates },
      });

      return true;
    } catch (error) {
      logger.error("Failed to update user notification preferences", error);
      return false;
    }
  }

  /**
   * Obtener la clave de preferencia para un tipo de notificación
   */
  private static getPreferenceKey(type: string): string {
    const preferenceMap: Record<string, string> = {
      ticket_assigned: "ticketAssigned",
      status_changed: "statusChanged",
      comment_added: "commentAdded",
      priority_changed: "priorityChanged",
    };

    return preferenceMap[type] || "ticketAssigned";
  }

  /**
   * Notificar asignación de ticket
   */
  static async notifyTicketAssigned(
    ticketId: string,
    assigneeId: string,
  ): Promise<void> {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { requester: true, assignee: true },
    });

    if (!ticket || !ticket.assignee) return;

    // Notificar al agente asignado
    await this.createNotification({
      userId: assigneeId,
      type: "ticket_assigned",
      title: "Ticket Asignado",
      message: `Se te ha asignado el ticket "${ticket.title}"`,
      ticketId,
      metadata: {
        ticketTitle: ticket.title,
        requesterName: ticket.requester.name,
      },
    });

    // Notificar al solicitante
    await this.createNotification({
      userId: ticket.requesterId,
      type: "ticket_assigned",
      title: "Ticket Asignado a Agente",
      message: `Tu ticket "${ticket.title}" ha sido asignado a un agente`,
      ticketId,
      metadata: {
        ticketTitle: ticket.title,
        assigneeName: ticket.assignee.name,
      },
    });
  }

  /**
   * Notificar cambio de estado
   */
  static async notifyStatusChanged(
    ticketId: string,
    oldStatus: string,
    newStatus: string,
    actorId: string,
  ): Promise<void> {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { requester: true, assignee: true },
    });

    if (!ticket) return;

    const statusLabels: Record<string, string> = {
      OPEN: "Abierto",
      IN_PROGRESS: "En Progreso",
      RESOLVED: "Resuelto",
      CLOSED: "Cerrado",
    };

    const message = `El ticket "${ticket.title}" cambió de estado de "${statusLabels[oldStatus] || oldStatus}" a "${statusLabels[newStatus] || newStatus}"`;

    // Notificar al solicitante
    if (ticket.requesterId !== actorId) {
      await this.createNotification({
        userId: ticket.requesterId,
        type: "status_changed",
        title: "Estado del Ticket Cambiado",
        message,
        ticketId,
        metadata: { oldStatus, newStatus, ticketTitle: ticket.title },
      });
    }

    // Notificar al agente asignado
    if (ticket.assigneeId && ticket.assigneeId !== actorId) {
      await this.createNotification({
        userId: ticket.assigneeId,
        type: "status_changed",
        title: "Estado del Ticket Cambiado",
        message,
        ticketId,
        metadata: { oldStatus, newStatus, ticketTitle: ticket.title },
      });
    }
  }

  /**
   * Notificar nuevo comentario
   */
  static async notifyCommentAdded(
    ticketId: string,
    commentId: string,
    authorId: string,
  ): Promise<void> {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { requester: true, assignee: true },
    });

    if (!ticket) return;

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      include: { author: true },
    });

    if (!comment) return;

    const message = `Nuevo comentario en el ticket "${ticket.title}" de ${comment.author.name}`;

    // Notificar al solicitante (si no es el autor)
    if (ticket.requesterId !== authorId) {
      await this.createNotification({
        userId: ticket.requesterId,
        type: "comment_added",
        title: "Nuevo Comentario",
        message,
        ticketId,
        metadata: {
          commentId,
          ticketTitle: ticket.title,
          authorName: comment.author.name,
        },
      });
    }

    // Notificar al agente asignado (si no es el autor)
    if (ticket.assigneeId && ticket.assigneeId !== authorId) {
      await this.createNotification({
        userId: ticket.assigneeId,
        type: "comment_added",
        title: "Nuevo Comentario",
        message,
        ticketId,
        metadata: {
          commentId,
          ticketTitle: ticket.title,
          authorName: comment.author.name,
        },
      });
    }
  }

  /**
   * Notificar cambio de prioridad
   */
  static async notifyPriorityChanged(
    ticketId: string,
    oldPriority: string,
    newPriority: string,
    actorId: string,
  ): Promise<void> {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { requester: true, assignee: true },
    });

    if (!ticket) return;

    const priorityLabels: Record<string, string> = {
      LOW: "Baja",
      MEDIUM: "Media",
      HIGH: "Alta",
      URGENT: "Urgente",
    };

    const message = `El ticket "${ticket.title}" cambió de prioridad de "${priorityLabels[oldPriority] || oldPriority}" a "${priorityLabels[newPriority] || newPriority}"`;

    // Notificar al solicitante
    if (ticket.requesterId !== actorId) {
      await this.createNotification({
        userId: ticket.requesterId,
        type: "priority_changed",
        title: "Prioridad del Ticket Cambiada",
        message,
        ticketId,
        metadata: { oldPriority, newPriority, ticketTitle: ticket.title },
      });
    }

    // Notificar al agente asignado
    if (ticket.assigneeId && ticket.assigneeId !== actorId) {
      await this.createNotification({
        userId: ticket.assigneeId,
        type: "priority_changed",
        title: "Prioridad del Ticket Cambiada",
        message,
        ticketId,
        metadata: { oldPriority, newPriority, ticketTitle: ticket.title },
      });
    }
  }
}
