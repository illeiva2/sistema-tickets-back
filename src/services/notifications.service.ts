import { prisma } from "../lib/database";
import { config } from "../config";
import { createTransporter } from "../config/email";
import { logger } from "../lib/logger";

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

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Abierto",
  IN_PROGRESS: "En progreso",
  RESOLVED: "Resuelto",
  CLOSED: "Cerrado",
};

const PRIORITY_LABEL: Record<string, string> = {
  LOW: "Baja",
  MEDIUM: "Media",
  HIGH: "Alta",
  URGENT: "Urgente",
};

const INTERNAL_PREFIX = "[INTERNA] ";

const isInternalNote = (message: string): boolean =>
  typeof message === "string" && message.startsWith(INTERNAL_PREFIX);

// ─── Plantilla HTML mínima con look de email transaccional ────────────────────

const buildEmailHtml = (opts: {
  userName: string;
  title: string;
  body: string;
  ticketId?: string;
}): string => {
  const ticketLink =
    opts.ticketId && config.frontendUrl
      ? `${config.frontendUrl.replace(/\/$/, "")}/tickets/${opts.ticketId}`
      : null;

  const cta = ticketLink
    ? `
        <p style="margin: 24px 0 0;">
          <a href="${ticketLink}" style="
            display: inline-block;
            padding: 10px 18px;
            background: #4f46e5;
            color: #ffffff;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 500;
            font-size: 14px;
          ">Ver ticket</a>
        </p>
      `
    : "";

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#27272a;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e7e5e4;">
          <tr>
            <td style="padding:20px 24px;border-bottom:1px solid #e7e5e4;">
              <span style="font-size:13px;font-weight:600;color:#71717a;letter-spacing:0.04em;text-transform:uppercase;">Sistema de tickets</span>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;">
              <p style="margin:0 0 12px;font-size:15px;color:#52525b;">Hola ${opts.userName},</p>
              <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#18181b;line-height:1.4;">${opts.title}</h1>
              <p style="margin:0;font-size:14px;line-height:1.6;color:#3f3f46;">${opts.body}</p>
              ${cta}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e7e5e4;background:#fafaf9;">
              <p style="margin:0;font-size:11px;color:#a1a1aa;line-height:1.5;">
                Este es un mensaje automático del Sistema de tickets. No respondas a este email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

const buildEmailText = (opts: {
  userName: string;
  title: string;
  body: string;
  ticketId?: string;
}): string => {
  const link =
    opts.ticketId && config.frontendUrl
      ? `${config.frontendUrl.replace(/\/$/, "")}/tickets/${opts.ticketId}`
      : null;
  return [
    `Hola ${opts.userName},`,
    "",
    opts.title,
    "",
    opts.body,
    link ? `\nVer ticket: ${link}` : "",
    "",
    "— Sistema de tickets",
  ]
    .filter(Boolean)
    .join("\n");
};

export class NotificationsService {
  /**
   * Enviar email crudo. Reservado a casos donde queremos componer fuera del
   * flujo de createNotification (ej: test desde el panel de admin).
   */
  static async sendEmail(emailData: EmailData): Promise<boolean> {
    try {
      const transporter = createTransporter();
      await transporter.sendMail({
        from: config.email.from,
        to: emailData.to,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
      });
      logger.info({ to: emailData.to }, "Email sent");
      return true;
    } catch (error) {
      logger.error({ err: error, to: emailData.to }, "Failed to send email");
      return false;
    }
  }

  /**
   * Crear notificación in-app y, si las preferencias lo permiten, mandar
   * el email correspondiente con plantilla HTML + texto + link al ticket.
   */
  static async createNotification(data: NotificationData): Promise<boolean> {
    try {
      const preferences = await this.getUserPreferences(data.userId);
      if (!preferences || !preferences[this.getPreferenceKey(data.type)]) {
        logger.debug(
          { userId: data.userId, type: data.type },
          "Notifications disabled for type",
        );
        return false;
      }

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

      if (preferences.email) {
        const user = await prisma.user.findUnique({
          where: { id: data.userId },
          select: { email: true, name: true, isActive: true },
        });

        // No mandar emails a usuarios inactivos.
        if (user && user.isActive !== false) {
          const subject = `[Tickets] ${data.title}`;
          const html = buildEmailHtml({
            userName: user.name,
            title: data.title,
            body: data.message,
            ticketId: data.ticketId,
          });
          const text = buildEmailText({
            userName: user.name,
            title: data.title,
            body: data.message,
            ticketId: data.ticketId,
          });

          await this.sendEmail({
            to: user.email,
            subject,
            html,
            text,
          });
        }
      }

      logger.info(
        { userId: data.userId, type: data.type },
        "Notification created",
      );
      return true;
    } catch (error) {
      logger.error({ err: error }, "Failed to create notification");
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
      logger.error({ err: error }, "Failed to get user notifications");
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
          userId,
        },
        data: { read: true },
      });
      return true;
    } catch (error) {
      logger.error({ err: error }, "Failed to mark notification as read");
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
      logger.error({ err: error }, "Failed to mark all notifications as read");
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

      if (!preferences) {
        preferences = await prisma.notificationPreferences.create({
          data: { userId },
        });
      }

      return preferences;
    } catch (error) {
      logger.error(
        { err: error },
        "Failed to get user notification preferences",
      );
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
      logger.error(
        { err: error },
        "Failed to update user notification preferences",
      );
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

    // Notificar al agente asignado.
    if (assigneeId !== ticket.assignee.id) {
      // Defensivo: si el id pasado no coincide con el ticket actual, evitar.
      logger.warn(
        { ticketId, assigneeId, currentAssignee: ticket.assignee.id },
        "notifyTicketAssigned: assigneeId mismatch",
      );
    }

    await this.createNotification({
      userId: ticket.assignee.id,
      type: "ticket_assigned",
      title: "Ticket asignado a vos",
      message: `Se te asignó el ticket "${ticket.title}".`,
      ticketId,
      metadata: {
        ticketTitle: ticket.title,
        requesterName: ticket.requester.name,
      },
    });

    // Notificar al solicitante (si no es el propio agente).
    if (ticket.requesterId !== ticket.assignee.id) {
      await this.createNotification({
        userId: ticket.requesterId,
        type: "ticket_assigned",
        title: "Tu ticket fue asignado",
        message: `Tu ticket "${ticket.title}" fue asignado a ${ticket.assignee.name}.`,
        ticketId,
        metadata: {
          ticketTitle: ticket.title,
          assigneeName: ticket.assignee.name,
        },
      });
    }
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

    const message = `El ticket "${ticket.title}" pasó de "${STATUS_LABEL[oldStatus] || oldStatus}" a "${STATUS_LABEL[newStatus] || newStatus}".`;

    if (ticket.requesterId !== actorId) {
      await this.createNotification({
        userId: ticket.requesterId,
        type: "status_changed",
        title: "Cambio de estado",
        message,
        ticketId,
        metadata: { oldStatus, newStatus, ticketTitle: ticket.title },
      });
    }

    if (ticket.assigneeId && ticket.assigneeId !== actorId) {
      await this.createNotification({
        userId: ticket.assigneeId,
        type: "status_changed",
        title: "Cambio de estado",
        message,
        ticketId,
        metadata: { oldStatus, newStatus, ticketTitle: ticket.title },
      });
    }
  }

  /**
   * Notificar nuevo comentario. Respeta notas internas: si el message empieza
   * con "[INTERNA] " no se notifica al solicitante (USER), solo al assignee
   * si lo hubiera y es distinto al autor.
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

    const internal = isInternalNote(comment.message);
    const message = `Nuevo comentario en "${ticket.title}" de ${comment.author.name}.`;

    // Notificar al solicitante (USER), salvo que la nota sea interna o sea
    // el propio autor.
    if (!internal && ticket.requesterId !== authorId) {
      await this.createNotification({
        userId: ticket.requesterId,
        type: "comment_added",
        title: "Nuevo comentario",
        message,
        ticketId,
        metadata: {
          commentId,
          ticketTitle: ticket.title,
          authorName: comment.author.name,
        },
      });
    }

    // Notificar al agente asignado si no es el autor.
    if (ticket.assigneeId && ticket.assigneeId !== authorId) {
      await this.createNotification({
        userId: ticket.assigneeId,
        type: "comment_added",
        title: internal ? "Nueva nota interna" : "Nuevo comentario",
        message,
        ticketId,
        metadata: {
          commentId,
          ticketTitle: ticket.title,
          authorName: comment.author.name,
          internal,
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

    const message = `El ticket "${ticket.title}" cambió de prioridad: ${PRIORITY_LABEL[oldPriority] || oldPriority} → ${PRIORITY_LABEL[newPriority] || newPriority}.`;

    if (ticket.requesterId !== actorId) {
      await this.createNotification({
        userId: ticket.requesterId,
        type: "priority_changed",
        title: "Prioridad actualizada",
        message,
        ticketId,
        metadata: { oldPriority, newPriority, ticketTitle: ticket.title },
      });
    }

    if (ticket.assigneeId && ticket.assigneeId !== actorId) {
      await this.createNotification({
        userId: ticket.assigneeId,
        type: "priority_changed",
        title: "Prioridad actualizada",
        message,
        ticketId,
        metadata: { oldPriority, newPriority, ticketTitle: ticket.title },
      });
    }
  }
}
