-- Migración aditiva generada offline desde fc93dbc^ -> schema actual.
-- No elimina ni transforma datos existentes. No ejecutar mediante db push.
-- Prerrequisito: el schema pre-Gestión-IT de fc93dbc^ ya debe existir.
-- La cadena histórica anterior no materializa todos los modelos hoy desplegados.

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('DESKTOP', 'NOTEBOOK', 'PHONE', 'TABLET', 'MONITOR', 'PRINTER', 'PERIPHERAL', 'NETWORK_DEVICE', 'SERVER', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('IN_STOCK', 'ASSIGNED', 'IN_REPAIR', 'RETIRED', 'LOST');

-- CreateEnum
CREATE TYPE "MaintenanceType" AS ENUM ('PREVENTIVE', 'CORRECTIVE', 'UPGRADE');

-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('ARS', 'USD');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('REQUESTED', 'APPROVED', 'ORDERED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "PhoneCarrier" AS ENUM ('CLARO', 'MOVISTAR', 'PERSONAL', 'TUENTI', 'OTHER');

-- CreateEnum
CREATE TYPE "PhoneLineStatus" AS ENUM ('ACTIVE', 'AVAILABLE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NetworkDeviceType" AS ENUM ('ROUTER', 'SWITCH', 'ACCESS_POINT', 'FIREWALL', 'SERVER', 'NAS', 'PRINTER', 'CAMERA', 'UPS', 'OTHER');

-- CreateEnum
CREATE TYPE "NetworkDeviceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE', 'RETIRED');

-- CreateEnum
CREATE TYPE "NetworkLinkType" AS ENUM ('ETHERNET', 'FIBER', 'WIFI', 'WAN', 'VPN', 'VIRTUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "AgentConnState" AS ENUM ('ONLINE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "RemoteSessionKind" AS ENUM ('SSH', 'VNC');

-- CreateEnum
CREATE TYPE "RemoteSessionStatus" AS ENUM ('ACTIVE', 'CLOSED', 'ERROR');

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "assetId" TEXT;

-- CreateTable
CREATE TABLE "people" (
    "id" TEXT NOT NULL,
    "employeeNumber" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "jobTitle" TEXT,
    "workEmail" TEXT,
    "workPhone" TEXT,
    "status" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "departmentId" TEXT,
    "userId" TEXT,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "assetTag" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'IN_STOCK',
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "serialNumber" TEXT,
    "specs" JSONB,
    "notes" TEXT,
    "secretsRef" TEXT,
    "location" TEXT,
    "warrantyUntil" TIMESTAMP(3),
    "assignedPersonId" TEXT,
    "assignedDepartmentId" TEXT,
    "purchaseItemId" TEXT,
    "retiredAt" TIMESTAMP(3),
    "retirementReason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_assignments" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "personId" TEXT,
    "departmentId" TEXT,
    "assignedById" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" TIMESTAMP(3),
    "note" TEXT,
    "returnNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenances" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" "MaintenanceType" NOT NULL,
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3),
    "performedAt" TIMESTAMP(3),
    "description" TEXT NOT NULL,
    "performedById" TEXT,
    "supplierId" TEXT,
    "costAmount" DECIMAL(14,2),
    "currency" "Currency" NOT NULL DEFAULT 'ARS',
    "parts" JSONB,
    "ticketId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cuit" TEXT,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "address" TEXT,
    "categories" TEXT[],
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "purchaseNumber" SERIAL NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'REQUESTED',
    "supplierId" TEXT,
    "currency" "Currency" NOT NULL DEFAULT 'ARS',
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "exchangeRate" DECIMAL(12,4),
    "justification" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "notes" TEXT,
    "requestedById" TEXT NOT NULL,
    "authorizedById" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "orderedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_items" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_attachments" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_lines" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "carrier" "PhoneCarrier" NOT NULL,
    "carrierOther" TEXT,
    "planName" TEXT,
    "monthlyCost" DECIMAL(10,2),
    "currency" "Currency" NOT NULL DEFAULT 'ARS',
    "simIccid" TEXT,
    "pukCipherText" TEXT,
    "pukIv" TEXT,
    "pukAuthTag" TEXT,
    "pukKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "PhoneLineStatus" NOT NULL DEFAULT 'AVAILABLE',
    "contractEndsAt" TIMESTAMP(3),
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "holderId" TEXT,
    "assetId" TEXT,

    CONSTRAINT "phone_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_line_assignments" (
    "id" TEXT NOT NULL,
    "phoneLineId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "assetId" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" TIMESTAMP(3),
    "note" TEXT,
    "assignedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_line_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "address" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_devices" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "NetworkDeviceType" NOT NULL,
    "status" "NetworkDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "managementIp" TEXT,
    "macAddress" TEXT,
    "vlans" TEXT[],
    "location" TEXT,
    "adminUrl" TEXT,
    "notes" TEXT,
    "secretsRef" TEXT,
    "siteId" TEXT NOT NULL,
    "assetId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_links" (
    "id" TEXT NOT NULL,
    "deviceAId" TEXT NOT NULL,
    "deviceBId" TEXT NOT NULL,
    "portA" TEXT,
    "portB" TEXT,
    "type" "NetworkLinkType" NOT NULL DEFAULT 'ETHERNET',
    "vlans" TEXT[],
    "speedMbps" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_topology_views" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "siteId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "viewport" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_topology_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_topology_node_positions" (
    "id" TEXT NOT NULL,
    "viewId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "network_topology_node_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_devices" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "agentVersion" TEXT,
    "osName" TEXT,
    "osVersion" TEXT,
    "connState" "AgentConnState" NOT NULL DEFAULT 'OFFLINE',
    "lastSeenAt" TIMESTAMP(3),
    "lastEnrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loggedInUser" TEXT,
    "primaryIp" TEXT,
    "primaryMac" TEXT,
    "uptimeSec" INTEGER,
    "cpuPct" DOUBLE PRECISION,
    "ramUsedMb" INTEGER,
    "ramTotalMb" INTEGER,
    "batteryPct" INTEGER,
    "batteryCharging" BOOLEAN,
    "vncRunning" BOOLEAN NOT NULL DEFAULT false,
    "sshRunning" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "assetId" TEXT,

    CONSTRAINT "agent_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_enrollment_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByDeviceId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_enrollment_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_inventory_snapshots" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_inventory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_metric_samples" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "cpuPct" DOUBLE PRECISION,
    "ramUsedMb" INTEGER,
    "diskUsedPct" DOUBLE PRECISION,
    "batteryPct" INTEGER,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_metric_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_sessions" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "RemoteSessionKind" NOT NULL,
    "status" "RemoteSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "clientIp" TEXT,
    "targetHost" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "bytesIn" BIGINT,
    "bytesOut" BIGINT,
    "errorMsg" TEXT,

    CONSTRAINT "remote_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_vnc_credentials" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "cipherText" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "vncPort" INTEGER NOT NULL DEFAULT 5900,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_vnc_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_ui_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'quiet-pro',
    "darkMode" BOOLEAN,
    "itDashboardLayout" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_ui_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tickets_assetId_idx" ON "tickets"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "people_employeeNumber_key" ON "people"("employeeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "people_workEmail_key" ON "people"("workEmail");

-- CreateIndex
CREATE UNIQUE INDEX "people_userId_key" ON "people"("userId");

-- CreateIndex
CREATE INDEX "people_departmentId_status_idx" ON "people"("departmentId", "status");

-- CreateIndex
CREATE INDEX "people_lastName_firstName_idx" ON "people"("lastName", "firstName");

-- CreateIndex
CREATE UNIQUE INDEX "assets_assetTag_key" ON "assets"("assetTag");

-- CreateIndex
CREATE UNIQUE INDEX "assets_serialNumber_key" ON "assets"("serialNumber");

-- CreateIndex
CREATE INDEX "assets_status_type_idx" ON "assets"("status", "type");

-- CreateIndex
CREATE INDEX "assets_assignedPersonId_idx" ON "assets"("assignedPersonId");

-- CreateIndex
CREATE INDEX "assets_assignedDepartmentId_idx" ON "assets"("assignedDepartmentId");

-- CreateIndex
CREATE INDEX "assets_warrantyUntil_idx" ON "assets"("warrantyUntil");

-- CreateIndex
CREATE INDEX "asset_assignments_assetId_endAt_idx" ON "asset_assignments"("assetId", "endAt");

-- CreateIndex
CREATE INDEX "asset_assignments_personId_idx" ON "asset_assignments"("personId");

-- CreateIndex
CREATE INDEX "asset_assignments_departmentId_idx" ON "asset_assignments"("departmentId");

-- CreateIndex
CREATE INDEX "maintenances_assetId_performedAt_idx" ON "maintenances"("assetId", "performedAt");

-- CreateIndex
CREATE INDEX "maintenances_status_scheduledAt_idx" ON "maintenances"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "maintenances_supplierId_idx" ON "maintenances"("supplierId");

-- CreateIndex
CREATE INDEX "maintenances_ticketId_idx" ON "maintenances"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_name_key" ON "suppliers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_cuit_key" ON "suppliers"("cuit");

-- CreateIndex
CREATE INDEX "suppliers_isActive_idx" ON "suppliers"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_purchaseNumber_key" ON "purchases"("purchaseNumber");

-- CreateIndex
CREATE INDEX "purchases_status_createdAt_idx" ON "purchases"("status", "createdAt");

-- CreateIndex
CREATE INDEX "purchases_supplierId_idx" ON "purchases"("supplierId");

-- CreateIndex
CREATE INDEX "purchase_items_purchaseId_idx" ON "purchase_items"("purchaseId");

-- CreateIndex
CREATE INDEX "purchase_attachments_purchaseId_idx" ON "purchase_attachments"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "phone_lines_phoneNumber_key" ON "phone_lines"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "phone_lines_simIccid_key" ON "phone_lines"("simIccid");

-- CreateIndex
CREATE INDEX "phone_lines_status_carrier_idx" ON "phone_lines"("status", "carrier");

-- CreateIndex
CREATE INDEX "phone_lines_holderId_idx" ON "phone_lines"("holderId");

-- CreateIndex
CREATE INDEX "phone_lines_assetId_idx" ON "phone_lines"("assetId");

-- CreateIndex
CREATE INDEX "phone_line_assignments_phoneLineId_assignedAt_idx" ON "phone_line_assignments"("phoneLineId", "assignedAt");

-- CreateIndex
CREATE INDEX "phone_line_assignments_personId_idx" ON "phone_line_assignments"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "sites_name_key" ON "sites"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sites_slug_key" ON "sites"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "network_devices_assetId_key" ON "network_devices"("assetId");

-- CreateIndex
CREATE INDEX "network_devices_siteId_type_idx" ON "network_devices"("siteId", "type");

-- CreateIndex
CREATE INDEX "network_devices_isActive_status_idx" ON "network_devices"("isActive", "status");

-- CreateIndex
CREATE INDEX "network_devices_managementIp_idx" ON "network_devices"("managementIp");

-- CreateIndex
CREATE INDEX "network_devices_macAddress_idx" ON "network_devices"("macAddress");

-- CreateIndex
CREATE INDEX "network_links_deviceAId_idx" ON "network_links"("deviceAId");

-- CreateIndex
CREATE INDEX "network_links_deviceBId_idx" ON "network_links"("deviceBId");

-- CreateIndex
CREATE UNIQUE INDEX "network_links_deviceAId_deviceBId_portA_portB_key" ON "network_links"("deviceAId", "deviceBId", "portA", "portB");

-- CreateIndex
CREATE INDEX "network_topology_views_siteId_idx" ON "network_topology_views"("siteId");

-- CreateIndex
CREATE INDEX "network_topology_node_positions_deviceId_idx" ON "network_topology_node_positions"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "network_topology_node_positions_viewId_deviceId_key" ON "network_topology_node_positions"("viewId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_devices_machineId_key" ON "agent_devices"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_devices_assetId_key" ON "agent_devices"("assetId");

-- CreateIndex
CREATE INDEX "agent_devices_connState_idx" ON "agent_devices"("connState");

-- CreateIndex
CREATE INDEX "agent_devices_hostname_idx" ON "agent_devices"("hostname");

-- CreateIndex
CREATE INDEX "agent_devices_lastSeenAt_idx" ON "agent_devices"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_enrollment_tokens_tokenHash_key" ON "agent_enrollment_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "agent_enrollment_tokens_usedByDeviceId_key" ON "agent_enrollment_tokens"("usedByDeviceId");

-- CreateIndex
CREATE INDEX "agent_enrollment_tokens_expiresAt_idx" ON "agent_enrollment_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "agent_inventory_snapshots_deviceId_createdAt_idx" ON "agent_inventory_snapshots"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_metric_samples_deviceId_sampledAt_idx" ON "agent_metric_samples"("deviceId", "sampledAt");

-- CreateIndex
CREATE INDEX "remote_sessions_deviceId_startedAt_idx" ON "remote_sessions"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "remote_sessions_userId_startedAt_idx" ON "remote_sessions"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "remote_sessions_status_idx" ON "remote_sessions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "device_vnc_credentials_deviceId_key" ON "device_vnc_credentials"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "user_ui_preferences_userId_key" ON "user_ui_preferences"("userId");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_assignedPersonId_fkey" FOREIGN KEY ("assignedPersonId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_assignedDepartmentId_fkey" FOREIGN KEY ("assignedDepartmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "purchase_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_attachments" ADD CONSTRAINT "purchase_attachments_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_attachments" ADD CONSTRAINT "purchase_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_lines" ADD CONSTRAINT "phone_lines_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_lines" ADD CONSTRAINT "phone_lines_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_line_assignments" ADD CONSTRAINT "phone_line_assignments_phoneLineId_fkey" FOREIGN KEY ("phoneLineId") REFERENCES "phone_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_line_assignments" ADD CONSTRAINT "phone_line_assignments_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_line_assignments" ADD CONSTRAINT "phone_line_assignments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_line_assignments" ADD CONSTRAINT "phone_line_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_devices" ADD CONSTRAINT "network_devices_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_devices" ADD CONSTRAINT "network_devices_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_links" ADD CONSTRAINT "network_links_deviceAId_fkey" FOREIGN KEY ("deviceAId") REFERENCES "network_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_links" ADD CONSTRAINT "network_links_deviceBId_fkey" FOREIGN KEY ("deviceBId") REFERENCES "network_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_topology_views" ADD CONSTRAINT "network_topology_views_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_topology_views" ADD CONSTRAINT "network_topology_views_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_topology_node_positions" ADD CONSTRAINT "network_topology_node_positions_viewId_fkey" FOREIGN KEY ("viewId") REFERENCES "network_topology_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_topology_node_positions" ADD CONSTRAINT "network_topology_node_positions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_devices" ADD CONSTRAINT "agent_devices_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_enrollment_tokens" ADD CONSTRAINT "agent_enrollment_tokens_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_enrollment_tokens" ADD CONSTRAINT "agent_enrollment_tokens_usedByDeviceId_fkey" FOREIGN KEY ("usedByDeviceId") REFERENCES "agent_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inventory_snapshots" ADD CONSTRAINT "agent_inventory_snapshots_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "agent_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_metric_samples" ADD CONSTRAINT "agent_metric_samples_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "agent_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "agent_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_vnc_credentials" ADD CONSTRAINT "device_vnc_credentials_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "agent_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_vnc_credentials" ADD CONSTRAINT "device_vnc_credentials_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_ui_preferences" ADD CONSTRAINT "user_ui_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
