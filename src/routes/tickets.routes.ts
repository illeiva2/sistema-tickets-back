import { Router } from "express";
import { TicketsController } from "../controllers/tickets.controller";
import { CommentsController } from "../controllers/comments.controller";
import { TicketSharesController } from "../controllers/ticketShares.controller";
import { authMiddleware, requireRole } from "../middleware/auth";
import { UserRole } from "@prisma/client";

const router = Router();

router.get("/", authMiddleware, TicketsController.getTickets);
router.get(
  "/triage-counts",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  TicketsController.getTriageCounts,
);
router.get("/:id", authMiddleware, TicketsController.getTicketById);
router.get("/:id/audit", authMiddleware, TicketsController.getTicketAudit);
router.post("/", authMiddleware, TicketsController.createTicket);
router.patch("/:id", authMiddleware, TicketsController.updateTicket);
router.post("/:id/close", authMiddleware, TicketsController.closeTicket);
router.post("/:id/resolve", authMiddleware, requireRole([UserRole.AGENT, UserRole.ADMIN]), TicketsController.resolveTicket);
router.post("/:id/reopen", authMiddleware, requireRole([UserRole.AGENT, UserRole.ADMIN]), TicketsController.reopenTicket);
router.patch("/:id/claim", authMiddleware, requireRole([UserRole.AGENT, UserRole.ADMIN]), TicketsController.claimTicket);
router.delete(
    "/:id",
    authMiddleware,
    requireRole([UserRole.ADMIN]),
    TicketsController.deleteTicket
);

// Comments routes nested in tickets
router.get("/:ticketId/comments", authMiddleware, CommentsController.list);
router.post("/:ticketId/comments", authMiddleware, CommentsController.create);

// Share routes (solo staff: AGENT/ADMIN). Compartir con otro agente.
router.post(
  "/:id/share",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  TicketSharesController.share,
);
router.delete(
  "/:id/share/:userId",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  TicketSharesController.unshare,
);

export default router;
