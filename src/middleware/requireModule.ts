import { Request, Response, NextFunction } from "express";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import ModulesService from "../services/modules.service";
import { ModuleLevel } from "../lib/modules";

/**
 * Exige que el usuario autenticado tenga habilitado un modulo.
 *
 * Va en archivo aparte y NO dentro de middleware/auth.ts a proposito: auth.ts es
 * el camino critico de toda la app y no conviene tocarlo para agregar una
 * autorizacion opcional.
 *
 * Se usa SIEMPRE despues de authMiddleware.
 */
export const requireModule = (moduleKey: string, minLevel?: ModuleLevel) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return next(
          new ApiError("UNAUTHORIZED", "Autenticación requerida", 401),
        );
      }

      const { allowed, level } = await ModulesService.hasAccess(
        req.user.id,
        req.user.role,
        moduleKey,
      );

      if (!allowed) {
        logger.warn(
          { userId: req.user.id, moduleKey, path: req.path },
          "User attempted to access a module they are not granted",
        );
        return next(
          new ApiError(
            "FORBIDDEN",
            "No tenés acceso a este módulo",
            403,
            { moduleKey },
          ),
        );
      }

      if (minLevel && !meetsLevel(level, minLevel)) {
        return next(
          new ApiError(
            "FORBIDDEN",
            "Tu nivel de acceso a este módulo no alcanza para esta acción",
            403,
            { moduleKey, required: minLevel, actual: level },
          ),
        );
      }

      req.moduleAccess = { moduleKey, level: level ?? "VIEWER" };
      next();
    } catch (error) {
      next(error);
    }
  };
};

const ORDER: ModuleLevel[] = ["VIEWER", "QC", "MANAGEMENT"];

const meetsLevel = (
  actual: ModuleLevel | null,
  required: ModuleLevel,
): boolean => {
  if (!actual) return false;
  return ORDER.indexOf(actual) >= ORDER.indexOf(required);
};
