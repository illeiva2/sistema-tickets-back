// Seed inicial de sectores + reglas de clasificación para workshops IMAS.
// Corré con: npx tsx src/scripts/seed-workshop-rules.ts
//
// Es idempotente: usa upsert por slug del sector y por (departmentId +
// mercadoEquals + keywords serializadas) para no duplicar reglas.

import { prisma } from "../lib/database";
import { logger } from "../lib/logger";

interface DeptSeed {
  slug: string;
  name: string;
  color?: string;
  icon?: string;
}

interface RuleSeed {
  departmentSlug: string;
  mercadoEquals?: string;
  keywords?: string[];
  whyText?: string;
  priority?: number;
}

const DEPARTMENTS: DeptSeed[] = [
  { slug: "ganaderia-y-agricultura", name: "Ganadería y Agricultura", icon: "🌾", color: "#84cc16" },
  { slug: "contabilidad", name: "Contabilidad", icon: "📊", color: "#0ea5e9" },
  { slug: "finanzas", name: "Finanzas", icon: "💰", color: "#22c55e" },
  { slug: "compras", name: "Compras", icon: "🛒", color: "#f59e0b" },
  { slug: "cereales", name: "Cereales", icon: "🌽", color: "#ca8a04" },
  { slug: "recursos-humanos", name: "Recursos Humanos", icon: "👥", color: "#a855f7" },
  { slug: "taller-maquinarias", name: "Taller (Maquinarias)", icon: "🔧", color: "#737373" },
  { slug: "cooperativa-createx", name: "Cooperativa Createx", icon: "🤝", color: "#06b6d4" },
  { slug: "transversales", name: "Transversales", icon: "🧩", color: "#6366f1" },
];

const RULES: RuleSeed[] = [
  // Ganadería y Agricultura
  {
    departmentSlug: "ganaderia-y-agricultura",
    mercadoEquals: "AGRO",
    whyText: "Workshop específico para el mercado AGRO.",
    priority: 100,
  },
  {
    departmentSlug: "ganaderia-y-agricultura",
    keywords: [
      "campaña agrícola",
      "campana agricola",
      "produccion",
      "producción",
      "cosechas",
      "gestión productiva",
      "gestion productiva",
      "ganadería",
      "ganaderia",
      "finnapp agro",
    ],
    whyText: "Relevante para la operación de Ganadería y Agricultura.",
    priority: 90,
  },

  // Contabilidad
  {
    departmentSlug: "contabilidad",
    keywords: [
      "conciliación bancaria",
      "conciliacion bancaria",
      "iva",
      "retenciones",
      "plan de cuentas",
      "centros de costo",
      "ajuste por inflación",
      "ajuste por inflacion",
      "asientos",
      "libro iva digital",
      "cm05",
      "cierre de ejercicio",
      "partidas",
      "valorización",
      "valorizacion",
    ],
    whyText: "Workshop útil para la gestión contable.",
    priority: 80,
  },

  // Finanzas
  {
    departmentSlug: "finanzas",
    keywords: [
      "tesorería",
      "tesoreria",
      "cobros",
      "pagos",
      "conciliación bancaria",
      "conciliacion bancaria",
      "cuentas corrientes",
      "cashflow",
      "e-cheq",
      "echeq",
      "cotización secundaria",
      "cotizacion secundaria",
      "finnapp office",
    ],
    whyText: "Workshop relevante para el área financiera.",
    priority: 80,
  },

  // Compras
  {
    departmentSlug: "compras",
    keywords: [
      "proveedores",
      "bot de compras",
      "valorización",
      "valorizacion",
      "stock",
      "cuentas corrientes",
      "portal de proveedores",
      "percepciones",
    ],
    whyText: "Útil para la gestión de compras.",
    priority: 80,
  },

  // Cereales
  {
    departmentSlug: "cereales",
    keywords: [
      "venta de granos",
      "compra de granos",
      "cpe",
      "carta de porte",
      "cartas de porte",
      "liquidaciones de granos",
      "contratos de granos",
      "bot de granos",
      "valuación de producción de granos",
      "valuacion de produccion de granos",
      "partidas (lotes)",
      "partidas lotes",
    ],
    whyText: "Específico para la operatoria de cereales.",
    priority: 90,
  },

  // Recursos Humanos
  {
    departmentSlug: "recursos-humanos",
    mercadoEquals: "SUELDOS / QUIPPOS",
    whyText: "Workshop específico de Sueldos / Quippos.",
    priority: 100,
  },
  {
    departmentSlug: "recursos-humanos",
    mercadoEquals: "SUELDOS",
    whyText: "Workshop específico de Sueldos.",
    priority: 100,
  },
  {
    departmentSlug: "recursos-humanos",
    mercadoEquals: "QUIPPOS",
    whyText: "Workshop específico de Quippos.",
    priority: 100,
  },
  {
    departmentSlug: "recursos-humanos",
    keywords: [
      "liquidación de sueldos",
      "liquidacion de sueldos",
      "ganancias 4ta",
      "conceptos y fórmulas",
      "conceptos y formulas",
      "indemnizaciones",
      "recibos de sueldo",
    ],
    whyText: "Workshop útil para RR.HH.",
    priority: 80,
  },

  // Taller (Maquinarias)
  {
    departmentSlug: "taller-maquinarias",
    keywords: [
      "rutinas y partes de mantenimiento de maquinarias",
      "partes de horas máquina",
      "partes de horas maquina",
      "gestión de maquinarias",
      "gestion de maquinarias",
    ],
    whyText: "Útil para el área de Taller / Maquinarias.",
    priority: 90,
  },

  // Cooperativa Createx (acotado)
  {
    departmentSlug: "cooperativa-createx",
    keywords: [
      "valorización",
      "valorizacion",
      "gestión de stock",
      "gestion de stock",
      "depósitos",
      "depositos",
    ],
    whyText: "Relevante para Cooperativa Createx.",
    priority: 70,
  },

  // Transversales (solo admin lo recibe). Reglas explícitas además del
  // fallback "TODOS LOS MERCADOS sin match".
  {
    departmentSlug: "transversales",
    keywords: [
      "ireport",
      "datawarehouse",
      "finni",
      "app builder",
      "análisis de datos",
      "analisis de datos",
      "cubos",
      "vistas",
      "deals",
      "reglas de autorización",
      "reglas de autorizacion",
      "bmodeler",
    ],
    whyText: "Capacitación transversal de la plataforma.",
    priority: 50,
  },
];

