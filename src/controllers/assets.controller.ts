import { Response, NextFunction } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { AuthenticatedRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import AssetsService from "../services/assets.service";
import {
  assetFiltersSchema,
  assetIdParamsSchema,
  assignAssetSchema,
  createAssetSchema,
  returnAssetSchema,
  updateAssetSchema,
} from "../validations/assets";

const requireAuthenticatedUser = (req: AuthenticatedRequest) => {
  if (!req.user) {
    throw new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401);
  }
  return req.user;
};

export class AssetsController {
  static list = [
    validate(z.object({ query: assetFiltersSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        requireAuthenticatedUser(req);
        const result = await AssetsService.list(req.query as any);
        res.json({ success: true, data: result });
      } catch (error) {
        next(error);
      }
    },
  ];

  static getOne = [
    validate(z.object({ params: assetIdParamsSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        requireAuthenticatedUser(req);
        const asset = await AssetsService.getOne(req.params.id);
        res.json({ success: true, data: asset });
      } catch (error) {
        next(error);
      }
    },
  ];

  static create = [
    validate(z.object({ body: createAssetSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireAuthenticatedUser(req);
        const asset = await AssetsService.create(req.body, user.id);
        res.status(201).json({ success: true, data: asset });
      } catch (error) {
        next(error);
      }
    },
  ];

  static update = [
    validate(
      z.object({
        params: assetIdParamsSchema,
        body: updateAssetSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireAuthenticatedUser(req);
        const asset = await AssetsService.update(
          req.params.id,
          req.body,
          user.id,
          user.role,
        );
        res.json({ success: true, data: asset });
      } catch (error) {
        next(error);
      }
    },
  ];

  static assign = [
    validate(
      z.object({
        params: assetIdParamsSchema,
        body: assignAssetSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireAuthenticatedUser(req);
        const asset = await AssetsService.assign(
          req.params.id,
          req.body,
          user.id,
        );
        res.json({ success: true, data: asset });
      } catch (error) {
        next(error);
      }
    },
  ];

  static returnAsset = [
    validate(
      z.object({
        params: assetIdParamsSchema,
        body: returnAssetSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireAuthenticatedUser(req);
        const asset = await AssetsService.returnAsset(
          req.params.id,
          req.body,
          user.id,
        );
        res.json({ success: true, data: asset });
      } catch (error) {
        next(error);
      }
    },
  ];
}

export default AssetsController;
