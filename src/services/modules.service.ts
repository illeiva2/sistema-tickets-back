import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import {
  MODULES,
  ModuleLevel,
  getModule,
  isValidModuleKey,
  isValidModuleLevel,
} from "../lib/modules";
import { UserRole } from "@prisma/client";

export interface UserModuleAccess {
  key: string;
  name: string;
  description: string;
  external: boolean;
  level: ModuleLevel;
  /** true si el acceso viene por ser ADMIN y no por una concesion explicita. */
  implicit: boolean;
}

/**
 * Los ADMIN entran siempre a todos los modulos. Es una decision explicita: el
 * panel que administra los permisos es el mismo lugar donde un admin podria
 * quitarse el acceso a si mismo y quedar afuera.
 */
const adminSeesEverything = (role: UserRole) => role === "ADMIN";

export class ModulesService {
  /** Modulos que este usuario puede usar hoy. */
  static async listForUser(
    userId: string,
    role: UserRole,
  ): Promise<UserModuleAccess[]> {
    if (adminSeesEverything(role)) {
      return MODULES.map((m) => ({
        ...m,
        level: "MANAGEMENT" as ModuleLevel,
        implicit: true,
      }));
    }

    const grants = await prisma.moduleGrant.findMany({
      where: { userId, revokedAt: null },
      select: { moduleKey: true, level: true },
    });

    return grants
      .map((g) => {
        const def = getModule(g.moduleKey);
        if (!def) return null; // modulo retirado del catalogo: se ignora
        return {
          ...def,
          level: (isValidModuleLevel(g.level) ? g.level : "VIEWER") as ModuleLevel,
          implicit: false,
        };
      })
      .filter((x): x is UserModuleAccess => x !== null);
  }

  /**
   * Chequeo puntual, el que usa el middleware. Se consulta la base en cada
   * request a proposito y no se mete el permiso en el JWT: asi revocar surte
   * efecto de inmediato en vez de esperar los 15 minutos del access token.
   */
  static async hasAccess(
    userId: string,
    role: UserRole,
    moduleKey: string,
  ): Promise<{ allowed: boolean; level: ModuleLevel | null }> {
    if (adminSeesEverything(role)) return { allowed: true, level: "MANAGEMENT" };

    const grant = await prisma.moduleGrant.findFirst({
      where: { userId, moduleKey, revokedAt: null },
      select: { level: true },
    });
    if (!grant) return { allowed: false, level: null };

    return {
      allowed: true,
      level: (isValidModuleLevel(grant.level) ? grant.level : "VIEWER") as ModuleLevel,
    };
  }

  /** Concesiones activas de todos los usuarios, para la grilla de administracion. */
  static async listAllGrants() {
    return prisma.moduleGrant.findMany({
      where: { revokedAt: null },
      select: {
        id: true,
        userId: true,
        moduleKey: true,
        level: true,
        createdAt: true,
        grantedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ moduleKey: "asc" }, { createdAt: "asc" }],
    });
  }

  /**
   * Reemplaza el conjunto de modulos habilitados de un usuario.
   * Revoca por baja logica lo que sale y crea lo que entra; lo que no cambia
   * se deja intacto para no perder la fecha original de la concesion.
   */
  static async setUserGrants(
    targetUserId: string,
    desired: { moduleKey: string; level: ModuleLevel }[],
    actorId: string,
  ) {
    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, deletedAt: true },
    });
    if (!target || target.deletedAt) {
      throw new ApiError("NOT_FOUND", "Usuario no encontrado", 404);
    }

    for (const d of desired) {
      if (!isValidModuleKey(d.moduleKey)) {
        throw new ApiError(
          "VALIDATION_ERROR",
          `Modulo desconocido: ${d.moduleKey}`,
          400,
        );
      }
    }

    const current = await prisma.moduleGrant.findMany({
      where: { userId: targetUserId, revokedAt: null },
      select: { id: true, moduleKey: true, level: true },
    });

    const desiredByKey = new Map(desired.map((d) => [d.moduleKey, d.level]));
    const now = new Date();

    const toRevoke = current.filter(
      (c) =>
        !desiredByKey.has(c.moduleKey) ||
        desiredByKey.get(c.moduleKey) !== c.level,
    );
    const keep = new Set(
      current
        .filter(
          (c) =>
            desiredByKey.has(c.moduleKey) &&
            desiredByKey.get(c.moduleKey) === c.level,
        )
        .map((c) => c.moduleKey),
    );
    const toCreate = desired.filter((d) => !keep.has(d.moduleKey));

    await prisma.$transaction(async (tx) => {
      if (toRevoke.length > 0) {
        await tx.moduleGrant.updateMany({
          where: { id: { in: toRevoke.map((r) => r.id) } },
          data: { revokedAt: now, revokedById: actorId },
        });
      }
      for (const c of toCreate) {
        await tx.moduleGrant.create({
          data: {
            userId: targetUserId,
            moduleKey: c.moduleKey,
            level: c.level,
            grantedById: actorId,
          },
        });
      }
    });

    return {
      revoked: toRevoke.map((r) => r.moduleKey),
      granted: toCreate.map((c) => c.moduleKey),
      unchanged: [...keep],
    };
  }
}

export default ModulesService;
