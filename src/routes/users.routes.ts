import { Router } from "express";
import { UsersController } from "../controllers/users.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/", authMiddleware, UsersController.listUsers as any);
router.get("/agents", authMiddleware, UsersController.listAgents as any);
router.get("/:id", authMiddleware, UsersController.getUserById as any);
router.post("/", authMiddleware, UsersController.createUser as any);
router.patch("/:id", authMiddleware, UsersController.updateUser as any);
router.patch("/:id/password", authMiddleware, UsersController.changePassword as any);
router.post("/:id/reset-password", authMiddleware, UsersController.resetPassword as any);
router.delete("/:id", authMiddleware, UsersController.deleteUser as any);
router.post("/:id/restore", authMiddleware, UsersController.restoreUser as any);
router.get("/:id/stats", authMiddleware, UsersController.getUserStats as any);

export default router;
