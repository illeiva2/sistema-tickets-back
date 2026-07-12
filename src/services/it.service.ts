import { prisma } from "../lib/database";

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
  const [
    peopleTotal,
    peopleActive,
    assetsTotal,
    assetsAssigned,
    assetsInRepair,
    activeAssetAssignments,
    openMaintenances,
    activeSuppliers,
    pendingPurchases,
    phoneLinesTotal,
    phoneLinesInUse,
    activeSites,
    networkDevicesTotal,
    networkDevicesActive,
    agentDevicesTotal,
    agentDevicesOnline,
    activeRemoteSessions,
  ] = await prisma.$transaction([
    prisma.person.count(),
    prisma.person.count({ where: { isActive: true } }),
    prisma.asset.count(),
    prisma.asset.count({ where: { status: "ASSIGNED", isActive: true } }),
    prisma.asset.count({ where: { status: "IN_REPAIR", isActive: true } }),
    prisma.assetAssignment.count({ where: { endAt: null } }),
    prisma.maintenance.count({
      where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
    }),
    prisma.supplier.count({ where: { isActive: true } }),
    prisma.purchase.count({ where: { status: "REQUESTED" } }),
    prisma.phoneLine.count(),
    prisma.phoneLine.count({
      where: { status: "ACTIVE", isActive: true },
    }),
    prisma.site.count({ where: { isActive: true } }),
    prisma.networkDevice.count(),
    prisma.networkDevice.count({
      where: { status: "ACTIVE", isActive: true },
    }),
    prisma.agentDevice.count(),
    prisma.agentDevice.count({
      where: { connState: "ONLINE", isActive: true },
    }),
    prisma.remoteSession.count({ where: { status: "ACTIVE" } }),
  ]);

  return {
    schemaVersion: "it-management-v1",
    generatedAt: new Date().toISOString(),
    counts: {
      people: { total: peopleTotal, active: peopleActive },
      assets: {
        total: assetsTotal,
        assigned: assetsAssigned,
        inRepair: assetsInRepair,
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
        crud: "not_exposed",
        agentGateway: "not_exposed",
        remoteControl: "not_exposed",
      },
      intentionallyNotCounted: [
        "agentInventorySnapshots",
        "agentMetricSamples",
        "deviceVncCredentials",
      ],
    },
  };
};
