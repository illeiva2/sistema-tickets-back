import { Router } from "express";
import UiPreferencesController from "../controllers/uiPreferences.controller";
import { authMiddleware } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { saveViewSchema, viewKeySchema } from "../validations/uiPreferences";

/**
 * Preferencias de interfaz del propio usuario (/api/me/ui-preferences).
 * Alcanza con estar autenticado: el id sale del token, así que nadie puede
 * tocar las de otro. Sin rol ni módulo a propósito.
 */
const router = Router();

router.use(authMiddleware);

router.get("/", UiPreferencesController.get);
router.put("/views/:viewKey", validate(saveViewSchema), UiPreferencesController.saveView);
router.delete("/views/:viewKey", validate(viewKeySchema), UiPreferencesController.deleteView);

export default router;
