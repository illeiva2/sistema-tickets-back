import { UserRole } from "@prisma/client";
import { Router } from "express";
import AgentsController from "../controllers/agents.controller";
import { authMiddleware, requireRole } from "../middleware/auth";

const router = Router();
const authorize = [authMiddleware, requireRole([UserRole.AGENT, UserRole.ADMIN])];

router.get("/lookups", ...authorize, ...AgentsController.lookups);

router.get("/enrollment-tokens", ...authorize, ...AgentsController.listTokens);
router.post("/enrollment-tokens", ...authorize, ...AgentsController.createToken);
router.post(
  "/enrollment-tokens/:id/revoke",
  ...authorize,
  ...AgentsController.revokeToken,
);

router.get("/devices", ...authorize, ...AgentsController.listDevices);
router.get("/devices/:id", ...authorize, ...AgentsController.getDevice);
router.patch("/devices/:id", ...authorize, ...AgentsController.linkAsset);
router.post("/devices/:id/activate", ...authorize, ...AgentsController.activateDevice);
router.post("/devices/:id/revoke", ...authorize, ...AgentsController.revokeDevice);
router.get("/devices/:id/snapshots", ...authorize, ...AgentsController.snapshots);
router.get("/devices/:id/metrics", ...authorize, ...AgentsController.metrics);
router.post(
  "/devices/:id/remote-sessions",
  ...authorize,
  ...AgentsController.startSession,
);
router.post(
  "/remote-sessions/:id/close",
  ...authorize,
  ...AgentsController.closeSession,
);

export default router;
