import { NextFunction, Response } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { AuthenticatedRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import PhoneLinesService from "../services/phoneLines.service";
import {
  assignPhoneLineSchema,
  createPhoneLineSchema,
  createSimChangeSchema,
  deletePhoneLineSchema,
  phoneLineFiltersSchema,
  phoneLineIdParamsSchema,
  returnPhoneLineSchema,
  simChangeFiltersSchema,
  updatePhoneLineSchema,
} from "../validations/phoneLines";

const authenticated = (req: AuthenticatedRequest) => {
  if (!req.user) {
    throw new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401);
  }
  return req.user;
};

export class PhoneLinesController {
  static list = [
    validate(z.object({ query: phoneLineFiltersSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        authenticated(req);
        const data = await PhoneLinesService.list(req.query as any);
        res.json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },
  ];

  static getOne = [
    validate(z.object({ params: phoneLineIdParamsSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        authenticated(req);
        const data = await PhoneLinesService.getOne(req.params.id);
        res.json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },
  ];

  static create = [
    validate(z.object({ body: createPhoneLineSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const data = await PhoneLinesService.create(req.body, user.id);
        res.status(201).json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },
  ];

  static update = [
    validate(
      z.object({
        params: phoneLineIdParamsSchema,
        body: updatePhoneLineSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const data = await PhoneLinesService.update(
          req.params.id,
          req.body,
          user.id,
        );
        res.json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },
  ];

  static deleteLine = [
    validate(
      z.object({
        params: phoneLineIdParamsSchema,
        body: deletePhoneLineSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const data = await PhoneLinesService.delete(
          req.params.id,
          req.body,
          user.id,
        );
        res.json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },
  ];

  static assign = [
    validate(
      z.object({
        params: phoneLineIdParamsSchema,
        body: assignPhoneLineSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const data = await PhoneLinesService.assign(
          req.params.id,
          req.body,
          user.id,
        );
        res.json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },
  ];

  static returnLine = [
    validate(
      z.object({
        params: phoneLineIdParamsSchema,
        body: returnPhoneLineSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const data = await PhoneLinesService.returnLine(
          req.params.id,
          req.body,
          user.id,
        );
        res.json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },
  ];

  static listSimChanges = [
    validate(
      z.object({
        params: phoneLineIdParamsSchema,
        query: simChangeFiltersSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        authenticated(req);
        const data = await PhoneLinesService.listSimChanges(
          req.params.id,
          req.query as any,
        );
        res.json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },
  ];

  static createSimChange = [
    validate(
      z.object({
        params: phoneLineIdParamsSchema,
        body: createSimChangeSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const data = await PhoneLinesService.createSimChange(
          req.params.id,
          req.body,
          user.id,
        );
        res.status(201).json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },
  ];
}

export default PhoneLinesController;
