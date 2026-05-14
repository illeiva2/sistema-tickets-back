import { Router } from "express";
import DepartmentsController from "../controllers/departments.controller";
import { authMiddleware, requireRole } from "../middleware/auth";
import { UserRole } from "@prisma/client";

const router = Router();

// Lectura: cualquier usuario autenticado (lo usan selects, badges,
// listado de sectores).
router.get("/", authMiddleware, DepartmentsController.list);
router.get("/:id", authMiddleware, DepartmentsController.getOne);

// Mutaciones: solo ADMIN.
router.post(
  "/",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  DepartmentsController.create,
);
router.patch(
  "/:id",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  DepartmentsController.update,
);
router.delete(
  "/:id",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  DepartmentsController.remove,
);

export default router;
