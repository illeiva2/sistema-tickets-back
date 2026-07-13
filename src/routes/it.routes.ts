import { Router } from "express";
import { UserRole } from "@prisma/client";
import ItController from "../controllers/it.controller";
import AssetsController from "../controllers/assets.controller";
import PeopleController from "../controllers/people.controller";
import { authMiddleware, requireRole } from "../middleware/auth";

const router = Router();

router.get(
  "/overview",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ItController.overview,
);

router.get(
  "/assets",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ...AssetsController.list,
);

router.get(
  "/people",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ...PeopleController.list,
);
router.post(
  "/people",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ...PeopleController.create,
);
router.get(
  "/people/:id",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ...PeopleController.getOne,
);
router.patch(
  "/people/:id",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ...PeopleController.update,
);
router.post(
  "/assets",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ...AssetsController.create,
);
router.get(
  "/assets/:id",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ...AssetsController.getOne,
);
router.patch(
  "/assets/:id",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ...AssetsController.update,
);
router.post(
  "/assets/:id/assign",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ...AssetsController.assign,
);
router.post(
  "/assets/:id/return",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ...AssetsController.returnAsset,
);

export default router;
