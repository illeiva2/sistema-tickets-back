import { Request, Response, NextFunction } from "express";
import { NotificationsService } from "../services/notifications.service";
import { verifyEmailConnection } from "../config/email";
import { ApiError } from "../lib/errors";
import { config } from "../config";
import { AuthenticatedRequest } from "../middleware/auth";

export class NotificationsController {
  /**
   * Debug: Mostrar configuración de email
   */
  static async debugConfig(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({
        success: true,
        data: {
          host: config.email.host,
          port: config.email.port,
          secure: config.email.secure,
          user: config.email.user,
          password: config.email.password
            ? `${config.email.password.substring(0, 4)}...`
            : "undefined",
          from: config.email.from,
        },
      });
    } catch (error) {
      return next(
        new ApiError(
          "DEBUG_FAILED",
          "Error al obtener configuración de debug",
          500,
        ),
      );
    }
  }

  /**
   * Probar conexión de email
   */
  static async testConnection(req: Request, res: Response, next: NextFunction) {
    try {
      const isConnected = await verifyEmailConnection();

      if (isConnected) {
        res.json({
          success: true,
          message: "Conexión de email verificada correctamente",
        });
      } else {
        return next(
          new ApiError(
            "EMAIL_CONNECTION_FAILED",
            "No se pudo conectar al servicio de email",
            500,
          ),
        );
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return next(error);
      }
      return next(
        new ApiError(
          "EMAIL_TEST_FAILED",
          "Error al probar la conexión de email",
          500,
        ),
      );
    }
  }

  /**
   * Enviar email de prueba
   */
  static async sendTestEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const { to, subject, message } = req.body;

      if (!to || !subject || !message) {
        return next(
          new ApiError(
            "MISSING_FIELDS",
            "Faltan campos requeridos: to, subject, message",
            400,
          ),
        );
      }

      const success = await NotificationsService.sendEmail({
        to,
        subject,
        html: `<p>${message}</p>`,
        text: message,
      });

      if (success) {
        res.json({
          success: true,
          message: "Email de prueba enviado correctamente",
        });
      } else {
        return next(
          new ApiError(
            "EMAIL_SEND_FAILED",
            "No se pudo enviar el email de prueba",
            500,
          ),
        );
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return next(error);
      }
      return next(
        new ApiError(
          "EMAIL_TEST_FAILED",
          "Error al enviar email de prueba",
          500,
        ),
      );
    }
  }

  /**
   * Obtener notificaciones del usuario
   */
  static async getUserNotifications(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return next(
          new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401),
        );
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const notifications = await NotificationsService.getUserNotifications(
        userId,
        limit,
      );

      res.json({
        success: true,
        data: notifications,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        return next(error);
      }
      return next(
        new ApiError(
          "NOTIFICATIONS_FETCH_FAILED",
          "Error al obtener notificaciones",
          500,
        ),
      );
    }
  }

  /**
   * Marcar notificación como leída
   */
  static async markAsRead(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      const { id } = req.params;

      if (!userId) {
        return next(
          new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401),
        );
      }

      if (!id) {
        return next(
          new ApiError("MISSING_ID", "ID de notificación requerido", 400),
        );
      }

      const success = await NotificationsService.markAsRead(id, userId);

      if (success) {
        res.json({
          success: true,
          message: "Notificación marcada como leída",
        });
      } else {
        return next(
          new ApiError(
            "NOTIFICATION_UPDATE_FAILED",
            "No se pudo marcar la notificación como leída",
            500,
          ),
        );
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return next(error);
      }
      return next(
        new ApiError(
          "NOTIFICATION_UPDATE_FAILED",
          "Error al marcar notificación como leída",
          500,
        ),
      );
    }
  }

  /**
   * Marcar todas las notificaciones como leídas
   */
  static async markAllAsRead(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return next(
          new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401),
        );
      }

      const success = await NotificationsService.markAllAsRead(userId);

      if (success) {
        res.json({
          success: true,
          message: "Todas las notificaciones marcadas como leídas",
        });
      } else {
        return next(
          new ApiError(
            "NOTIFICATIONS_UPDATE_FAILED",
            "No se pudieron marcar las notificaciones como leídas",
            500,
          ),
        );
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return next(error);
      }
      return next(
        new ApiError(
          "NOTIFICATIONS_UPDATE_FAILED",
          "Error al marcar notificaciones como leídas",
          500,
        ),
      );
    }
  }

  /**
   * Obtener preferencias de notificaciones del usuario
   */
  static async getUserPreferences(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return next(
          new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401),
        );
      }

      const preferences = await NotificationsService.getUserPreferences(userId);

      res.json({
        success: true,
        data: preferences,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        return next(error);
      }
      return next(
        new ApiError(
          "PREFERENCES_FETCH_FAILED",
          "Error al obtener preferencias",
          500,
        ),
      );
    }
  }

  /**
   * Actualizar preferencias de notificaciones del usuario
   */
  static async updateUserPreferences(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      const updates = req.body;

      if (!userId) {
        return next(
          new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401),
        );
      }

      if (!updates || Object.keys(updates).length === 0) {
        return next(
          new ApiError(
            "MISSING_UPDATES",
            "No se proporcionaron actualizaciones",
            400,
          ),
        );
      }

      const success = await NotificationsService.updateUserPreferences(
        userId,
        updates,
      );

      if (success) {
        res.json({
          success: true,
          message: "Preferencias actualizadas correctamente",
        });
      } else {
        return next(
          new ApiError(
            "PREFERENCES_UPDATE_FAILED",
            "No se pudieron actualizar las preferencias",
            500,
          ),
        );
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return next(error);
      }
      return next(
        new ApiError(
          "PREFERENCES_UPDATE_FAILED",
          "Error al actualizar preferencias",
          500,
        ),
      );
    }
  }
}
