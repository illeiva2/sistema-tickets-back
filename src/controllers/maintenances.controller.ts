import { NextFunction, Response } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { AuthenticatedRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import MaintenancesService from "../services/maintenances.service";
import {
  createMaintenanceSchema,
  maintenanceFiltersSchema,
  maintenanceIdParamsSchema,
  updateMaintenanceSchema,
} from "../validations/maintenances";

const requireAuthenticatedUser = (req: AuthenticatedRequest) => {
  if (!req.user) {
    throw new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401);
  }
  return req.user;
};

export class MaintenancesController {
  static list = [
    validate(z.object({ query: maintenanceFiltersSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        requireAuthenticatedUser(req);
        const result = await MaintenancesService.list(req.query as any);
        res.json({ success: true, data: result });
      } catch (error) {
        next(error);
      }
    },
  ];

  static lookups = [
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        requireAuthenticatedUser(req);
        const result = await MaintenancesService.lookups();
        res.json({ success: true, data: result });
      } catch (error) {
        next(error);
      }
    },
  ];

  static getOne = [
    validate(z.object({ params: maintenanceIdParamsSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        requireAuthenticatedUser(req);
        const maintenance = await MaintenancesService.getOne(req.params.id);
        res.json({ success: true, data: { maintenance } });
      } catch (error) {
        next(error);
      }
    },
  ];

  static create = [
    validate(z.object({ body: createMaintenanceSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireAuthenticatedUser(req);
        const maintenance = await MaintenancesService.create(req.body, user.id);
        res.status(201).json({ success: true, data: { maintenance } });
      } catch (error) {
        next(error);
      }
    },
  ];

  static update = [
    validate(
      z.object({
        params: maintenanceIdParamsSchema,
        body: updateMaintenanceSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireAuthenticatedUser(req);
        const maintenance = await MaintenancesService.update(
          req.params.id,
          req.body,
          user.id,
        );
        res.json({ success: true, data: { maintenance } });
      } catch (error) {
        next(error);
      }
    },
  ];
}

export default MaintenancesController;
