import { Router } from "express";
import rateLimit from "express-rate-limit";
import NetworkLiveController from "../controllers/networkLive.controller";
import { serviceAuthMiddleware } from "../middleware/serviceAuth";

const router = Router();

// El colector manda un envío por minuto. El tope deja lugar a reintentos y a
// correrlo a mano mientras se instala, sin dejar pasar un flood.
const snapshotLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "COLLECTOR_RATE_LIMITED",
      message: "Demasiados envíos del colector; intente nuevamente más tarde",
    },
  },
});

router.post(
  "/snapshot",
  snapshotLimiter,
  serviceAuthMiddleware("network:ingest"),
  ...NetworkLiveController.ingest,
);

export default router;
