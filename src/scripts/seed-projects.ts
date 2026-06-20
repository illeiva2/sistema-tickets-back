// Seed inicial de proyectos en curso del equipo de IT.
// Corré con: npx tsx src/scripts/seed-projects.ts
//
// Idempotente: upsert por slug. Lead default = primer ADMIN activo del
// sistema. Después se puede editar lead/team desde la UI.

import { prisma } from "../lib/database";
import { logger } from "../lib/logger";
import { UserRole } from "@prisma/client";

interface ProjectSeed {
  slug: string;
  title: string;
  excerpt: string;
  description: string;
  status:
    | "PLANNED"
    | "IN_PROGRESS"
    | "ON_HOLD"
    | "BLOCKED"
    | "COMPLETED"
    | "CANCELLED";
  progressPercent?: number;
  isPinned?: boolean;
}

const PROJECTS: ProjectSeed[] = [
  {
    slug: "portal-de-granos-grf",
    title: "Portal de granos GRF",
    excerpt:
      "Portal web para gestión y consulta de operaciones de granos. Finalizando la primera etapa de implementación de contratos.",
    description: `# Portal de granos GRF

Portal web para que productores y operadores consulten y gestionen operaciones de granos
directamente desde un solo lugar.

## Etapa actual

Estamos **finalizando la primera etapa** centrada en la **implementación de contratos**:
visualización de contratos vigentes, estado de cumplimiento y trazabilidad por operación.

## Próximos pasos

- Cierre de la etapa 1 (contratos) y pasaje a UAT con usuarios clave.
- Etapa 2: integración con liquidaciones y cartas de porte.
- Etapa 3: notificaciones a productores y dashboard de KPIs.

## Para qué les sirve

Reemplaza el ida y vuelta por mail / Excel actuales por un portal único con info al día,
historial y trazabilidad.
`,
    status: "IN_PROGRESS",
    progressPercent: 20,
    isPinned: true,
  },
  {
    slug: "control-mantenimientos-taller",
    title: "Control de mantenimientos de taller",
    excerpt:
      "Sistema de control y registro de mantenimientos del taller de maquinarias. En proceso de rework por cambio de scope.",
    description: `# Control de mantenimientos de taller

Sistema implementado para registrar rutinas y partes de mantenimiento de las maquinarias
del taller, con historial por equipo y alertas de vencimiento.

## Estado actual

La primera versión está **operativa** desde hace un tiempo, pero entramos en **rework**
por un **cambio de scope** que apareció durante el uso:

- Se necesita modelar trabajos planificados separados de los reactivos.
- Refinar la gestión de partes con foto y firma del operador.
- Reportes mensuales por maquinaria.

## Próximos pasos

- Cerrar el rediseño del flujo de partes con el responsable del taller.
- Migración de datos históricos del sistema previo.
- Capacitación del personal con los nuevos cambios.
`,
    status: "IN_PROGRESS",
  },
  {
    slug: "cableado-de-oficinas",
    title: "Cableado de oficinas",
    excerpt:
      "Renovación de cableado estructurado de oficinas. 70% completado: falta reubicar un rack e instalar dispositivos en datacenter.",
    description: `# Cableado de oficinas

Renovación del cableado estructurado de oficinas y datacenter para soportar las
necesidades de red actuales (más puestos, más cámaras, más servicios).

## Lo que ya está hecho

- ✅ Cableado nuevo de las oficinas principales.
- ✅ Patchera y switches reemplazados.
- ✅ Etiquetado y documentación del nuevo layout.

## Lo que falta (≈30%)

- Reubicación del rack al lugar definitivo.
- Instalación de los dispositivos finales en el datacenter (switches de
  agregación, UPS nuevo y firewall reemplazo).
- Pruebas finales de continuidad y certificación de puntos.

## Cuándo

Estimado de cierre: próximas 2-3 semanas, sujeto a coordinación con el área de obra.
`,
    status: "IN_PROGRESS",
    progressPercent: 70,
  },
  {
    slug: "aplicativos-cocina",
    title: "Aplicativos cocina",
    excerpt:
      "Set de 4 aplicaciones para la cocina: atención al público, venta de productos a empleados, pedidos de viandas y visualización en TV.",
    description: `# Aplicativos cocina

Conjunto de 4 aplicaciones que vamos a desplegar para la cocina, cada una con su scope
propio y desarrollo independiente:

## Alcance 1 — Atención al público
App para registrar y gestionar la atención al público en barra/comedor, con tickets,
turnos y cobros.

## Alcance 2 — Venta de productos a empleados
Catálogo y carga rápida para vender productos a empleados con descuento o cuenta
corriente, integrado con sueldos.

## Alcance 3 — Pedidos de viandas, sopas y ensaladas
Aplicativo para que los empleados pidan su vianda del día (con cierre de pedido
anticipado), y para que la cocina vea el total a preparar.

## Alcance 4 — Visualización de pedidos en TV de cocina
Pantalla en cocina que muestra en tiempo real los pedidos pendientes,
priorizando por hora de entrega.

## Estado

Cada alcance va con su propio desarrollo, en paralelo según prioridad acordada con
el equipo de cocina.
`,
    status: "IN_PROGRESS",
  },
  {
    slug: "glutenlab",
    title: "Desarrollo de Glutenlab",
    excerpt:
      "Programa para visualizar resultados de mediciones de gluten en trigo. 90% completo, en fase final de ajustes.",
    description: `# Desarrollo de Glutenlab

Programa para **visualizar resultados de mediciones de gluten en trigo**, con
históricos por lote/origen y exportación de informes.

## Estado actual

Estamos al **90%**: la lógica principal está cerrada, los reportes funcionan y se
están haciendo los últimos ajustes con el laboratorio antes del despliegue final.

## Lo que falta

- Validación final con el responsable del laboratorio.
- Ajustes menores de UI según feedback de pruebas.
- Documentación de uso para los operadores.

## Próximos pasos

Despliegue interno y capacitación corta al equipo del laboratorio.
`,
    status: "IN_PROGRESS",
    progressPercent: 90,
  },
];

async function main() {
  // Buscamos el primer ADMIN activo para usarlo como lead default.
  const lead = await prisma.user.findFirst({
    where: { role: UserRole.ADMIN, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!lead) {
    throw new Error(
      "No se encontró ningún ADMIN activo para asignar como lead. Creá uno primero.",
    );
  }
  logger.info({ leadId: lead.id, leadEmail: lead.email }, "Lead seleccionado");

  for (const p of PROJECTS) {
    const existing = await prisma.project.findUnique({
      where: { slug: p.slug },
      select: { id: true },
    });

    if (existing) {
      await prisma.project.update({
        where: { slug: p.slug },
        data: {
          title: p.title,
          description: p.description,
          excerpt: p.excerpt,
          status: p.status,
          progressPercent: p.progressPercent ?? null,
          isPublished: true,
          isPinned: p.isPinned ?? false,
        },
      });
      logger.info({ slug: p.slug }, "Project updated");
    } else {
      await prisma.project.create({
        data: {
          slug: p.slug,
          title: p.title,
          description: p.description,
          excerpt: p.excerpt,
          status: p.status,
          progressPercent: p.progressPercent ?? null,
          isPublished: true,
          isPinned: p.isPinned ?? false,
          leadId: lead.id,
          startedAt: new Date(),
        },
      });
      logger.info({ slug: p.slug }, "Project created");
    }
  }

  const count = await prisma.project.count();
  logger.info({ count }, "Projects seeded");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
