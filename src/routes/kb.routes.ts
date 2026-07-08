import { Router } from "express";
import KbController from "../controllers/kb.controller";
import { authMiddleware, requireRole } from "../middleware/auth";
import { UserRole } from "@prisma/client";

const router = Router();

// Estado de la integracion (para que el front muestre/oculte la UI).
router.get("/status", authMiddleware, KbController.status);

// Busqueda libre en la KB oficial: cualquier usuario autenticado.
// El corpus de bc.finneg.com es publico; solo evitamos trafico anonimo.
router.get("/buscar", authMiddleware, KbController.buscar);

// Sugerencias para un ticket: solo staff. La respuesta ecoa la consulta
// construida desde el titulo del ticket, por eso no se abre a USER
// (que podria sondear titulos de tickets ajenos).
router.get(
  "/tickets/:ticketId/suggestions",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  KbController.suggestionsForTicket,
);

export default router;
