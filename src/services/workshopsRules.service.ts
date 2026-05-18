import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import type {
  CreateRuleRequest,
  UpdateRuleRequest,
} from "../validations/workshops";

const ruleInclude = {
  department: {
    select: { id: true, name: true, slug: true, color: true, icon: true },
  },
} as const;

export class WorkshopRulesService {
  static async list() {
    return prisma.workshopClassificationRule.findMany({
      include: ruleInclude,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    });
  }

  static async create(data: CreateRuleRequest) {
    // Validamos que el sector exista.
    const dept = await prisma.department.findUnique({
      where: { id: data.departmentId },
      select: { id: true },
    });
    if (!dept) {
      throw new ApiError("DEPARTMENT_NOT_FOUND", "Sector no encontrado", 404);
    }
    return prisma.workshopClassificationRule.create({
      data: {
        departmentId: data.departmentId,
        mercadoEquals: data.mercadoEquals ?? null,
        keywords: data.keywords ?? [],
        whyText: data.whyText ?? null,
        enabled: data.enabled ?? true,
        priority: data.priority ?? 0,
      },
      include: ruleInclude,
    });
  }

  static async update(id: string, data: UpdateRuleRequest) {
    const existing = await prisma.workshopClassificationRule.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new ApiError("RULE_NOT_FOUND", "Regla no encontrada", 404);
    }
    return prisma.workshopClassificationRule.update({
      where: { id },
      data: {
        ...(data.departmentId !== undefined ? { departmentId: data.departmentId } : {}),
        ...(data.mercadoEquals !== undefined
          ? { mercadoEquals: data.mercadoEquals }
          : {}),
        ...(data.keywords !== undefined ? { keywords: data.keywords } : {}),
        ...(data.whyText !== undefined ? { whyText: data.whyText } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
      },
      include: ruleInclude,
    });
  }

  static async remove(id: string) {
    const existing = await prisma.workshopClassificationRule.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new ApiError("RULE_NOT_FOUND", "Regla no encontrada", 404);
    }
    await prisma.workshopClassificationRule.delete({ where: { id } });
  }
}

export default WorkshopRulesService;
