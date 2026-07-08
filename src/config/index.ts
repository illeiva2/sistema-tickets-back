import dotenv from "dotenv";

dotenv.config();

export const config = {
  database: {
    url: process.env.DATABASE_URL || (() => {
      if (process.env.NODE_ENV === "production") {
        throw new Error("DATABASE_URL is required in production");
      }
      return "postgresql://postgres:postgres@localhost:5432/empresa_tickets";
    })(),
  },
  jwt: {
    secret: process.env.JWT_SECRET || "changeme-in-production",
    expiresIn: process.env.JWT_EXPIRES_IN || "8h",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  },
  server: {
    port: parseInt(process.env.PORT || "3001", 10),
    nodeEnv: process.env.NODE_ENV || "development",
  },
  upload: {
    dir: process.env.UPLOAD_DIR || "uploads",
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || "10485760", 10), // 10MB
  },
  email: {
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port: parseInt(process.env.EMAIL_PORT || "587", 10),
    secure: process.env.EMAIL_SECURE === "true",
    user: process.env.EMAIL_USER || "",
    password: process.env.EMAIL_PASSWORD || "",
    from: process.env.EMAIL_FROM || "noreply@sistema-tickets.com",
  },
  logging: {
    level: process.env.LOG_LEVEL || "info",
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    apiKey: process.env.CLOUDINARY_API_KEY || "",
    apiSecret: process.env.CLOUDINARY_API_SECRET || "",
  },
  // URL pública del frontend, usada en links de emails de notificación.
  // Si no está seteada los emails se mandan sin link clickeable.
  frontendUrl: process.env.FRONTEND_URL || "",
  anthropic: {
    // API key de Anthropic para generar borradores de recursos a partir
    // de tickets resueltos. Si no esta seteada, el endpoint devuelve 503.
    apiKey: process.env.ANTHROPIC_API_KEY || "",
  },
  // Microservicio HTTP de la Base de Conocimiento oficial de Finnegans
  // (proyecto finnegans-kb-mcp -> api.py). Si baseUrl esta vacio, las
  // features de sugerencias de KB quedan deshabilitadas (responden 503).
  finnegansKb: {
    // Ej: "http://127.0.0.1:8077". Dejar en red interna.
    baseUrl: process.env.FINNEGANS_KB_URL || "",
    // Bearer token si el servicio exige auth (FINNEGANS_KB_API_TOKEN alla).
    apiToken: process.env.FINNEGANS_KB_TOKEN || "",
    // Timeout de cada request al servicio (ms).
    timeoutMs: parseInt(process.env.FINNEGANS_KB_TIMEOUT_MS || "8000", 10),
  },
} as const;
