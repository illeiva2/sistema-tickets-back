/**
 * Catalogo de modulos de la plataforma que se habilitan por usuario.
 *
 * Vive en codigo y no en la base a proposito: agregar un modulo es un deploy,
 * no una migracion ni una fila que alguien tenga que cargar a mano. La tabla
 * `module_grants` solo guarda QUIEN tiene acceso a QUE clave.
 *
 * `external: true` significa que el modulo no vive en esta app: el front muestra
 * el item de menu y manda al usuario afuera (ver el handoff de GlutenLab).
 */
export interface ModuleDefinition {
  key: string;
  name: string;
  description: string;
  external: boolean;
}

export const MODULE_LEVELS = ["VIEWER", "QC", "MANAGEMENT"] as const;
export type ModuleLevel = (typeof MODULE_LEVELS)[number];

export const MODULES: ModuleDefinition[] = [
  {
    key: "glutenlab",
    name: "Laboratorio de calidad",
    description:
      "Mediciones de los Glutomatic y del NIR IM 9500H. Corre on-premise en el molino.",
    external: true,
  },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);

export const isValidModuleKey = (key: string): boolean =>
  MODULE_KEYS.includes(key);

export const isValidModuleLevel = (level: string): level is ModuleLevel =>
  (MODULE_LEVELS as readonly string[]).includes(level);

export const getModule = (key: string): ModuleDefinition | undefined =>
  MODULES.find((m) => m.key === key);
