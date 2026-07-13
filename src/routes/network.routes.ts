import { UserRole } from "@prisma/client";
import { Router } from "express";
import NetworkController from "../controllers/network.controller";
import { authMiddleware, requireRole } from "../middleware/auth";

const router = Router();
const authorize = [authMiddleware, requireRole([UserRole.AGENT, UserRole.ADMIN])];

router.get("/lookups", ...authorize, ...NetworkController.lookups);

router.get("/sites", ...authorize, ...NetworkController.listSites);
router.post("/sites", ...authorize, ...NetworkController.createSite);
router.get("/sites/:id", ...authorize, ...NetworkController.getSite);
router.patch("/sites/:id", ...authorize, ...NetworkController.updateSite);

router.get("/devices", ...authorize, ...NetworkController.listDevices);
router.post("/devices", ...authorize, ...NetworkController.createDevice);
router.get("/devices/:id", ...authorize, ...NetworkController.getDevice);
router.patch("/devices/:id", ...authorize, ...NetworkController.updateDevice);

router.get("/links", ...authorize, ...NetworkController.listLinks);
router.post("/links", ...authorize, ...NetworkController.createLink);
router.get("/links/:id", ...authorize, ...NetworkController.getLink);
router.patch("/links/:id", ...authorize, ...NetworkController.updateLink);
router.delete("/links/:id", ...authorize, ...NetworkController.deleteLink);

router.get("/topology-views", ...authorize, ...NetworkController.listTopologyViews);
router.post("/topology-views", ...authorize, ...NetworkController.createTopologyView);
router.get("/topology-views/:id", ...authorize, ...NetworkController.getTopologyView);
router.patch("/topology-views/:id", ...authorize, ...NetworkController.updateTopologyView);
router.put(
  "/topology-views/:id/layout",
  ...authorize,
  ...NetworkController.updateTopologyLayout,
);

export default router;
