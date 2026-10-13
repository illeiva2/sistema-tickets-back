-- Red en vivo (F3.2): clientes Wi-Fi según el controlador UniFi (AP, red, banda, señal).
-- Aditiva: una tabla nueva; no toca datos existentes.

-- CreateTable
CREATE TABLE "network_live_wifi_clients" (
    "id" TEXT NOT NULL,
    "collector" VARCHAR(64) NOT NULL,
    "macAddress" VARCHAR(17) NOT NULL,
    "apDeviceId" TEXT NOT NULL,
    "ssid" VARCHAR(64),
    "band" VARCHAR(8),
    "channel" INTEGER,
    "signal" INTEGER,
    "txKbps" INTEGER,
    "rxKbps" INTEGER,
    "uptimeSeconds" INTEGER,
    "hostname" VARCHAR(120),
    "ipAddress" VARCHAR(45),
    "vlan" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_live_wifi_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "network_live_wifi_clients_apDeviceId_idx" ON "network_live_wifi_clients"("apDeviceId");

-- CreateIndex
CREATE INDEX "network_live_wifi_clients_lastSeenAt_idx" ON "network_live_wifi_clients"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "network_live_wifi_clients_collector_macAddress_key" ON "network_live_wifi_clients"("collector", "macAddress");

-- AddForeignKey
ALTER TABLE "network_live_wifi_clients" ADD CONSTRAINT "network_live_wifi_clients_apDeviceId_fkey" FOREIGN KEY ("apDeviceId") REFERENCES "network_live_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

