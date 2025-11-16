import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { logger } from "../lib/logger";
import { ApiError } from "../lib/errors";
import { UserRole } from "@prisma/client";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: UserRole;
    mustChangePassword?: boolean;
  };
}

export const authMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new ApiError("UNAUTHORIZED", "Token de acceso requerido", 401);
    }

    const token = authHeader.substring(7);

    const decoded = jwt.verify(token, config.jwt.secret) as any;

    const userId = decoded?.id || decoded?.userId;
    if (!userId || !decoded?.email || !decoded?.role) {
      throw new ApiError("UNAUTHORIZED", "Token inválido", 401);
    }

    req.user = {
      id: userId,
      email: decoded.email,
      role: decoded.role,
      mustChangePassword: decoded.mustChangePassword ?? false,
    };
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      logger.warn("Invalid JWT token");
      next(new ApiError("UNAUTHORIZED", "Token inválido", 401));
    } else {
      next(error);
    }
  }
};

export const requireRole = (roles: UserRole[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ApiError("UNAUTHORIZED", "Autenticación requerida", 401));
    }

    if (!roles.includes(req.user.role)) {
      logger.warn(
        `User ${req.user.email} attempted to access restricted endpoint`,
      );
      return next(new ApiError("FORBIDDEN", "Permisos insuficientes", 403));
    }

    next();
  };
};
