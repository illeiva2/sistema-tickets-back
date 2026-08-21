import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import ModulesService from "../services/modules.service";
import { MODULES } from "../lib/modules";
import { prisma } from "../lib/database";
import { logger } from "../lib/logger";

export class ModulesController {
  /** Modulos que puede usar el usuario logueado. Alimenta el sidebar. */
  static me = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
        });
      }
      const items = await ModulesService.listForUser(req.user.id, req.user.role);
      res.json({ success: true, data: items });
    } catch (err) {
      next(err);
    }
  };

  /** Catalogo completo de modulos. Solo ADMIN: es para la grilla de permisos. */
  static catalog = async (
    _req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      res.json({ success: true, data: MODULES });
    } catch (err) {
      next(err);
    }
  };

  /** Concesiones activas de todos los usuarios. */
  static grants = async (
    _req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const items = await ModulesService.listAllGrants();
      res.json({ success: true, data: items });
    } catch (err) {
      next(err);
    }
  };

  /** Reemplaza el set de modulos de un usuario. Queda en AuditLog. */
  static setGrants = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
        });
      }

      const { userId } = req.params;
      const { modules } = req.body as {
        modules: { moduleKey: string; level: "VIEWER" | "QC" | "MANAGEMENT" }[];
      };

      const result = await ModulesService.setUserGrants(
        userId,
        modules,
        req.user.id,
      );

      // Habilitar o quitar el acceso a datos de calidad tiene que quedar
      // registrado: se escribe en el AuditLog que ya usa el resto de la app.
      if (result.granted.length > 0 || result.revoked.length > 0) {
        await prisma.auditLog.create({
          data: {
            entity: "module_grant",
            entityId: userId,
            action: "updated",
            actorId: req.user.id,
            meta: {
              granted: result.granted,
              revoked: result.revoked,
              unchanged: result.unchanged,
            },
          },
        });
        logger.info(
          { actorId: req.user.id, targetUserId: userId, ...result },
          "Module grants updated",
        );
      }

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };
}

export default ModulesController;
