import { Router } from "express";
import { NotificationsController } from "../controllers/notifications.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/debug-config", authMiddleware, NotificationsController.debugConfig as any);
router.get("/test-connection", authMiddleware, NotificationsController.testConnection as any);
router.post("/test-email", authMiddleware, NotificationsController.sendTestEmail as any);
router.get("/user", authMiddleware, NotificationsController.getUserNotifications as any);
router.patch("/:id/read", authMiddleware, NotificationsController.markAsRead as any);
router.patch("/mark-all-read", authMiddleware, NotificationsController.markAllAsRead as any);
router.get("/preferences", authMiddleware, NotificationsController.getUserPreferences as any);
router.patch("/preferences", authMiddleware, NotificationsController.updateUserPreferences as any);

export default router;
