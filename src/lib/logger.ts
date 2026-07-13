import pino from "pino";
import { config } from "../config";

// Configuración condicional del logger
const isDevelopment = process.env.NODE_ENV !== "production";

// Defensa en profundidad para objetos estructurados. Los callbacks OAuth ya
// evitan registrar secretos explícitamente, pero esta lista también protege
// futuros logs accidentales de headers o credenciales con nombres comunes.
const redact = {
  paths: [
    "password",
    "token",
    "secret",
    "accessToken",
    "refreshToken",
    "googleAccessToken",
    "authorization",
    "cookie",
    "headers.authorization",
    "headers.cookie",
    "req.headers.authorization",
    "req.headers.cookie",
    "*.password",
    "*.token",
    "*.secret",
    "*.accessToken",
    "*.refreshToken",
    "*.googleAccessToken",
  ],
  censor: "[REDACTED]",
};

const loggerConfig = isDevelopment
  ? {
      level: config.logging.level,
      redact,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
          translateTime: "yyyy-mm-dd HH:MM:ss",
        },
      },
    }
  : {
      level: config.logging.level,
      redact,
      // En producción, usar configuración simple sin transport
      // La mayoría de plataformas cloud capturan console.log automáticamente
    };

export const logger = pino(loggerConfig);
