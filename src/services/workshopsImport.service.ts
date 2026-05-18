import { prisma } from "../lib/database";
import { logger } from "../lib/logger";
import { slugify, ensureUniqueSlug } from "../lib/slug";
import {
  fetchSheetCsv,
  parseWorkshopsCsv,
  type WorkshopRow,
} from "../lib/workshopsCsv";
import {
  classifyWorkshop,
  isClosedOrFull,
  TRANSVERSALES_SLUG,
  type ClassifierRule,
} from "../lib/workshopsClassifier";
import {
  parseSheetDate,
  startOfToday,
  endOfWeek,
  endOfMonth,
  getPeriodKey,
  formatDisplayDate,
} from "../lib/workshopsDates";
import {
  renderWorkshopsMarkdown,
  renderWorkshopsExcerpt,
  type ClassifiedWorkshop,
} from "../lib/workshopsMarkdown";

export type ImportMode = "weekly" | "monthly";

export interface ImportSummary {
  period: string;
  mode: ImportMode;
  totalRows: number;
  importedRows: number; // tras filtros
  discardedClosed: number; // CUPO AGOTADO / EVENTO CERRADO
  discardedPast: number;
  discardedOutOfRange: number;
  unclassified: number; // workshops que no matchearon ninguna regla ni transversal
  byGroup: Array<{
    departmentId: string;
    departmentName: string;
    departmentSlug: string;
    count: number;
    resourceId: string | null;
    action: "created" | "updated" | "skipped";
  }>;
  dryRun: boolean;
}

interface ImportContext {
  rules: ClassifierRule[];
  transversalesDeptId: string | null;
  deptNameBySlug: Map<string, string>;
}

const loadContext = async (): Promise<ImportContext> => {
  const [rules, departments] = await Promise.all([
    prisma.workshopClassificationRule.findMany({
      where: { enabled: true },
      include: {
        department: { select: { id: true, slug: true } },
      },
    }),
    prisma.department.findMany({
      select: { id: true, name: true, slug: true },
    }),
  ]);

  const classifierRules: ClassifierRule[] = rules.map((r) => ({
    id: r.id,
    departmentId: r.departmentId,
    departmentSlug: r.department.slug,
    mercadoEquals: r.mercadoEquals,
    keywords: r.keywords,
    whyText: r.whyText,
    enabled: r.enabled,
    priority: r.priority,
  }));

  const transversales = departments.find((d) => d.slug === TRANSVERSALES_SLUG);
  const deptNameBySlug = new Map(departments.map((d) => [d.slug, d.name]));

  return {
    rules: classifierRules,
    transversalesDeptId: transversales?.id ?? null,
    deptNameBySlug,
  };
};

// Helper para asegurar slug único para el Resource. Si ya existe un
// Resource con ese slug (de un import anterior con misma key), lo
// reutilizamos.
const buildOrReuseSlug = async (
  baseTitle: string,
  externalKey: string,
): Promise<string> => {
  // Si ya hay un resource con esta externalKey, mantenemos su slug.
  const existing = await prisma.resource.findUnique({
    where: { externalKey },
    select: { slug: true },
  });
  if (existing) return existing.slug;

  const base = slugify(baseTitle);
  return ensureUniqueSlug(base, async (s) => {
    const found = await prisma.resource.findUnique({
      where: { slug: s },
      select: { id: true },
    });
    return !!found;
  });
};

