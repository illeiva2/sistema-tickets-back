import { Router } from "express";
import AttachmentsController from "../controllers/attachments.controller";
import FileOrganizationController from "../controllers/fileOrganization.controller";
import { authMiddleware } from "../middleware/auth";
import multer from "multer";

const router = Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
});

// Attachments
router.get("/:ticketId", authMiddleware, AttachmentsController.list as any);
router.post(
    "/:ticketId",
    authMiddleware,
    upload.single("file"),
    AttachmentsController.upload as any
);
router.delete("/:id", authMiddleware, AttachmentsController.remove as any);
router.get("/:id/info", authMiddleware, AttachmentsController.getInfo as any);
router.get("/:id/exists", authMiddleware, AttachmentsController.checkExists as any);
router.get(
    "/validation/config",
    authMiddleware,
    AttachmentsController.getValidationConfig as any
);

export default router;
