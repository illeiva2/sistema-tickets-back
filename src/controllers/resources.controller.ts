import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validation";
import { ResourcesService } from "../services/resources.service";
import {
  createResourceSchema,
  resourceFiltersSchema,
  suggestSchema,
  updateResourceSchema,
  pinnedFiltersSchema,
} from "../validations/resources";
import ResourceDraftsService from "../services/resourceDrafts.service";
import { AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "../lib/database";

// Carga el departmentId del current user. Lo usamos para filtrar audiencia
// en list/getOne/pinned/modal/suggest sin tener que meterlo en el JWT.
const getUserDepartmentId = async (
  userId: string,
): Promise<string | null> => {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { departmentId: true },
  });
  return u?.departmentId ?? null;
};

export class ResourcesController {
  static list = [
    validate(z.object({ query: resourceFiltersSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const userDepartmentId = await getUserDepartmentId(req.user.id);
        const result = await ResourcesService.list(
          req.query as any,
          req.user.role,
          userDepartmentId,
        );
        res.json({ success: true, data: result });
      } catch (err) {
        next(err);
      }
    },
  ];

  static getOne = async (
    req: Request,
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
      const { idOrSlug } = req.params;
      const userDepartmentId = await getUserDepartmentId(req.user.id);
      const resource = await ResourcesService.getOne(
        idOrSlug,
        req.user.role,
        userDepartmentId,
      );
      res.json({ success: true, data: resource });
    } catch (err) {
      next(err);
    }
  };

  // GET /api/resources/for-my-department
  // Devuelve recursos dirigidos al sector del current user. Si el user
  // no tiene sector asignado, devuelve [].
  static getForMyDepartment = async (
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
      const userDepartmentId = await getUserDepartmentId(req.user.id);
      const items = await ResourcesService.getForMyDepartment(
        userDepartmentId,
        5,
      );
      res.json({ success: true, data: items });
    } catch (err) {
      next(err);
    }
  };

  static getModalPinned = async (
    req: Request,
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
      const userDepartmentId = await getUserDepartmentId(req.user.id);
      const items = await ResourcesService.getModalPinned(
        req.user.role,
        userDepartmentId,
        10,
      );
      res.json({ success: true, data: items });
    } catch (err) {
      next(err);
    }
  };

  static getPinned = [
    validate(z.object({ query: pinnedFiltersSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const category = req.query.category as string | undefined;
        const limit = Number(req.query.limit ?? 5);
        const userDepartmentId = await getUserDepartmentId(req.user.id);
        const items = await ResourcesService.getPinned(
          category,
          limit,
          req.user.role,
          userDepartmentId,
        );
        res.json({ success: true, data: items });
      } catch (err) {
        next(err);
      }
    },
  ];

  static suggest = [
    validate(z.object({ query: suggestSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const q = String(req.query.q ?? "");
        const limit = Number(req.query.limit ?? 5);
        const userDepartmentId = await getUserDepartmentId(req.user.id);
        const items = await ResourcesService.suggest(
          q,
          limit,
          req.user.role,
          userDepartmentId,
        );
        res.json({ success: true, data: items });
      } catch (err) {
        next(err);
      }
    },
  ];

  static create = [
    validate(z.object({ body: createResourceSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const created = await ResourcesService.create(req.user.id, req.body);
        res.status(201).json({ success: true, data: created });
      } catch (err) {
        next(err);
      }
    },
  ];

  static update = [
    validate(z.object({ body: updateResourceSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const { id } = req.params;
        const updated = await ResourcesService.update(id, req.body);
        res.json({ success: true, data: updated });
      } catch (err) {
        next(err);
      }
    },
  ];

  // POST /api/resources/upload-image — sube una imagen a Cloudinary para
  // referenciarla desde el markdown de un recurso. multer ya valido el
  // size (10MB) y proceso el multipart; el service valida el MIME.
  static uploadImage = async (
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
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: {
            code: "MISSING_FILE",
            message: "Falta el archivo en el campo 'file'",
          },
        });
      }
      const result = await ResourcesService.uploadImage(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname,
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };

  static draftFromTicket = async (
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
      const { ticketId } = req.params;
      const draft = await ResourceDraftsService.draftFromTicket(
        ticketId,
        req.user.id,
        req.user.role,
      );
      res.json({ success: true, data: draft });
    } catch (err) {
      next(err);
    }
  };

  static remove = async (
    req: Request,
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
      const { id } = req.params;
      await ResourcesService.remove(id);
      res.json({ success: true, data: { message: "Recurso eliminado" } });
    } catch (err) {
      next(err);
    }
  };
}

export default ResourcesController;
