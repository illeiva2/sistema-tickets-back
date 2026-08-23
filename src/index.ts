import { config } from "./config";
import { logger } from "./lib/logger";
import { createApp } from "./app";
import LabWatchdog from "./services/lab.watchdog";

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
