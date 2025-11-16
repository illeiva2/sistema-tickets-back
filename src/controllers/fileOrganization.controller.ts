import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import FileOrganizationService from "../services/fileOrganization.service";
import { ApiError } from "../lib/errors";

export class FileOrganizationController {
  /**
   * Obtener archivos de un ticket
   */
  static getTicketFiles = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { ticketId } = req.params;
      
      if (!ticketId) {
        throw new ApiError("MISSING_TICKET_ID", "ID del ticket es requerido", 400);
      }

      const files = await FileOrganizationService.getTicketFiles(ticketId);
      res.json({
        success: true,
        data: files,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Obtener estadísticas de archivos
   */
  static getFileStats = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      // Solo admins y agentes pueden ver estadísticas
      if (req.user?.role !== "ADMIN" && req.user?.role !== "AGENT") {
        throw new ApiError(
          "FORBIDDEN",
          "No tienes permisos para ver estadísticas",
          403,
        );
      }

      const stats = await FileOrganizationService.getFileStats();
      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Buscar archivos por nombre
   */
  static searchFiles = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { q } = req.query;
      
      if (!q || typeof q !== "string") {
        throw new ApiError("MISSING_QUERY", "Término de búsqueda es requerido", 400);
      }

      const files = await FileOrganizationService.searchFiles(q);
      res.json({
        success: true,
        data: files,
      });
    } catch (error) {
      next(error);
    }
  };
}

export default FileOrganizationController;
