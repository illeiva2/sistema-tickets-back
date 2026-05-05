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
        const result = await ResourcesService.list(
          req.query as any,
          req.user.role,
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
      const resource = await ResourcesService.getOne(idOrSlug, req.user.role);
      res.json({ success: true, data: resource });
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
      const items = await ResourcesService.getModalPinned(10);
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
        const items = await ResourcesService.getPinned(category, limit);
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
        const items = await ResourcesService.suggest(q, limit);
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
