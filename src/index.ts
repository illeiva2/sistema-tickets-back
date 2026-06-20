import { config } from "./config";
import { logger } from "./lib/logger";
import { createApp } from "./app";

const app = createApp();
const PORT = config.server.port;

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${config.server.nodeEnv}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
});

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
