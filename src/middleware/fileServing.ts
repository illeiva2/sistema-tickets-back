import { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs/promises";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import jwt from "jsonwebtoken";
import { UserRole } from "@prisma/client";

export interface AuthenticatedFileRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: UserRole;
  };
}

/**
 * Middleware para autenticar usuarios en rutas de archivos
 */
export const authenticateFileAccess = async (
  req: AuthenticatedFileRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new ApiError(
        "UNAUTHORIZED",
        "Token de autenticación requerido",
        401,
      );
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      req.user = {
        id: decoded.userId,
        email: decoded.email,
        role: decoded.role,
      };
      next();
    } catch (jwtError) {
      throw new ApiError("UNAUTHORIZED", "Token inválido", 401);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Error interno del servidor",
      },
    });
  }
};

/**
 * Middleware para servir archivos de manera segura
 * Verifica que el usuario tenga acceso al ticket asociado al archivo
 */
export const secureFileServing = async (
  req: AuthenticatedFileRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const filePath = req.path;

    // Extraer el nombre del archivo de la URL
    const fileName = path.basename(filePath);

    console.log(`🔍 Buscando archivo: ${fileName}`);
    console.log(`🔍 Ruta completa: ${filePath}`);
    console.log(`🔍 Usuario:`, req.user);

    // Buscar el archivo en la base de datos - probar diferentes patrones
    let attachment = await prisma.attachment.findFirst({
      where: {
        storageUrl: `/uploads/${fileName}`,
      },
      include: {
        ticket: {
          select: {
            id: true,
            requesterId: true,
            assigneeId: true,
          },
        },
      },
    });

    // Si no se encuentra, probar con la ruta completa
    if (!attachment) {
      attachment = await prisma.attachment.findFirst({
        where: {
          storageUrl: filePath,
        },
        include: {
          ticket: {
            select: {
              id: true,
              requesterId: true,
              assigneeId: true,
            },
          },
        },
      });
    }

    // Si aún no se encuentra, probar con solo el nombre del archivo
    if (!attachment) {
      attachment = await prisma.attachment.findFirst({
        where: {
          fileName: fileName,
        },
        include: {
          ticket: {
            select: {
              id: true,
              requesterId: true,
              assigneeId: true,
            },
          },
        },
      });
    }

    if (!attachment) {
      console.log(`❌ Archivo no encontrado en BD: ${fileName}`);
      throw new ApiError("FILE_NOT_FOUND", "Archivo no encontrado", 404);
    }

    console.log(`✅ Archivo encontrado:`, {
      id: attachment.id,
      fileName: attachment.fileName,
      storageUrl: attachment.storageUrl,
      ticketId: attachment.ticket?.id,
      requesterId: attachment.ticket?.requesterId,
      assigneeId: attachment.ticket?.assigneeId,
    });

    // Verificar que el usuario tenga acceso al ticket
    if (!req.user) {
      throw new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401);
    }

    const { ticket } = attachment;
    const userId = req.user.id;
    const userRole = req.user.role;

    console.log(`🔐 Verificando permisos:`, {
      userId,
      userRole,
      ticketRequesterId: ticket?.requesterId,
      ticketAssigneeId: ticket?.assigneeId,
    });

    // Los admins pueden acceder a todos los archivos
    if (userRole === "ADMIN") {
      console.log(`✅ Admin - acceso permitido`);
      return next();
    }

    // Los agentes también pueden acceder a todos los archivos
    if (userRole === "AGENT") {
      console.log(`✅ Agente - acceso permitido (acceso completo)`);
      return next();
    }

    // Los usuarios solo pueden acceder a archivos de sus propios tickets
    if (userRole === "USER" && ticket?.requesterId === userId) {
      console.log(`✅ Usuario - acceso permitido (es el solicitante)`);
      return next();
    }

    // Si no cumple ninguna condición, acceso denegado
    console.log(`❌ Acceso denegado - no cumple condiciones de permisos`);
    throw new ApiError("FORBIDDEN", "Acceso denegado al archivo", 403);
  } catch (error) {
    console.error(`❌ Error en secureFileServing:`, error);

    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    // Error interno del servidor
    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Error interno del servidor",
      },
    });
  }
};

/**
 * Middleware para verificar que el archivo existe físicamente
 */
export const fileExists = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const filePath = req.path;
    const fileName = path.basename(filePath);
    const fullPath = path.join(process.cwd(), "uploads", fileName);

    try {
      await fs.access(fullPath);
      next();
    } catch {
      return res.status(404).json({
        success: false,
        error: {
          code: "FILE_NOT_FOUND",
          message: "Archivo no encontrado en el servidor",
        },
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Error interno del servidor",
      },
    });
  }
};
