import { Router } from "express";
import ProjectsController from "../controllers/projects.controller";
import { authMiddleware, requireRole } from "../middleware/auth";
import { UserRole } from "@prisma/client";

const router = Router();

// Lectura: todos los autenticados.
router.get("/", authMiddleware, ProjectsController.list);
router.get("/in-progress", authMiddleware, ProjectsController.getInProgress);
router.get("/:idOrSlug", authMiddleware, ProjectsController.getOne);

// Mutaciones: ADMIN o AGENT (el service refina permisos por proyecto).
router.post(
  "/",
  authMiddleware,
  requireRole([UserRole.ADMIN, UserRole.AGENT]),
  ProjectsController.create,
);
router.patch(
  "/:id",
  authMiddleware,
  requireRole([UserRole.ADMIN, UserRole.AGENT]),
  ProjectsController.update,
);
router.delete(
  "/:id",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  ProjectsController.remove,
);

export default router;
