import { Router } from "express";
import DashboardController from "../controllers/dashboard.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/", authMiddleware, DashboardController.get as any);

// Compat con clientes viejos: redirigen al endpoint principal.
router.get("/stats", authMiddleware, DashboardController.get as any);
router.get("/agent-stats", authMiddleware, DashboardController.get as any);
router.get("/user-stats", authMiddleware, DashboardController.get as any);

export default router;
