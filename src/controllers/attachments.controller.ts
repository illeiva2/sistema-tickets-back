import { Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validation";
import { AuthenticatedRequest } from "../middleware/auth";
import AttachmentsService from "../services/attachments.service";
import FileValidationService from "../services/fileValidation.service";
import path from "path";
import fs from "fs/promises";

const listSchema = z.object({
  params: z.object({ ticketId: z.string().min(1) }),
});

const deleteSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
});

export class AttachmentsController {
  static list = [
    validate(listSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Usuario no autenticado",
            },
          });
        }
        const { ticketId } = req.params as any;
        const data = await AttachmentsService.listByTicket(ticketId);
        res.json({ success: true, data });
      } catch (err) {
        next(err);
      }
    },
  ];

  static upload = async (
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

      const { ticketId } = req.params as any;
      const file = req.file as Express.Multer.File | undefined;

      if (!file) {
        return res.status(400).json({
          success: false,
          error: { code: "NO_FILE", message: "Archivo requerido" },
        });
      }

      // Validar archivo antes de procesarlo
      try {
        FileValidationService.validateFile(file);
      } catch (validationError: any) {
        return res.status(400).json({
          success: false,
          error: {
            code: validationError.code || "VALIDATION_ERROR",
            message:
              validationError.message || "Error de validación del archivo",
          },
        });
      }

      const created = await AttachmentsService.create(ticketId, file);
      res.status(201).json({ success: true, data: created });
    } catch (err) {
      next(err);
    }
  };

  static remove = [
    validate(deleteSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }

        const { id } = req.params as any;
        const result = await AttachmentsService.delete(id);
        res.json({ success: true, data: result });
      } catch (err) {
        next(err);
      }
    },
  ];

  /**
   * Sirve un archivo con autenticación
   */
  static serveFile = async (
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

      const { fileName } = req.params as any;

      // Buscar el archivo en la base de datos
      const attachment = await AttachmentsService.findByFileName(fileName);

      if (!attachment) {
        return res.status(404).json({
          success: false,
          error: { code: "FILE_NOT_FOUND", message: "Archivo no encontrado" },
        });
      }

      // Verificar permisos del usuario
      const hasAccess = await AttachmentsService.verifyUserAccess(
        attachment.id,
        req.user.id,
        req.user.role,
      );

      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "Acceso denegado al archivo" },
        });
      }

      // Servir el archivo
      const filePath = path.join(process.cwd(), "uploads", fileName);

      // Verificar que el archivo existe físicamente
      try {
        await fs.access(filePath);
      } catch {
        return res.status(404).json({
          success: false,
          error: {
            code: "FILE_NOT_FOUND",
            message: "Archivo no encontrado en el servidor",
          },
        });
      }

      // Configurar headers para evitar problemas de CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      // Servir el archivo
      res.sendFile(filePath);
    } catch (err) {
      next(err);
    }
  };

  /**
   * Sirve un thumbnail con autenticación
   */
  static serveThumbnail = async (
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

      const { fileName } = req.params as any;

      // Buscar el archivo original en la base de datos para verificar permisos
      const attachment = await AttachmentsService.findByThumbnailName(fileName);

      if (!attachment) {
        return res.status(404).json({
          success: false,
          error: {
            code: "THUMBNAIL_NOT_FOUND",
            message: "Thumbnail no encontrado",
          },
        });
      }

      // Verificar permisos del usuario
      const hasAccess = await AttachmentsService.verifyUserAccess(
        attachment.id,
        req.user.id,
        req.user.role,
      );

      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "Acceso denegado al thumbnail" },
        });
      }

      // Servir el thumbnail
      const thumbnailPath = path.join(process.cwd(), "thumbnails", fileName);

      // Verificar que el thumbnail existe físicamente
      try {
        await fs.access(thumbnailPath);
      } catch {
        return res.status(404).json({
          success: false,
          error: {
            code: "THUMBNAIL_NOT_FOUND",
            message: "Thumbnail no encontrado en el servidor",
          },
        });
      }

      // Configurar headers para evitar problemas de CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      // Servir el thumbnail
      res.sendFile(thumbnailPath);
    } catch (err) {
      next(err);
    }
  };

  static getInfo = [
    validate(deleteSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }

        const { id } = req.params as any;
        const data = await AttachmentsService.getFileInfo(id);
        res.json({ success: true, data });
      } catch (err) {
        next(err);
      }
    },
  ];

  static checkExists = [
    validate(deleteSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }

        const { id } = req.params as any;
        const exists = await AttachmentsService.fileExists(id);
        res.json({ success: true, data: { exists } });
      } catch (err) {
        next(err);
      }
    },
  ];

  static getValidationConfig = async (
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

      // Solo admins pueden ver la configuración
      if (req.user.role !== "ADMIN") {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "Acceso denegado" },
        });
      }

      const config = FileValidationService.getConfig();
      res.json({ success: true, data: config });
    } catch (err) {
      next(err);
    }
  };
}

export default AttachmentsController;
