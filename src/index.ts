import { config } from "./config";
import { logger } from "./lib/logger";
import { createApp } from "./app";
import LabWatchdog from "./services/lab.watchdog";
import LabAssistantService from "./services/lab.assistant.service";

const app = createApp();
const PORT = config.server.port;

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${config.server.nodeEnv}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
});

// ─── Watchdog del espejo de laboratorio ──────────────────────────────────────
// Cada 5 min, desfasado 60 s del arranque para no competir con el warm-up.
//
// OJO con lo que esto NO garantiza: corre dentro de este proceso, así que si el
// servicio se duerme o se cae, el watchdog se va con él — justo cuando haría
// falta. La red que sobrevive a eso es el dead-man switch externo, que se
// pinguea desde el heartbeat, más el POST /api/glutenlab/watchdog/run para que
// un cron de afuera pueda manejarlo igual.
const LAB_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

setTimeout(() => {
  const tick = () => {
    void LabWatchdog.run().catch((err) =>
      logger.error({ err }, "Falló una corrida del watchdog de laboratorio"),
    );
  };
  tick();
  const timer = setInterval(tick, LAB_WATCHDOG_INTERVAL_MS);
  // unref: un timer pendiente no debe impedir que el proceso termine cuando
  // Render manda SIGTERM.
  timer.unref();
  logger.info("Watchdog de laboratorio activo (cada 5 min)");
}, 60_000).unref();

// ─── Asistente de laboratorio: consultas colgadas ────────────────────────────
// El relé del molino vence lo colgado cada vez que pide trabajo; pero si el
// relé está caído nadie pide trabajo, y alguien tiene que decirle al usuario
// que se acabó la espera. Ese alguien es este barrido.
const LAB_ASSISTANT_SWEEP_MS = 30_000;

setTimeout(() => {
  const tick = () => {
    void LabAssistantService.sweep().catch((err) =>
      logger.error({ err }, "Falló el barrido del asistente de laboratorio"),
    );
  };
  const timer = setInterval(tick, LAB_ASSISTANT_SWEEP_MS);
  timer.unref();
}, 45_000).unref();

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down gracefully");
  process.exit(0);
});

// Re-export para compat con cualquier código que esperaba
// `import { app } from "./index"`.
export { app };
