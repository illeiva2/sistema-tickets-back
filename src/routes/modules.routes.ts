import { Router } from "express";
import ModulesController from "../controllers/modules.controller";
import { authMiddleware, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { setUserGrantsSchema } from "../validations/modules";
import { UserRole } from "@prisma/client";

const router = Router();

// Cualquier usuario autenticado puede saber a que modulos entra: el front lo
// usa para armar el sidebar y para decidir si muestra el item del laboratorio.
router.get("/me", authMiddleware, ModulesController.me);

// Administracion de permisos: solo ADMIN.
router.get(
  "/catalog",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  ModulesController.catalog,
);
router.get(
  "/grants",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  ModulesController.grants,
);
router.put(
  "/grants/:userId",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  validate(setUserGrantsSchema),
  ModulesController.setGrants,
);

export default router;
