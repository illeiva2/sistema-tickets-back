import { Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validation";
import { AuthenticatedRequest } from "../middleware/auth";
import TicketSharesService from "../services/ticketShares.service";

const shareSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    sharedWithId: z.string().cuid("ID de usuario inválido"),
    message: z.string().max(500).optional(),
  }),
});

const unshareSchema = z.object({
  params: z.object({
    id: z.string().min(1),
    userId: z.string().cuid("ID de usuario inválido"),
  }),
});

export class TicketSharesController {
  static share = [
    validate(shareSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const { id } = req.params;
        const { sharedWithId, message } = req.body;
        const share = await TicketSharesService.shareTicket(
          id,
          sharedWithId,
          req.user.id,
          req.user.role,
          message,
        );
        res.status(201).json({ success: true, data: share });
      } catch (err) {
        next(err);
      }
    },
  ];

  static unshare = [
    validate(unshareSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const { id, userId } = req.params;
        await TicketSharesService.unshareTicket(
          id,
          userId,
          req.user.id,
          req.user.role,
        );
        res.json({ success: true, data: { message: "Share eliminado" } });
      } catch (err) {
        next(err);
      }
    },
  ];
}

export default TicketSharesController;
