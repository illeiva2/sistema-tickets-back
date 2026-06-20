import { Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validation";
import { AuthenticatedRequest } from "../middleware/auth";
import ProjectsService from "../services/projects.service";
import {
  createProjectSchema,
  updateProjectSchema,
  projectFiltersSchema,
} from "../validations/projects";

export class ProjectsController {
  static list = [
    validate(z.object({ query: projectFiltersSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const result = await ProjectsService.list(req.query as any, req.user.role);
        res.json({ success: true, data: result });
      } catch (err) {
        next(err);
      }
    },
  ];

  static getInProgress = async (
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
      const items = await ProjectsService.getInProgress(5);
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
      const { idOrSlug } = req.params;
      const project = await ProjectsService.getOne(idOrSlug, req.user.role);
      res.json({ success: true, data: project });
    } catch (err) {
      next(err);
    }
  };

  static create = [
    validate(z.object({ body: createProjectSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const project = await ProjectsService.create(
          req.body,
          req.user.id,
          req.user.role,
        );
        res.status(201).json({ success: true, data: project });
      } catch (err) {
        next(err);
      }
    },
  ];

  static update = [
    validate(z.object({ body: updateProjectSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const { id } = req.params;
        const project = await ProjectsService.update(
          id,
          req.body,
          req.user.id,
          req.user.role,
        );
        res.json({ success: true, data: project });
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
      await ProjectsService.remove(id, req.user.role);
      res.json({ success: true, data: { message: "Proyecto eliminado" } });
    } catch (err) {
      next(err);
    }
  };
}

export default ProjectsController;
