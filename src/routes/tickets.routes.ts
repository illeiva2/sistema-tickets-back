import { Router } from "express";
import { TicketsController } from "../controllers/tickets.controller";
import { CommentsController } from "../controllers/comments.controller";
import { authMiddleware, requireRole } from "../middleware/auth";
import { UserRole } from "@prisma/client";

const router = Router();

router.get("/", authMiddleware, TicketsController.getTickets as any);
router.get("/:id", authMiddleware, TicketsController.getTicketById as any);
router.post("/", authMiddleware, TicketsController.createTicket as any);
router.patch("/:id", authMiddleware, TicketsController.updateTicket as any);
router.post("/:id/close", authMiddleware, TicketsController.closeTicket as any);
router.post("/:id/reopen", authMiddleware, TicketsController.reopenTicket as any);
router.delete(
    "/:id",
    authMiddleware,
    requireRole([UserRole.ADMIN]),
    TicketsController.deleteTicket as any
);

// Comments routes nested in tickets
router.get("/:ticketId/comments", authMiddleware, CommentsController.list as any);
router.post("/:ticketId/comments", authMiddleware, CommentsController.create as any);

export default router;
