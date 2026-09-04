import { Router } from "express";
import rateLimit from "express-rate-limit";
import LabController from "../controllers/lab.controller";
import LabQueryController from "../controllers/lab.query.controller";
import LabWatchdog from "../services/lab.watchdog";
import { serviceAuthMiddleware } from "../middleware/serviceAuth";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/requireModule";
import { validate } from "../middleware/validation";
import { heartbeatSchema, ingestBatchSchema, reconcileSchema } from "../validations/lab";

const router = Router();

// Un solo agente late cada 5 min; el backfill manda lotes seguidos. El tope es
// holgado para no frenar una recuperación legítima, pero acota un flood.
const ingestLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Ingesta: la usa el agente del molino, no personas ───────────────────────
router.post(
  "/ingest/batch",
  ingestLimiter,
  serviceAuthMiddleware("lab:ingest"),
  validate(ingestBatchSchema),
  LabController.ingestBatch,
);

router.post(
  "/ingest/heartbeat",
  ingestLimiter,
  serviceAuthMiddleware("lab:ingest"),
  validate(heartbeatSchema),
  LabController.heartbeat,
);

router.post(
  "/ingest/reconcile",
  ingestLimiter,
  serviceAuthMiddleware("lab:ingest"),
  validate(reconcileSchema),
  LabController.reconcile,
);

router.get(
  "/ingest/cursor",
  ingestLimiter,
  serviceAuthMiddleware("lab:ingest"),
  LabController.cursor,
);

// Disparo del watchdog desde afuera. Existe porque el watchdog interno vive en
// el mismo proceso que puede morir: un cron externo puede manejarlo igual.
// Protegido por la misma credencial de servicio.
router.post(
  "/watchdog/run",
  ingestLimiter,
  serviceAuthMiddleware("lab:ingest"),
  async (_req, res, next) => {
    try {
      res.json({ success: true, data: await LabWatchdog.run() });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Lectura: personas con el módulo habilitado ──────────────────────────────
// La salud del espejo la ve cualquiera que tenga acceso al módulo: el banner de
// frescura tiene que estar en pantalla para todos, no solo para administradores.
router.get(
  "/health",
  authMiddleware,
  requireModule("glutenlab"),
  LabController.health,
);

// Las consultas del panel comparten la misma puerta. Se declara UNA vez con
// router.use y no repetida en cada ruta: asi no se puede agregar un endpoint
// nuevo y olvidarse del requireModule. Ese olvido no daria ningun error, solo
// dejaria los datos del laboratorio abiertos a cualquier usuario logueado.
router.use(authMiddleware, requireModule("glutenlab"));

router.get("/equipment", LabQueryController.equipos);
router.get("/methods", LabQueryController.metodos);
router.get("/dashboard/summary", LabQueryController.resumen);

router.get("/measurements", LabQueryController.mediciones);
router.get("/measurements/stats", LabQueryController.estadisticas);
router.get("/measurements/flour-stats", LabQueryController.harinas);
router.get("/measurements/trend", LabQueryController.tendenciaDiaria);
router.get("/measurements/trend/monthly", LabQueryController.tendenciaMensual);
// Va DESPUES de las rutas literales: si fuera antes, "/measurements/stats"
// entraria por aca con id = "stats".
router.get("/measurements/:id/details", LabQueryController.detalle);

router.get("/nir/products", LabQueryController.nirProductos);
router.get("/nir/measurements", LabQueryController.nirMediciones);
router.get("/nir/stats", LabQueryController.nirEstadisticas);
router.get("/nir/trend", LabQueryController.nirTendencia);

router.get("/fn/stats", LabQueryController.fnEstadisticas);
router.get("/fn/measurements", LabQueryController.fnMediciones);
router.get("/fn/trend", LabQueryController.fnTendencia);

router.get("/sdmatic/stats", LabQueryController.sdmaticEstadisticas);
router.get("/sdmatic/measurements", LabQueryController.sdmaticMediciones);
router.get("/sdmatic/trend", LabQueryController.sdmaticTendencia);

router.get("/alveolab/stats", LabQueryController.alveolabEstadisticas);
router.get("/alveolab/measurements", LabQueryController.alveolabMediciones);
router.get("/alveolab/trend", LabQueryController.alveolabTendencia);

export default router;
