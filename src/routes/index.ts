import { Router } from "express";
import { logger } from "../lib/logger";
import authRoutes from "./auth.routes";
import dashboardRoutes from "./dashboard.routes";
import ticketsRoutes from "./tickets.routes";
import usersRoutes from "./users.routes";
import notificationsRoutes from "./notifications.routes";
import attachmentsRoutes from "./attachments.routes";
import resourcesRoutes from "./resources.routes";
import departmentsRoutes from "./departments.routes";
import workshopsRoutes from "./workshops.routes";
import projectsRoutes from "./projects.routes";
import kbRoutes from "./kb.routes";
import assistantRoutes from "./assistant.routes";
import pushRoutes from "./push.routes";
import itRoutes from "./it.routes";
import modulesRoutes from "./modules.routes";
import labRoutes from "./lab.routes";
import agentMachineRoutes from "./agent-machine.routes";
import { fileOrganizationRouter, filesServingRouter } from "./files.routes";

const router = Router();

// Mount routes
// Mount routes
logger.info("Mounting routes...");
router.use("/auth", authRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/tickets", ticketsRoutes);
router.use("/users", usersRoutes);
router.use("/notifications", notificationsRoutes);
router.use("/attachments", attachmentsRoutes);
router.use("/resources", resourcesRoutes);
router.use("/departments", departmentsRoutes);
router.use("/workshops", workshopsRoutes);
router.use("/projects", projectsRoutes);
router.use("/kb", kbRoutes);
router.use("/assistant", assistantRoutes);
router.use("/push", pushRoutes);
router.use("/it", itRoutes);
router.use("/modules", modulesRoutes);
router.use("/glutenlab", labRoutes);
router.use("/agent", agentMachineRoutes);

if (fileOrganizationRouter) {
    logger.info("Mounting file-organization routes");
    router.use("/file-organization", fileOrganizationRouter);
} else {
    logger.error("fileOrganizationRouter is undefined!");
}

// Serving routes are mounted directly on /api so we use them on the parent router in index.ts
// OR we can mount them here if we duplicate the /api prefix or mount this router at /api
// The main index.ts mounts specific paths. 
// Let's consolidate. If we mount this Main Router at /api:
// /api/auth -> works
// /api/files -> we need to mount filesServingRouter at / 
// because filesServingRouter expects /files/:fileName and /thumbnails/:fileName
router.use("/", filesServingRouter);

export default router;
