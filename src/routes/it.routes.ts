import { Router } from "express";
import { UserRole } from "@prisma/client";
import ItController from "../controllers/it.controller";
import { authMiddleware, requireRole } from "../middleware/auth";

const router = Router();

router.get(
  "/overview",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ItController.overview,
);

export default router;
