import { Router } from "express";
import rateLimit from "express-rate-limit";
import LabController from "../controllers/lab.controller";
import LabQueryController from "../controllers/lab.query.controller";
import LabSamplesController from "../controllers/lab.samples.controller";
import LabProductoresController from "../controllers/lab.productores.controller";
import LabAssistantController from "../controllers/lab.assistant.controller";
import LabWatchdog from "../services/lab.watchdog";
import { serviceAuthMiddleware } from "../middleware/serviceAuth";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/requireModule";
import { validate } from "../middleware/validation";
import { heartbeatSchema, ingestBatchSchema, reconcileSchema } from "../validations/lab";
import {
  createFieldDefSchema,
  createSampleSchema,
  updateFieldDefSchema,
  updateSampleSchema,
} from "../validations/lab.samples";
import { askSchema, jobResultSchema, nextJobSchema } from "../validations/lab.assistant";

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

// ─── Relé del asistente: el modelo local del molino, no personas ──────────────
// Pide trabajo con long-poll y devuelve el turno del modelo. Misma credencial
// de servicio que la ingesta, con su propio scope: el relé no puede empujar
// mediciones ni el pusher pedir trabajos.
router.get(
  "/assistant/jobs/next",
  ingestLimiter,
  serviceAuthMiddleware("lab:llm"),
  validate(nextJobSchema),
  LabAssistantController.nextJob,
);
router.post(
  "/assistant/jobs/:id/result",
  ingestLimiter,
  serviceAuthMiddleware("lab:llm"),
  validate(jobResultSchema),
  LabAssistantController.jobResult,
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

// ─── Registro de muestras ────────────────────────────────────────────────────
// Leer lo puede cualquiera con el módulo. Registrar y editar muestras exige QC
// (es una escritura sobre datos de calidad); tocar el catálogo de campos exige
// MANAGEMENT, porque cambia qué le pide el formulario a todo el laboratorio.
// El requireModule con nivel va POR RUTA, encima del de arriba: la puerta
// general sigue siendo una sola y esto solo la aprieta.
router.get("/samples/kinds", LabSamplesController.kinds);
router.get("/samples/summary", LabSamplesController.summary);
router.get("/samples/daily-report", LabSamplesController.dailyReport);
// Grilla de consulta para comercio: lectura, como la lista.
router.get("/samples/grid", LabSamplesController.grid);
// Sugerencias para un campo de la ficha (valores ya cargados).
router.get("/samples/suggest", LabSamplesController.suggest);
router.get("/samples", LabSamplesController.list);
router.post(
  "/samples",
  requireModule("glutenlab", "QC"),
  validate(createSampleSchema),
  LabSamplesController.create,
);
// Re-enlaza mediciones sueltas cuya accesión ahora sí existe. Inofensivo y
// repetible; MANAGEMENT porque toca datos de calidad en masa.
router.post(
  "/samples/relink",
  requireModule("glutenlab", "MANAGEMENT"),
  LabSamplesController.relink,
);
// Después de las literales ("/samples/kinds", "/samples/summary"): si fuera
// antes, "kinds" entraría acá como accesión y daría 400.
router.get("/samples/:accession", LabSamplesController.getByAccession);
router.patch(
  "/samples/:id",
  requireModule("glutenlab", "QC"),
  validate(updateSampleSchema),
  LabSamplesController.update,
);

router.post(
  "/samples/kinds/:kindId/fields",
  requireModule("glutenlab", "MANAGEMENT"),
  validate(createFieldDefSchema),
  LabSamplesController.createFieldDef,
);
router.patch(
  "/samples/fields/:id",
  requireModule("glutenlab", "MANAGEMENT"),
  validate(updateFieldDefSchema),
  LabSamplesController.updateFieldDef,
);

// Lista de empresas de granos del ERP (la carga el job nocturno). Lectura para
// cualquiera con el módulo: el catálogo muestra si está al día.
router.get("/productores/status", LabProductoresController.status);

// ─── Asistente: preguntas en lenguaje natural sobre los análisis ─────────────
// Lo usa cualquiera con el módulo (las herramientas son de lectura). Cada
// pregunta ocupa al modelo del molino varios segundos: límite por IP para que
// una pestaña con un bucle no lo monopolice. La oficina comparte IP, así que es
// generoso; el service además admite UNA consulta en curso por usuario.
const assistantLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
router.get("/assistant/status", LabAssistantController.status);
router.post("/assistant/ask", assistantLimiter, validate(askSchema), LabAssistantController.ask);
router.get("/assistant/requests/:id", LabAssistantController.get);

export default router;
