-- Red en vivo (F2): equipos finales (PCs, impresoras, cámaras, teléfonos) vistos en cada puerto
-- de acceso, deducidos por el colector de las tablas MAC. Aditiva: sólo crea una tabla nueva.

-- CreateTable
CREATE TABLE "network_live_endpoints" (
    "id" TEXT NOT NULL,
    "collector" VARCHAR(64) NOT NULL,
    "macAddress" VARCHAR(17) NOT NULL,
    "deviceId" TEXT NOT NULL,
    "portKey" VARCHAR(64) NOT NULL,
    "vlan" INTEGER,
    "ipAddress" VARCHAR(45),
    "hostname" VARCHAR(120),
    "viaDeviceId" TEXT,
    "sharedPort" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "movedAt" TIMESTAMP(3),

    CONSTRAINT "network_live_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "network_live_endpoints_deviceId_portKey_idx" ON "network_live_endpoints"("deviceId", "portKey");

-- CreateIndex
CREATE INDEX "network_live_endpoints_ipAddress_idx" ON "network_live_endpoints"("ipAddress");

-- CreateIndex
CREATE INDEX "network_live_endpoints_lastSeenAt_idx" ON "network_live_endpoints"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "network_live_endpoints_collector_macAddress_key" ON "network_live_endpoints"("collector", "macAddress");

-- AddForeignKey
ALTER TABLE "network_live_endpoints" ADD CONSTRAINT "network_live_endpoints_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_live_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_live_endpoints" ADD CONSTRAINT "network_live_endpoints_viaDeviceId_fkey" FOREIGN KEY ("viaDeviceId") REFERENCES "network_live_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

