import { Router } from "express";
import AttachmentsController from "../controllers/attachments.controller";
import FileOrganizationController from "../controllers/fileOrganization.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

// File Organization Routes
// Mapped to /api/file-organization
export const fileOrganizationRouter = Router();
fileOrganizationRouter.use(authMiddleware);
fileOrganizationRouter.get("/tickets/:ticketId/files", FileOrganizationController.getTicketFiles as any);
fileOrganizationRouter.get("/stats", FileOrganizationController.getFileStats as any);
fileOrganizationRouter.get("/search", FileOrganizationController.searchFiles as any);
fileOrganizationRouter.get("/categories", FileOrganizationController.getCategories as any);
fileOrganizationRouter.get("/tags", FileOrganizationController.getTags as any);

// Serving Routes
// These handle /api/files and /api/thumbnails
// Since they have different prefixes, we can export them as separate small routers or handled in the main router
// But sticking to the grouping logic, I'll export a function to attach them or just export a router that expects to be mounted at /api

export const filesServingRouter = Router();
filesServingRouter.get("/files/:fileName", authMiddleware, AttachmentsController.serveFile as any);
filesServingRouter.get("/thumbnails/:fileName", authMiddleware, AttachmentsController.serveThumbnail as any);
