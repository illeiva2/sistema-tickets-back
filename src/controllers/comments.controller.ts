import { Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validation";
import { AuthenticatedRequest } from "../middleware/auth";
import CommentsService from "../services/comments.service";

const listSchema = z.object({
  params: z.object({ ticketId: z.string().min(1) }),
  query: z
    .object({
      page: z.coerce.number().min(1).default(1),
      pageSize: z.coerce.number().min(1).max(100).default(20),
    })
    .partial(),
});

const createSchema = z.object({
  params: z.object({ ticketId: z.string().min(1) }),
  body: z.object({ message: z.string().min(1).max(2000) }),
});

export class CommentsController {
  static list = [
    validate(listSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const { ticketId } = req.params as any;
        const { page = 1, pageSize = 20 } = req.query as any;
        const result = await CommentsService.listByTicket(
          ticketId,
          page,
          pageSize,
        );
        res.json({ success: true, data: result });
      } catch (err) {
        next(err);
      }
    },
  ];

  static create = [
    validate(createSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const { ticketId } = req.params as any;
        const { message } = req.body as any;
        const comment = await CommentsService.create(
          ticketId,
          req.user.id,
          message,
        );
        // Audit log para actividad reciente
        const { prisma } = await import("../lib/database");
        await prisma.auditLog.create({
          data: {
            entity: "ticket",
            entityId: ticketId,
            action: "comment_added",
            actorId: req.user.id,
          },
        });
        res.status(201).json({ success: true, data: comment });
      } catch (err) {
        next(err);
      }
    },
  ];
}

export default CommentsController;
