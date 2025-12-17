import { Router } from "express";
import DashboardController from "../controllers/dashboard.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/stats", authMiddleware, DashboardController.stats as any);
router.get("/agent-stats", authMiddleware, DashboardController.agentStats as any);
router.get("/user-stats", authMiddleware, DashboardController.userStats as any);

export default router;
