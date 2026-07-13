import { NextFunction, Response } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { AuthenticatedRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import PeopleService from "../services/people.service";
import {
  createPersonSchema,
  peopleFiltersSchema,
  personIdParamsSchema,
  updatePersonSchema,
} from "../validations/people";

const requireAuthenticatedUser = (req: AuthenticatedRequest) => {
  if (!req.user) {
    throw new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401);
  }
  return req.user;
};

export class PeopleController {
  static list = [
    validate(z.object({ query: peopleFiltersSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        requireAuthenticatedUser(req);
        const result = await PeopleService.list(req.query as any);
        res.json({ success: true, data: result });
      } catch (error) {
        next(error);
      }
    },
  ];

  static getOne = [
    validate(z.object({ params: personIdParamsSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        requireAuthenticatedUser(req);
        const person = await PeopleService.getOne(req.params.id);
        res.json({ success: true, data: person });
      } catch (error) {
        next(error);
      }
    },
  ];

  static create = [
    validate(z.object({ body: createPersonSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireAuthenticatedUser(req);
        const person = await PeopleService.create(req.body, user.id);
        res.status(201).json({ success: true, data: person });
      } catch (error) {
        next(error);
      }
    },
  ];

  static update = [
    validate(
      z.object({
        params: personIdParamsSchema,
        body: updatePersonSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireAuthenticatedUser(req);
        const person = await PeopleService.update(
          req.params.id,
          req.body,
          user.id,
        );
        res.json({ success: true, data: person });
      } catch (error) {
        next(error);
      }
    },
  ];
}

export default PeopleController;
