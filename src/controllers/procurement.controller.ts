import { NextFunction, Response } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { AuthenticatedRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import PurchasesService from "../services/purchases.service";
import SuppliersService from "../services/suppliers.service";
import {
  cancelPurchaseSchema,
  createPurchaseSchema,
  createSupplierSchema,
  purchaseFiltersSchema,
  purchaseIdParamsSchema,
  purchaseTransitionSchema,
  supplierFiltersSchema,
  supplierIdParamsSchema,
  updatePurchaseSchema,
  updateSupplierSchema,
} from "../validations/procurement";

const authenticated = (req: AuthenticatedRequest) => {
  if (!req.user) {
    throw new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401);
  }
  return req.user;
};

export class SuppliersController {
  static list = [
    validate(z.object({ query: supplierFiltersSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        authenticated(req);
        res.json({
          success: true,
          data: await SuppliersService.list(req.query as any),
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static getOne = [
    validate(z.object({ params: supplierIdParamsSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        authenticated(req);
        res.json({
          success: true,
          data: { supplier: await SuppliersService.getOne(req.params.id) },
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static create = [
    validate(z.object({ body: createSupplierSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const supplier = await SuppliersService.create(req.body, user.id);
        res.status(201).json({ success: true, data: { supplier } });
      } catch (error) {
        next(error);
      }
    },
  ];

  static update = [
    validate(
      z.object({
        params: supplierIdParamsSchema,
        body: updateSupplierSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const supplier = await SuppliersService.update(
          req.params.id,
          req.body,
          user.id,
        );
        res.json({ success: true, data: { supplier } });
      } catch (error) {
        next(error);
      }
    },
  ];
}

export class PurchasesController {
  static list = [
    validate(z.object({ query: purchaseFiltersSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        authenticated(req);
        res.json({
          success: true,
          data: await PurchasesService.list(req.query as any),
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static lookups = [
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        authenticated(req);
        res.json({ success: true, data: await PurchasesService.lookups() });
      } catch (error) {
        next(error);
      }
    },
  ];

  static getOne = [
    validate(z.object({ params: purchaseIdParamsSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        authenticated(req);
        res.json({
          success: true,
          data: { purchase: await PurchasesService.getOne(req.params.id) },
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static create = [
    validate(z.object({ body: createPurchaseSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const purchase = await PurchasesService.create(req.body, user.id);
        res.status(201).json({ success: true, data: { purchase } });
      } catch (error) {
        next(error);
      }
    },
  ];

  static update = [
    validate(
      z.object({
        params: purchaseIdParamsSchema,
        body: updatePurchaseSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const purchase = await PurchasesService.update(
          req.params.id,
          req.body,
          user.id,
        );
        res.json({ success: true, data: { purchase } });
      } catch (error) {
        next(error);
      }
    },
  ];

  private static transition(
    action: "approve" | "order" | "receive",
  ) {
    return [
      validate(
        z.object({
          params: purchaseIdParamsSchema,
          body: purchaseTransitionSchema,
        }),
      ),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const user = authenticated(req);
          const purchase = await PurchasesService[action](
            req.params.id,
            req.body,
            user.id,
          );
          res.json({ success: true, data: { purchase } });
        } catch (error) {
          next(error);
        }
      },
    ];
  }

  static approve = PurchasesController.transition("approve");
  static order = PurchasesController.transition("order");
  static receive = PurchasesController.transition("receive");

  static cancel = [
    validate(
      z.object({
        params: purchaseIdParamsSchema,
        body: cancelPurchaseSchema,
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = authenticated(req);
        const purchase = await PurchasesService.cancel(
          req.params.id,
          req.body,
          user.id,
          user.role,
        );
        res.json({ success: true, data: { purchase } });
      } catch (error) {
        next(error);
      }
    },
  ];
}
