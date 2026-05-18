import { Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validation";
import { AuthenticatedRequest } from "../middleware/auth";
import WorkshopsImportService from "../services/workshopsImport.service";
import WorkshopRulesService from "../services/workshopsRules.service";
import {
  importWorkshopsSchema,
  createRuleSchema,
  updateRuleSchema,
} from "../validations/workshops";

export class WorkshopsImportController {
  static run = [
    validate(z.object({ body: importWorkshopsSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const { sheetUrl, mode, dryRun } = req.body;
        const summary = await WorkshopsImportService.importFromSheet(
          sheetUrl,
          mode,
          req.user.id,
          dryRun ?? false,
        );
        res.json({ success: true, data: summary });
      } catch (err) {
        next(err);
      }
    },
  ];

  static history = async (
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
      const items = await WorkshopsImportService.listImports(30);
      res.json({ success: true, data: items });
    } catch (err) {
      next(err);
    }
  };
}

export class WorkshopRulesController {
  static list = async (
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
      const rules = await WorkshopRulesService.list();
      res.json({ success: true, data: rules });
    } catch (err) {
      next(err);
    }
  };

  static create = [
    validate(z.object({ body: createRuleSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const created = await WorkshopRulesService.create(req.body);
        res.status(201).json({ success: true, data: created });
      } catch (err) {
        next(err);
      }
    },
  ];

  static update = [
    validate(z.object({ body: updateRuleSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const { id } = req.params;
        const updated = await WorkshopRulesService.update(id, req.body);
        res.json({ success: true, data: updated });
      } catch (err) {
        next(err);
      }
    },
  ];

  static remove = async (
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
      const { id } = req.params;
      await WorkshopRulesService.remove(id);
      res.json({ success: true, data: { message: "Regla eliminada" } });
    } catch (err) {
      next(err);
    }
  };
}
