import { Router } from "express";
import multer from "multer";
import { ResourcesController } from "../controllers/resources.controller";
import { authMiddleware, requireRole } from "../middleware/auth";
import { UserRole } from "@prisma/client";

const router = Router();

// Upload de imagenes embebidas en el markdown. memoryStorage + 10MB max,
// mismo patron que attachments.routes.ts. El MIME se valida en el service.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Endpoints de lectura (todos los autenticados):
router.get("/", authMiddleware, ResourcesController.list);
router.get("/suggest", authMiddleware, ResourcesController.suggest);
router.get("/pinned", authMiddleware, ResourcesController.getPinned);
router.get(
  "/modal-pinned",
  authMiddleware,
  ResourcesController.getModalPinned,
);
router.get(
  "/for-my-department",
  authMiddleware,
  ResourcesController.getForMyDepartment,
);
router.get("/:idOrSlug", authMiddleware, ResourcesController.getOne);

// IA: generar borrador a partir de un ticket resuelto (AGENT o ADMIN).
router.post(
  "/draft-from-ticket/:ticketId",
  authMiddleware,
  requireRole([UserRole.AGENT, UserRole.ADMIN]),
  ResourcesController.draftFromTicket,
);

// Upload de imagenes embebidas en el markdown (solo ADMIN, mismo permiso
// que crear/editar recursos).
router.post(
  "/upload-image",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  imageUpload.single("file"),
  ResourcesController.uploadImage,
);

// Mutaciones (solo ADMIN por ahora; AGENT puede sumarse en el futuro):
router.post(
  "/",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  ResourcesController.create,
);
router.patch(
  "/:id",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  ResourcesController.update,
);
router.delete(
  "/:id",
  authMiddleware,
  requireRole([UserRole.ADMIN]),
  ResourcesController.remove,
);

export default router;
