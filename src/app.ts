import express, { Application } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { config } from "./config";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./lib/errors";
import { requestIdMiddleware } from "./middleware/requestId";
import { corsMiddleware } from "./middleware/cors";
import passport from "./config/passport";
import {
  secureFileServing,
  fileExists,
  authenticateFileAccess,
} from "./middleware/fileServing";
import { prisma } from "./lib/database";
import routes from "./routes";

export const shouldSkipGlobalRateLimit = (pathName: string) =>
  pathName === "/health" ||
  pathName === "/api/auth/me" ||
  pathName.startsWith("/api/agent/") ||
  pathName.startsWith("/uploads") ||
  pathName.startsWith("/thumbnails");

/**
 * Construye la app Express con toda la configuración (middlewares, rutas,
 * error handlers). NO arranca el servidor: eso es responsabilidad de
 * src/index.ts. Esta separación permite que los tests instancien la app
 * con supertest sin colgar un puerto real.
 */
export const createApp = (): Application => {
  const app = express();

  // Trust proxy (rate limit detrás de Render).
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(corsMiddleware);

  // Rate limiting solo en producción.
  if (config.server.nodeEnv === "production") {
    const tooManyRequests = {
      success: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Demasiadas solicitudes, intenta de nuevo más tarde",
      },
    };

    const loginLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: tooManyRequests,
    });
    app.use("/api/auth/login", loginLimiter);

    const globalLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      message: tooManyRequests,
      skip: (req) => {
        const p = req.path;
        return shouldSkipGlobalRateLimit(p);
      },
    });
    app.use(globalLimiter);
  }

  // El gateway público del agente tiene un límite propio antes del parser
  // general. express.json marca el request como parseado y el parser siguiente
  // no vuelve a procesarlo.
  app.use("/api/agent", express.json({ limit: "512kb" }));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(passport.initialize());

  // OAuth config validation (dev only).
  if (config.server.nodeEnv === "development") {
    import("./config/oauth")
      .then(({ validateOAuthConfig }) => {
        try {
          validateOAuthConfig();
          logger.info("OAuth configuration validated");
        } catch (error) {
          logger.error({ err: error }, "OAuth configuration validation failed");
        }
      })
      .catch((error) => {
        logger.error({ err: error }, "Failed to load OAuth configuration");
      });
  }

  // Health check.
  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.server.nodeEnv,
      version: process.env.npm_package_version || "1.0.0",
    });
  });

  // Diagnóstico de DB sólo local: en staging/producción el detalle de un
  // error de conexión no debe quedar expuesto en un endpoint público.
  if (config.server.nodeEnv !== "production") {
    app.get("/debug/db-connection", async (_req, res) => {
      try {
        await prisma.$queryRaw`SELECT 1 as test`;
        res.status(200).json({
          success: true,
          message: "Database connection successful",
          timestamp: new Date().toISOString(),
          database: "PostgreSQL",
        });
      } catch (error) {
        logger.error({ err: error }, "Database connection failed");
        res.status(500).json({
          success: false,
          message: "Database connection failed",
        });
      }
    });
  }

  // Static uploads (protegidos).
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

  app.use(requestIdMiddleware);
  app.use("/api", routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
