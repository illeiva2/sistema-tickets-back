import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

// Debug database connection
logger.info("🔍 Database connection debug:");
logger.info("  - DATABASE_URL:", process.env.DATABASE_URL ? "✅ Presente" : "❌ FALTANTE");
logger.info("  - NODE_ENV:", process.env.NODE_ENV);
logger.info("  - PORT:", process.env.PORT);

const prisma = new PrismaClient({
  log: [
    {
      emit: "event",
      level: "query",
    },
    {
      emit: "event",
      level: "error",
    },
    {
      emit: "event",
      level: "info",
    },
    {
      emit: "event",
      level: "warn",
    },
  ],
});

// Log queries in development
if (process.env.NODE_ENV === "development") {
  prisma.$on("query", (e: any) => {
    logger.debug("Query: " + e.query);
    logger.debug("Params: " + e.params);
    logger.debug("Duration: " + e.duration + "ms");
  });
}

prisma.$on("error", (e: any) => {
  logger.error("Prisma error: " + e.message);
});

export { prisma };
