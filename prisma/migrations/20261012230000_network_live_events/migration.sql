-- Red en vivo (F3): historial de cambios de la red y alertas (equipo caído, colector mudo).
-- Aditiva: dos tablas nuevas y una columna con valor por defecto; no toca datos existentes.

-- AlterTable
ALTER TABLE "network_live_devices" ADD COLUMN     "alertsMuted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "network_live_events" (
    "id" TEXT NOT NULL,
    "collector" VARCHAR(64) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" VARCHAR(32) NOT NULL,
    "deviceId" TEXT,
    "portKey" VARCHAR(64),
    "macAddress" VARCHAR(17),
    "peerDeviceId" TEXT,
    "peerPortKey" VARCHAR(64),
    "detail" JSONB,

    CONSTRAINT "network_live_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_live_alerts" (
    "id" TEXT NOT NULL,
    "collector" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "deviceId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "ticketId" TEXT,
    "detail" VARCHAR(500),

    CONSTRAINT "network_live_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "network_live_events_at_idx" ON "network_live_events"("at");

-- CreateIndex
CREATE INDEX "network_live_events_deviceId_at_idx" ON "network_live_events"("deviceId", "at");

-- CreateIndex
CREATE INDEX "network_live_events_peerDeviceId_at_idx" ON "network_live_events"("peerDeviceId", "at");

-- CreateIndex
CREATE INDEX "network_live_events_macAddress_at_idx" ON "network_live_events"("macAddress", "at");

-- CreateIndex
CREATE INDEX "network_live_alerts_resolvedAt_idx" ON "network_live_alerts"("resolvedAt");

-- CreateIndex
CREATE INDEX "network_live_alerts_deviceId_openedAt_idx" ON "network_live_alerts"("deviceId", "openedAt");

-- AddForeignKey
ALTER TABLE "network_live_events" ADD CONSTRAINT "network_live_events_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_live_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_live_alerts" ADD CONSTRAINT "network_live_alerts_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_live_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

