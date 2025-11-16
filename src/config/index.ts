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
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
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
} as const;
