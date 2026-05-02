import { Router } from "express";
import { NotificationsController } from "../controllers/notifications.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/debug-config", authMiddleware, NotificationsController.debugConfig);
router.get("/test-connection", authMiddleware, NotificationsController.testConnection);
router.post("/test-email", authMiddleware, NotificationsController.sendTestEmail);
router.get("/user", authMiddleware, NotificationsController.getUserNotifications);
router.patch("/:id/read", authMiddleware, NotificationsController.markAsRead);
router.patch("/mark-all-read", authMiddleware, NotificationsController.markAllAsRead);
router.get("/preferences", authMiddleware, NotificationsController.getUserPreferences);
router.patch("/preferences", authMiddleware, NotificationsController.updateUserPreferences);

export default router;
