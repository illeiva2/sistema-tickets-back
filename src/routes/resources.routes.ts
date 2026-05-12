import { Router } from "express";
import { ResourcesController } from "../controllers/resources.controller";
import { authMiddleware, requireRole } from "../middleware/auth";
import { UserRole } from "@prisma/client";

const router = Router();

// Endpoints de lectura (todos los autenticados):
router.get("/", authMiddleware, ResourcesController.list);
router.get("/suggest", authMiddleware, ResourcesController.suggest);
router.get("/pinned", authMiddleware, ResourcesController.getPinned);
router.get(
  "/modal-pinned",
  authMiddleware,
  ResourcesController.getModalPinned,
);
router.get("/:idOrSlug", authMiddleware, ResourcesController.getOne);

// IA: generar borrador a partir de un ticket resuelto (AGENT o ADMIN).
router.post(
  "/draft-from-ticket/:ticketId",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ResourcesController.draftFromTicket,
);

// Mutaciones (solo ADMIN por ahora; AGENT puede sumarse en el futuro):
router.post(
  "/",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  ResourcesController.create,
);
router.patch(
  "/:id",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  ResourcesController.update,
);
router.delete(
  "/:id",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  ResourcesController.remove,
);

export default router;