async function main() {
  // 1. Upsert sectores por slug.
  const deptIdBySlug = new Map<string, string>();
  for (const d of DEPARTMENTS) {
    const upserted = await prisma.department.upsert({
      where: { slug: d.slug },
      create: {
        slug: d.slug,
        name: d.name,
        color: d.color ?? null,
        icon: d.icon ?? null,
      },
      update: {
        // No pisamos nombre / color / icon si ya existen (admin pudo haberlos
        // editado). Solo create-time.
      },
    });
    deptIdBySlug.set(d.slug, upserted.id);
    logger.info({ slug: d.slug, id: upserted.id }, "Department seeded");
  }

  // 2. Crear reglas. Para idempotencia chequeamos si ya existe una con
  // misma combinación (departmentId, mercadoEquals, keywords ordenadas).
  for (const r of RULES) {
    const deptId = deptIdBySlug.get(r.departmentSlug);
    if (!deptId) {
      logger.warn({ slug: r.departmentSlug }, "Department not found, skipping rule");
      continue;
    }
    const existing = await prisma.workshopClassificationRule.findFirst({
      where: {
        departmentId: deptId,
        mercadoEquals: r.mercadoEquals ?? null,
      },
    });
    if (existing) {
      // Update para mantener keywords / whyText / priority frescos.
      await prisma.workshopClassificationRule.update({
        where: { id: existing.id },
        data: {
          keywords: r.keywords ?? [],
          whyText: r.whyText ?? null,
          priority: r.priority ?? 0,
          enabled: true,
        },
      });
    } else {
      await prisma.workshopClassificationRule.create({
        data: {
          departmentId: deptId,
          mercadoEquals: r.mercadoEquals ?? null,
          keywords: r.keywords ?? [],
          whyText: r.whyText ?? null,
          priority: r.priority ?? 0,
          enabled: true,
        },
      });
    }
  }

  const totalRules = await prisma.workshopClassificationRule.count();
  logger.info({ totalRules }, "Workshop rules seeded");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
