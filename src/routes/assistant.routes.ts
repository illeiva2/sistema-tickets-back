import { Router } from "express";
import rateLimit from "express-rate-limit";
import AssistantController from "../controllers/assistant.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

// Cada turno del asistente llama a la API de Anthropic (tiene costo).
// Limite defensivo por IP ademas del costo bajo de Haiku.
const assistantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "ASSISTANT_RATE_LIMITED",
      message:
        "Hiciste muchas consultas al asistente. Esperá unos minutos o creá el ticket directamente.",
    },
  },
});

router.get("/status", authMiddleware, AssistantController.status);
router.post("/chat", authMiddleware, assistantLimiter, AssistantController.chat);

export default router;