export class WorkshopsImportService {
  static async importFromSheet(
    sheetUrl: string,
    mode: ImportMode,
    importerId: string,
    dryRun = false,
    now: Date = new Date(),
  ): Promise<ImportSummary> {
    const csv = await fetchSheetCsv(sheetUrl);
    const rows = parseWorkshopsCsv(csv);
    const totalRows = rows.length;

    const today = startOfToday(now);
    const rangeEnd = mode === "weekly" ? endOfWeek(now) : endOfMonth(now);
    const period = getPeriodKey(mode, now);

    let discardedClosed = 0;
    let discardedPast = 0;
    let discardedOutOfRange = 0;

    // Filtramos primero por estado/fecha.
    interface ParsedRow {
      row: WorkshopRow;
      date: Date;
    }
    const valid: ParsedRow[] = [];
    for (const row of rows) {
      if (isClosedOrFull(row)) {
        discardedClosed++;
        continue;
      }
      const date = parseSheetDate(row.fecha, now);
      if (!date) {
        // Fecha no parseable: la descartamos como "fuera de rango" (no
        // queremos asumir hoy y mostrarla por error).
        discardedOutOfRange++;
        continue;
      }
      if (date.getTime() < today.getTime()) {
        discardedPast++;
        continue;
      }
      if (date.getTime() > rangeEnd.getTime()) {
        discardedOutOfRange++;
        continue;
      }
      valid.push({ row, date });
    }

    const importedRows = valid.length;

    // Cargamos reglas y datos de sectores.
    const ctx = await loadContext();

    // Clasificamos cada workshop. Agrupamos por sector.
    const byDept = new Map<
      string,
      { slug: string; items: ClassifiedWorkshop[] }
    >();
    let unclassified = 0;
    for (const v of valid) {
      const matches = classifyWorkshop(
        v.row,
        ctx.rules,
        ctx.transversalesDeptId,
      );
      if (matches.length === 0) {
        unclassified++;
        continue;
      }
      for (const m of matches) {
        const entry = byDept.get(m.departmentId) ?? {
          slug: m.departmentSlug,
          items: [],
        };
        entry.items.push({
          row: v.row,
          parsedDate: v.date,
          whyText: m.whyText,
        });
        byDept.set(m.departmentId, entry);
      }
    }

    // Por cada sector, upsert del Resource.
    const byGroup: ImportSummary["byGroup"] = [];
    if (dryRun) {
      for (const [deptId, group] of byDept.entries()) {
        byGroup.push({
          departmentId: deptId,
          departmentName: ctx.deptNameBySlug.get(group.slug) ?? group.slug,
          departmentSlug: group.slug,
          count: group.items.length,
          resourceId: null,
          action: "skipped",
        });
      }
    } else {
      for (const [deptId, group] of byDept.entries()) {
        const deptName = ctx.deptNameBySlug.get(group.slug) ?? group.slug;
        const title = `Workshops IMAS — agenda hasta el ${formatDisplayDate(rangeEnd, now)} (${deptName})`;
        const content = renderWorkshopsMarkdown(group.items, rangeEnd, now);
        const excerpt = renderWorkshopsExcerpt(group.items.length, rangeEnd, now);
        const externalKey = `workshops:${period}:${group.slug}`;
        const slug = await buildOrReuseSlug(title, externalKey);

        // upsert por externalKey. Mantenemos audiencia exclusiva a este
        // sector via `set` (idempotente).
        const upserted = await prisma.resource.upsert({
          where: { externalKey },
          create: {
            slug,
            title,
            content,
            excerpt,
            category: "ANNOUNCEMENT",
            tags: ["workshops", "imas", period],
            isPublished: true,
            externalKey,
            authorId: importerId,
            audienceDepartments: { connect: [{ id: deptId }] },
          },
          update: {
            title,
            content,
            excerpt,
            tags: ["workshops", "imas", period],
            isPublished: true,
            audienceDepartments: { set: [{ id: deptId }] },
          },
          select: { id: true, createdAt: true, updatedAt: true },
        });

        const action: "created" | "updated" =
          upserted.createdAt.getTime() === upserted.updatedAt.getTime()
            ? "created"
            : "updated";

        byGroup.push({
          departmentId: deptId,
          departmentName: deptName,
          departmentSlug: group.slug,
          count: group.items.length,
          resourceId: upserted.id,
          action,
        });
      }

      // Auditoría
      await prisma.workshopImport.create({
        data: {
          period,
          mode,
          sheetUrl,
          totalRows,
          importedRows,
          generatedResources: byGroup.length,
          importedById: importerId,
        },
      });
    }

    logger.info(
      {
        sheetUrl,
        mode,
        period,
        totalRows,
        importedRows,
        discardedClosed,
        discardedPast,
        discardedOutOfRange,
        unclassified,
        groups: byGroup.length,
        dryRun,
      },
      "Workshops import done",
    );

    return {
      period,
      mode,
      totalRows,
      importedRows,
      discardedClosed,
      discardedPast,
      discardedOutOfRange,
      unclassified,
      byGroup,
      dryRun,
    };
  }

  static async listImports(limit = 30) {
    return prisma.workshopImport.findMany({
      orderBy: { importedAt: "desc" },
      take: limit,
      include: {
        importer: { select: { id: true, name: true, email: true } },
      },
    });
  }
}

export default WorkshopsImportService;
