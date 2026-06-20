import { Router } from "express";
import { UsersController } from "../controllers/users.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/", authMiddleware, UsersController.listUsers);
router.get("/agents", authMiddleware, UsersController.listAgents);
router.get("/:id", authMiddleware, UsersController.getUserById);
router.post("/", authMiddleware, UsersController.createUser);
router.patch("/:id", authMiddleware, UsersController.updateUser);
router.patch("/:id/password", authMiddleware, UsersController.changePassword);
router.post("/:id/reset-password", authMiddleware, UsersController.resetPassword);
router.delete("/:id", authMiddleware, UsersController.deleteUser);
router.post("/:id/restore", authMiddleware, UsersController.restoreUser);
router.get("/:id/stats", authMiddleware, UsersController.getUserStats);

export default router;
