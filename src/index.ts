import express, { Application } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./lib/errors";
import { requestIdMiddleware } from "./middleware/requestId";
import { corsMiddleware } from "./middleware/cors";
import { AuthController } from "./controllers/auth.controller";
import { TicketsController } from "./controllers/tickets.controller";
import { CommentsController } from "./controllers/comments.controller";
import { UsersController } from "./controllers/users.controller";
import multer from "multer";
import path from "path";
import AttachmentsController from "./controllers/attachments.controller";
import DashboardController from "./controllers/dashboard.controller";
import { NotificationsController } from "./controllers/notifications.controller";
import { authMiddleware, requireRole } from "./middleware/auth";
import passport from "./config/passport";
import { OAuthController } from "./controllers/oauth.controller";
import {
  secureFileServing,
  fileExists,
  authenticateFileAccess,
} from "./middleware/fileServing";
import FileOrganizationController from "./controllers/fileOrganization.controller";
import { UserRole } from "@prisma/client";
import { prisma } from "./lib/database";

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
        logger.info("🔍 OAuth Debug Info:");
        logger.info(
          "  - Client ID:",
          oauthConfig.google.clientID ? "✅ Presente" : "❌ FALTANTE",
        );
        logger.info(
          "  - Client Secret:",
          oauthConfig.google.clientSecret ? "✅ Presente" : "❌ FALTANTE",
        );
        logger.info("  - Callback URL:", oauthConfig.google.callbackURL);
        logger.info("  - Scope:", oauthConfig.google.scope);
      } catch (error) {
        logger.error("❌ OAuth configuration validation failed:", error);
        logger.warn("OAuth features will not work properly");
      }
    })
    .catch((error) => {
      logger.error("❌ Failed to load OAuth configuration:", error);
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
    logger.error("❌ Database connection failed:", error);
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

// Static uploads
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

// Ruta para servir archivos con autenticación (para vistas previas)
app.get(
  "/api/files/:fileName",
  authMiddleware,
  AttachmentsController.serveFile,
);

// Ruta para servir thumbnails con autenticación
app.get(
  "/api/thumbnails/:fileName",
  authMiddleware,
  AttachmentsController.serveThumbnail,
);

// Request ID middleware
app.use(requestIdMiddleware);

// API Routes
app.use(
  "/api/auth",
  express
    .Router()
    .post("/login", AuthController.login as any)
    .post("/register", AuthController.register as any)
    .post("/setup-password", AuthController.setupPassword as any)
    .post("/refresh", AuthController.refreshToken as any)
    .get("/me", authMiddleware, AuthController.me as any),
);

app.use(
  "/api/dashboard",
  express
    .Router()
    .get("/stats", authMiddleware, DashboardController.stats as any)
    .get("/agent-stats", authMiddleware, DashboardController.agentStats as any)
    .get("/user-stats", authMiddleware, DashboardController.userStats as any),
);

app.use(
  "/api/tickets",
  express
    .Router()
    .get("/", authMiddleware, TicketsController.getTickets as any)
    .get("/:id", authMiddleware, TicketsController.getTicketById as any)
    .post("/", authMiddleware, TicketsController.createTicket as any)
    .patch("/:id", authMiddleware, TicketsController.updateTicket as any)
    .post("/:id/close", authMiddleware, TicketsController.closeTicket as any)
    .post("/:id/reopen", authMiddleware, TicketsController.reopenTicket as any)
    .delete(
      "/:id",
      authMiddleware,
      requireRole([UserRole.ADMIN]),
      TicketsController.deleteTicket as any,
    )
    .get("/:ticketId/comments", authMiddleware, CommentsController.list as any)
    .post(
      "/:ticketId/comments",
      authMiddleware,
      CommentsController.create as any,
    ),
);

app.use(
  "/api/users",
  express
    .Router()
    .get("/", authMiddleware, UsersController.listUsers as any)
    .get("/agents", authMiddleware, UsersController.listAgents as any)
    .get("/:id", authMiddleware, UsersController.getUserById as any)
    .post("/", authMiddleware, UsersController.createUser as any)
    .patch("/:id", authMiddleware, UsersController.updateUser as any)
    .patch(
      "/:id/password",
      authMiddleware,
      UsersController.changePassword as any,
    )
    .post(
      "/:id/reset-password",
      authMiddleware,
      UsersController.resetPassword as any,
    )
    .delete("/:id", authMiddleware, UsersController.deleteUser as any)
    .get("/:id/stats", authMiddleware, UsersController.getUserStats as any),
);

app.use(
  "/api/notifications",
  express
    .Router()
    .get(
      "/debug-config",
      authMiddleware,
      NotificationsController.debugConfig as any,
    )
    .get(
      "/test-connection",
      authMiddleware,
      NotificationsController.testConnection as any,
    )
    .post(
      "/test-email",
      authMiddleware,
      NotificationsController.sendTestEmail as any,
    )
    .get(
      "/user",
      authMiddleware,
      NotificationsController.getUserNotifications as any,
    )
    .patch(
      "/:id/read",
      authMiddleware,
      NotificationsController.markAsRead as any,
    )
    .patch(
      "/mark-all-read",
      authMiddleware,
      NotificationsController.markAllAsRead as any,
    )
    .get(
      "/preferences",
      authMiddleware,
      NotificationsController.getUserPreferences as any,
    )
    .patch(
      "/preferences",
      authMiddleware,
      NotificationsController.updateUserPreferences as any,
    ),
);

// Rutas de organización de archivos
app.use("/api/file-organization", authMiddleware, (req, res, next) => {
  const router = express.Router();

  // Archivos básicos
  router.get("/tickets/:ticketId/files", FileOrganizationController.getTicketFiles);
  router.get("/stats", FileOrganizationController.getFileStats);
  router.get("/search", FileOrganizationController.searchFiles);

  router(req, res, next);
});

// OAuth routes
app.get("/api/auth/google", OAuthController.initiateGoogleAuth);
app.get("/api/auth/google/callback", OAuthController.googleCallback);
app.post("/api/auth/refresh", OAuthController.refreshToken);
app.post("/api/auth/logout", OAuthController.logout);

// Attachments routes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
app.use(
  "/api/attachments",
  express
    .Router()
    .get("/:ticketId", authMiddleware, AttachmentsController.list)
    .post(
      "/:ticketId",
      authMiddleware,
      upload.single("file"),
      AttachmentsController.upload,
    )
    .delete("/:id", authMiddleware, AttachmentsController.remove)
    .get("/:id/info", authMiddleware, AttachmentsController.getInfo)
    .get("/:id/exists", authMiddleware, AttachmentsController.checkExists)
    .get(
      "/validation/config",
      authMiddleware,
      AttachmentsController.getValidationConfig,
    ),
);

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
