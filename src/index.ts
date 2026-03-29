import express, { Application } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./lib/errors";
import { requestIdMiddleware } from "./middleware/requestId";
import { corsMiddleware } from "./middleware/cors";
import path from "path";
import passport from "./config/passport";
import {
  secureFileServing,
  fileExists,
  authenticateFileAccess,
} from "./middleware/fileServing";
import { prisma } from "./lib/database";
import routes from "./routes";

const app: Application = express();

// Trust proxy (required for rate limiting to work correctly behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS middleware personalizado
app.use(corsMiddleware);

// Rate limiting (solo en producción)
if (config.server.nodeEnv === "production") {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Demasiadas solicitudes, intenta de nuevo más tarde",
      },
    },
  });
  app.use(limiter);
}

// Request parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Passport middleware
app.use(passport.initialize());

// Validate OAuth configuration (only in development)
if (config.server.nodeEnv === "development") {
  import("./config/oauth")
    .then(({ validateOAuthConfig, oauthConfig }) => {
      try {
        validateOAuthConfig();
        logger.info("✅ OAuth configuration validated successfully");
      } catch (error) {
        logger.error({ err: error }, "❌ OAuth configuration validation failed:");
        logger.warn("OAuth features will not work properly");
      }
    })
    .catch((error) => {
      logger.error({ err: error }, "❌ Failed to load OAuth configuration:");
      logger.warn("OAuth features will not work properly");
    });
} else {
  logger.info("🚀 Production mode - OAuth validation skipped");
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.server.nodeEnv,
    version: process.env.npm_package_version || "1.0.0"
  });
});

// Database connection test endpoint
app.get("/debug/db-connection", async (req, res) => {
  try {
    // Test Prisma connection
    await prisma.$queryRaw`SELECT 1 as test`;

    res.status(200).json({
      success: true,
      message: "✅ Database connection successful",
      timestamp: new Date().toISOString(),
      database: "PostgreSQL",
      ssl: "enabled"
    });
  } catch (error) {
    logger.error({ err: error }, "❌ Database connection failed:");
    res.status(500).json({
      success: false,
      message: "❌ Database connection failed",
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: new Date().toISOString(),
      database: "PostgreSQL",
      ssl: "enabled"
    });
  }
});

// Static uploads (Protected)
app.use(
  "/uploads",
  authenticateFileAccess,
  secureFileServing,
  fileExists,
  express.static(path.join(process.cwd(), "uploads")),
);
app.use(
  "/thumbnails",
  authenticateFileAccess,
  express.static(path.join(process.cwd(), "thumbnails")),
);

// Request ID middleware
app.use(requestIdMiddleware);

// API Routes
app.use("/api", routes);

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

// Start server (always in production, conditionally in development)
const PORT = config.server.port;

app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`📊 Environment: ${config.server.nodeEnv}`);
  logger.info(`🔗 Health check: http://localhost:${PORT}/health`);
  logger.info(`🌐 Server accessible at: http://localhost:${PORT}`);
});

// Graceful shutdown handlers
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down gracefully");
  process.exit(0);
});

// Exportar la app (para plataformas serverless)
export { app };
