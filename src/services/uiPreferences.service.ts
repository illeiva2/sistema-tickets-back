import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/database";
import type { SavedViewConfig } from "../validations/uiPreferences";

/**
 * Preferencias de interfaz por usuario.
 *
 * La tabla existía (theme, modo oscuro, layout del dashboard IT) sin endpoint
 * que la usara. `savedViews` suma la configuración de las vistas
 * personalizables —qué columnas, en qué orden, cómo ordenar— indexada por
 * clave de vista: una vista nueva no necesita columna ni migración.
 *
 * Todo se resuelve con el id del token: nadie puede leer ni escribir las
 * preferencias de otro, así que no hace falta ni rol ni módulo.
 */

export type SavedViews = Record<string, unknown>;

const soloObjeto = (v: unknown): SavedViews =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as SavedViews) : {};

/** Lo que ve el front cuando el usuario nunca guardó nada. */
const DEFAULTS = { theme: "quiet-pro", darkMode: null as boolean | null };

export class UiPreferencesService {
  /** No crea la fila al leer: quien nunca personalizó nada no deja rastro. */
  static async get(userId: string) {
    const row = await prisma.userUiPreference.findUnique({ where: { userId } });
    return {
      theme: row?.theme ?? DEFAULTS.theme,
      darkMode: row?.darkMode ?? DEFAULTS.darkMode,
      savedViews: soloObjeto(row?.savedViews),
    };
  }

  /** Guarda (o reemplaza) la configuración de UNA vista sin tocar las demás. */
  static async saveView(userId: string, viewKey: string, config: SavedViewConfig) {
    const row = await prisma.userUiPreference.findUnique({
      where: { userId },
      select: { savedViews: true },
    });
    const savedViews = { ...soloObjeto(row?.savedViews), [viewKey]: config } as Prisma.InputJsonObject;
    await prisma.userUiPreference.upsert({
      where: { userId },
      create: { userId, savedViews },
      update: { savedViews },
    });
    return { viewKey, config };
  }

  /** Vuelve a la vista sugerida: borra solo la personalización de esa clave. */
  static async deleteView(userId: string, viewKey: string) {
    const row = await prisma.userUiPreference.findUnique({
      where: { userId },
      select: { savedViews: true },
    });
    const actuales = soloObjeto(row?.savedViews);
    if (!(viewKey in actuales)) return { viewKey, deleted: false };

    const resto = Object.fromEntries(
      Object.entries(actuales).filter(([k]) => k !== viewKey),
    ) as Prisma.InputJsonObject;
    await prisma.userUiPreference.update({ where: { userId }, data: { savedViews: resto } });
    return { viewKey, deleted: true };
  }
}

export default UiPreferencesService;
