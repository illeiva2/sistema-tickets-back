import { Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validation";
import { AuthenticatedRequest } from "../middleware/auth";
import DepartmentsService from "../services/departments.service";
import {
  createDepartmentSchema,
  updateDepartmentSchema,
} from "../validations/departments";

export class DepartmentsController {
  // Listar sectores. Cualquier usuario autenticado puede leer la lista
  // (sirve para selects, badges, etc).
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
      const items = await DepartmentsService.list();
      res.json({ success: true, data: items });
    } catch (err) {
      next(err);
    }
  };

  static getOne = async (
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
      const dep = await DepartmentsService.getOne(req.params.id);
      res.json({ success: true, data: dep });
    } catch (err) {
      next(err);
    }
  };

  static create = [
    validate(z.object({ body: createDepartmentSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const created = await DepartmentsService.create(req.body);
        res.status(201).json({ success: true, data: created });
      } catch (err) {
        next(err);
      }
    },
  ];

  static update = [
    validate(z.object({ body: updateDepartmentSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const updated = await DepartmentsService.update(
          req.params.id,
          req.body,
        );
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
      await DepartmentsService.remove(req.params.id);
      res.json({ success: true, data: { message: "Sector eliminado" } });
    } catch (err) {
      next(err);
    }
  };
}

export default DepartmentsController;
