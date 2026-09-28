/**
 * Trae del DataWarehouse (Aurora) el dataset de empresas de granos y lo vuelca
 * en `lab_productores`. Lo corre GitHub Actions cada noche
 * (.github/workflows/lab-productores-sync.yml) y se puede correr a mano:
 *
 *   npx tsx -r dotenv/config src/scripts/sync-productores-granos.ts
 *
 * Necesita DWH_DATABASE_URL (Aurora del DWH, credencial de solo lectura, la
 * misma que usa la extranet) y DATABASE_URL. Opcional LAB_PRODUCTORES_DATASET:
 * la tabla a leer, por defecto grf_lab_productores_granos.
 *
 * Nunca borra: upsert + baja lógica; si el dataset viene vacío o cae de golpe,
 * la corrida queda en ERROR y la lista no se toca (ver el service).
 */
import { PrismaClient } from "@prisma/client";
import { prisma } from "../lib/database";
import LabProductoresService, { datasetNombre, type FilaDataset } from "../services/lab.productores.service";

/**
 * El DWH es RDS con una CA privada que Node no conoce: se cifra la conexión sin
 * validar la cadena, igual que hace la extranet. Se limpian los parámetros de
 * libpq que Prisma no entiende.
 */
const urlDwh = (): string => {
  const raw = process.env.DWH_DATABASE_URL?.trim();
  if (!raw) throw new Error("DWH_DATABASE_URL no está definida");
  const u = new URL(raw);
  u.searchParams.delete("uselibpqcompat");
  u.searchParams.set("sslmode", "require");
  u.searchParams.set("sslaccept", "accept_invalid_certs");
  u.searchParams.set("connection_limit", "2");
  return u.toString();
};

/**
 * Lectura del dataset con un segundo cliente Prisma apuntado al DWH. No es el
 * schema de esta app, pero para un SELECT crudo no importa, y evita sumar un
 * driver más al proyecto. El nombre de tabla viene validado del service.
 */
async function leerDataset(): Promise<FilaDataset[]> {
  const dataset = datasetNombre();
  const dwh = new PrismaClient({ datasourceUrl: urlDwh(), log: [] });
  try {
    return await dwh.$queryRawUnsafe<FilaDataset[]>(`SELECT * FROM "public"."${dataset}"`);
  } finally {
    await dwh.$disconnect().catch(() => {});
  }
}

async function main() {
  const resultado = await LabProductoresService.sincronizar(leerDataset);
  console.log(JSON.stringify(resultado, null, 2));
  if (resultado.status !== "OK") process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("[sync-productores] error fatal", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
