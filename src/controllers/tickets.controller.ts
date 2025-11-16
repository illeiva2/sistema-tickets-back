import { Response, NextFunction } from "express";
import { TicketsService } from "../services/tickets.service";
import { AuthenticatedRequest } from "../middleware/auth";
import {
  createTicketSchema,
  updateTicketSchema,
  ticketFiltersSchema,
} from "../validations/tickets";
import { validate } from "../middleware/validation";
import { z } from "zod";

export class TicketsController {
  static getTickets = [
    validate(z.object({ query: ticketFiltersSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }

        const result = await TicketsService.getTickets(
          req.query as any,
          req.user.id,
          req.user.role,
        );

        res.json({
          success: true,
          data: result,
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static getTicketById = async (
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
      const ticket = await TicketsService.getTicketById(
        id,
        req.user.id,
        req.user.role,
      );

      res.json({
        success: true,
        data: ticket,
      });
    } catch (error) {
      next(error);
    }
  };

  static createTicket = [
    validate(z.object({ body: createTicketSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }

        const ticket = await TicketsService.createTicket(req.body, req.user.id);

        res.status(201).json({
          success: true,
          data: ticket,
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static updateTicket = [
    validate(z.object({ body: updateTicketSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }

        const { id } = req.params;
        const ticket = await TicketsService.updateTicket(
          id,
          req.body,
          req.user.id,
          req.user.role,
        );

        res.json({
          success: true,
          data: ticket,
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static closeTicket = [
    validate(
      z.object({
        body: z.object({
          comment: z.string().min(1, "El comentario es obligatorio"),
        }),
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }

        const { id } = req.params;
        const { comment } = req.body;

        const ticket = await TicketsService.closeTicket(
          id,
          req.user.id,
          req.user.role,
          comment,
        );

        res.json({
          success: true,
          data: ticket,
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static reopenTicket = [
    validate(
      z.object({
        body: z.object({
          comment: z.string().min(1, "El comentario es obligatorio"),
        }),
      }),
    ),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }

        const { id } = req.params;
        const { comment } = req.body;

        const ticket = await TicketsService.reopenTicket(
          id,
          req.user.id,
          req.user.role,
          comment,
        );

        res.json({
          success: true,
          data: ticket,
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static deleteTicket = async (
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
      await TicketsService.deleteTicket(id, req.user.role);

      res.json({
        success: true,
        data: { message: "Ticket eliminado correctamente" },
      });
    } catch (error) {
      next(error);
    }
  };
}
