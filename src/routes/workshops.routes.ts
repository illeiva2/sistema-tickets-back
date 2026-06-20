import { Router } from "express";
import {
  WorkshopsImportController,
  WorkshopRulesController,
} from "../controllers/workshops.controller";
import { authMiddleware, requireRole } from "../middleware/auth";
import { UserRole } from "@prisma/client";

const router = Router();

// Importación de workshops desde Google Sheets (solo ADMIN).
router.post(
  "/import",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  WorkshopsImportController.run,
);
router.get(
  "/imports",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  WorkshopsImportController.history,
);

// Reglas de clasificación (CRUD, solo ADMIN).
router.get(
  "/rules",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  WorkshopRulesController.list,
);
router.post(
  "/rules",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  WorkshopRulesController.create,
);
router.patch(
  "/rules/:id",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  WorkshopRulesController.update,
);
router.delete(
  "/rules/:id",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  WorkshopRulesController.remove,
);

export default router;
