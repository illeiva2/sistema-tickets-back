import { prisma } from "../lib/database";
import { AGENT_ONLINE_THRESHOLD_MS } from "./agents.service";

/**
 * Resumen operativo del schema de Gestión IT.
 *
 * Mantiene separados tres conceptos:
 * - conteos reales persistidos;
 * - dominios ya modelados en Prisma;
 * - superficies API que todavía no se exponen.
 *
 * Deliberadamente no cuenta tablas de alta cardinalidad (métricas y
 * snapshots del agente) ni existencia de credenciales cifradas.
 */
export const getItOverview = async () => {
  const agentOnlineAfter = new Date(Date.now() - AGENT_ONLINE_THRESHOLD_MS);
  const [
    peopleTotal,
    peopleActive,
    assetsTotal,
    assetsAssigned,
    assetsInRepair,
    workstationsTotal,
    phonesTotal,
    activeAssetAssignments,
    openMaintenances,
    activeSuppliers,
    pendingPurchases,
    phoneLinesTotal,
    phoneLinesInUse,
    activeSites,
    networkInfrastructureTotal,
    camerasTotal,
    networkDevicesActive,
    agentDevicesTotal,
    agentDevicesOnline,
    activeRemoteSessions,
  ] = await prisma.$transaction([
    prisma.person.count({ where: { isActive: true, deletedAt: null } }),
    prisma.person.count({
      where: { isActive: true, deletedAt: null, status: "ACTIVE" },
    }),
    prisma.asset.count({ where: { isActive: true, deletedAt: null } }),
    prisma.asset.count({
      where: { status: "ASSIGNED", isActive: true, deletedAt: null },
    }),
    prisma.asset.count({
      where: { status: "IN_REPAIR", isActive: true, deletedAt: null },
    }),
    prisma.asset.count({
      where: {
        isActive: true,
        deletedAt: null,
        type: { in: ["DESKTOP", "NOTEBOOK"] },
      },
    }),
    prisma.asset.count({
      where: { isActive: true, deletedAt: null, type: "PHONE" },
    }),
    prisma.assetAssignment.count({
      where: {
        endAt: null,
        asset: { isActive: true, deletedAt: null },
      },
    }),
    prisma.maintenance.count({
      where: {
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        asset: { isActive: true, deletedAt: null },
      },
    }),
    prisma.supplier.count({ where: { isActive: true, deletedAt: null } }),
    prisma.purchase.count({ where: { status: "REQUESTED" } }),
    prisma.phoneLine.count({ where: { isActive: true, deletedAt: null } }),
    prisma.phoneLine.count({
      where: { status: "ACTIVE", isActive: true, deletedAt: null },
    }),
    prisma.site.count({ where: { isActive: true, deletedAt: null } }),
    prisma.networkDevice.count({
      where: {
        isActive: true,
        deletedAt: null,
        type: { not: "CAMERA" },
      },
    }),
    prisma.networkDevice.count({
      where: { isActive: true, deletedAt: null, type: "CAMERA" },
    }),
    prisma.networkDevice.count({
      where: { status: "ACTIVE", isActive: true, deletedAt: null },
    }),
    prisma.agentDevice.count({ where: { isActive: true, deletedAt: null } }),
    prisma.agentDevice.count({
      where: {
        isActive: true,
        deletedAt: null,
        lastSeenAt: { gte: agentOnlineAfter },
      },
    }),
    prisma.remoteSession.count({
      where: {
        status: "ACTIVE",
        device: { isActive: true, deletedAt: null },
      },
    }),
  ]);

  const networkDevicesTotal = networkInfrastructureTotal + camerasTotal;
  const managedDevicesTotal =
    workstationsTotal + phonesTotal + networkInfrastructureTotal + camerasTotal;

  return {
    schemaVersion: "it-management-v2",
    generatedAt: new Date().toISOString(),
    counts: {
      people: { total: peopleTotal, active: peopleActive },
      assets: {
        total: assetsTotal,
        assigned: assetsAssigned,
        inRepair: assetsInRepair,
      },
      managedDevices: {
        total: managedDevicesTotal,
        workstations: workstationsTotal,
        phones: phonesTotal,
        networkInfrastructure: networkInfrastructureTotal,
        cameras: camerasTotal,
      },
      assetAssignments: { active: activeAssetAssignments },
      maintenances: { open: openMaintenances },
      suppliers: { active: activeSuppliers },
      purchases: { pendingApproval: pendingPurchases },
      phoneLines: { total: phoneLinesTotal, inUse: phoneLinesInUse },
      sites: { active: activeSites },
      networkDevices: {
        total: networkDevicesTotal,
        active: networkDevicesActive,
      },
      agentDevices: {
        total: agentDevicesTotal,
        online: agentDevicesOnline,
      },
      remoteSessions: { active: activeRemoteSessions },
    },
    coverage: {
      crud: {
        people: "available",
        assets: "available",
      },
      modules: {
        inventory: "available",
        people: "available",
        maintenance: "available",
        procurement: "available",
        network: "available",
        monitoring: "available",
        cameras: "limited",
        phoneLines: "available",
      },
      modeledDomains: [
        "people",
        "assets",
        "assetAssignments",
        "maintenances",
        "suppliers",
        "purchases",
        "phoneLines",
        "sites",
        "networkTopology",
        "agentMonitoring",
        "remoteSessions",
      ],
      apiSurface: {
        overview: "available",
        crud: "assets,people,maintenances,procurement,network,phoneLines",
        agentGateway: "available",
        telemetry: "available",
        remoteControl: "available_direct_lan_vpn",
      },
      intentionallyNotCounted: [
        "agentInventorySnapshots",
        "agentMetricSamples",
        "deviceVncCredentials",
      ],
    },
  };
};
