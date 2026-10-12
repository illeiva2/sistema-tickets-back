-- Red en vivo: estado que informan los propios equipos de red (router, switches, APs)
-- a través del colector de la planta. Aditiva: sólo crea tablas nuevas y no toca el
-- inventario manual de red (network_devices / network_links) ni ningún dato existente.

-- CreateTable
CREATE TABLE "network_live_devices" (
    "id" TEXT NOT NULL,
    "collector" VARCHAR(64) NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "role" VARCHAR(16) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "managementIp" VARCHAR(45),
    "macAddress" VARCHAR(17),
    "vendor" VARCHAR(60),
    "model" VARCHAR(80),
    "firmware" VARCHAR(80),
    "serialNumber" VARCHAR(80),
    "uptimeSeconds" INTEGER,
    "clients" INTEGER,
    "portKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reachable" BOOLEAN NOT NULL DEFAULT false,
    "lastError" VARCHAR(300),
    "lastPollMs" INTEGER,
    "lastPolledAt" TIMESTAMP(3) NOT NULL,
    "lastOkAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_live_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_live_ports" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(200),
    "position" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "adminUp" BOOLEAN NOT NULL,
    "linkUp" BOOLEAN NOT NULL,
    "speedMbps" INTEGER,
    "fullDuplex" BOOLEAN,
    "pvid" INTEGER,
    "neighbors" JSONB,
    "linkChangedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_live_ports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_live_links" (
    "id" TEXT NOT NULL,
    "collector" VARCHAR(64) NOT NULL,
    "aDeviceId" TEXT NOT NULL,
    "aPorts" TEXT[],
    "bDeviceId" TEXT NOT NULL,
    "bPorts" TEXT[],
    "source" VARCHAR(16) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_live_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_collectors" (
    "slug" VARCHAR(64) NOT NULL,
    "version" VARCHAR(32),
    "host" VARCHAR(64),
    "lastStartedAt" TIMESTAMP(3) NOT NULL,
    "lastFinishedAt" TIMESTAMP(3) NOT NULL,
    "lastReceivedAt" TIMESTAMP(3) NOT NULL,
    "devicesTotal" INTEGER NOT NULL,
    "devicesOk" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "network_collectors_pkey" PRIMARY KEY ("slug")
);

-- CreateIndex
CREATE UNIQUE INDEX "network_live_devices_collector_key_key" ON "network_live_devices"("collector", "key");

-- CreateIndex
CREATE UNIQUE INDEX "network_live_ports_deviceId_key_key" ON "network_live_ports"("deviceId", "key");

-- CreateIndex
CREATE INDEX "network_live_links_collector_idx" ON "network_live_links"("collector");

-- CreateIndex
CREATE INDEX "network_live_links_bDeviceId_idx" ON "network_live_links"("bDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "network_live_links_aDeviceId_bDeviceId_key" ON "network_live_links"("aDeviceId", "bDeviceId");

-- AddForeignKey
ALTER TABLE "network_live_ports" ADD CONSTRAINT "network_live_ports_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_live_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_live_links" ADD CONSTRAINT "network_live_links_aDeviceId_fkey" FOREIGN KEY ("aDeviceId") REFERENCES "network_live_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_live_links" ADD CONSTRAINT "network_live_links_bDeviceId_fkey" FOREIGN KEY ("bDeviceId") REFERENCES "network_live_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

