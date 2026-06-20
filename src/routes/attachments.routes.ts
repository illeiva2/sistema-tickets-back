import { Router } from "express";
import AttachmentsController from "../controllers/attachments.controller";
import FileOrganizationController from "../controllers/fileOrganization.controller";
import { authMiddleware, requireRole } from "../middleware/auth";
import { fixFilenameEncoding } from "../middleware/fixFilenameEncoding";
import { UserRole } from "@prisma/client";
import multer from "multer";

const router = Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
});

// Attachments
router.get("/:ticketId", authMiddleware, AttachmentsController.list);
router.post(
    "/:ticketId",
    authMiddleware,
    upload.single("file"),
    fixFilenameEncoding,
    AttachmentsController.upload
);
router.delete(
    "/:id",
    authMiddleware,
    requireRole([UserRole.ADMIN]),
    AttachmentsController.remove
);
router.get("/:id/info", authMiddleware, AttachmentsController.getInfo);
router.get("/:id/exists", authMiddleware, AttachmentsController.checkExists);
router.get(
    "/validation/config",
    authMiddleware,
    AttachmentsController.getValidationConfig
);

export default router;
