/**
 * Registra como aplicadas las migraciones historicas que ya estan materializadas
 * en el clon de staging. No aplica Gestion IT: prisma migrate deploy lo hace luego.
 *
 * Este script esta deliberadamente atado al servicio y endpoint de staging.
 */

import { execFileSync } from "child_process";
import path from "path";
import { PrismaClient } from "@prisma/client";
import {
  assertStagingBaselineTarget,
  IT_MANAGEMENT_MIGRATION,
  LEGACY_MIGRATIONS,
  LegacySchemaState,
  planLegacyBaseline,
} from "../lib/staging-baseline";

type SchemaInspectionRow = LegacySchemaState & {
  migrationTable: boolean;
};

async function inspectSchema(
  prisma: PrismaClient,
): Promise<SchemaInspectionRow> {
  const rows = await prisma.$queryRaw<SchemaInspectionRow[]>`
    SELECT
      to_regclass('public._prisma_migrations') IS NOT NULL AS "migrationTable",
      (
        to_regclass('public.users') IS NOT NULL
        AND to_regclass('public.tickets') IS NOT NULL
        AND to_regclass('public.comments') IS NOT NULL
        AND to_regclass('public.attachments') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'tickets'
            AND column_name = 'ticketNumber'
        )
      ) AS "baseTicketing",
      (
        to_regclass('public.file_categories') IS NOT NULL
        AND to_regclass('public.file_tags') IS NOT NULL
        AND to_regclass('public.file_organizations') IS NOT NULL
      ) AS "fileOrganization",
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'googleId'
      ) AS "googleId",
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'mustChangePassword'
      ) AS "mustChangePassword",
      to_regclass('public.assets') IS NOT NULL AS "itAssets"
  `;

  if (rows.length !== 1) {
    throw new Error("No se pudo inspeccionar el schema de staging.");
  }

  return rows[0];
}

async function getRecordedMigrations(
  prisma: PrismaClient,
  migrationTableExists: boolean,
): Promise<Set<string>> {
  if (!migrationTableExists) {
    return new Set();
  }

  const rows = await prisma.$queryRaw<
    Array<{ migration_name: string }>
  >`
    SELECT migration_name
    FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL
      AND rolled_back_at IS NULL
  `;

  return new Set(rows.map((row) => row.migration_name));
}

function prismaExecutable(): string {
  return path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "prisma.cmd" : "prisma",
  );
}

function assertDatabaseMatchesPreItSchema() {
  const datasourceSchema = path.join(
    process.cwd(),
    "prisma",
    "schema.prisma",
  );
  const preItSchema = path.join(
    process.cwd(),
    "prisma",
    "baseline",
    "pre_it_schema.prisma",
  );

  try {
    execFileSync(
      prismaExecutable(),
      [
        "migrate",
        "diff",
        "--exit-code",
        "--from-schema-datasource",
        datasourceSchema,
        "--to-schema-datamodel",
        preItSchema,
      ],
      {
        env: process.env,
        stdio: "pipe",
      },
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 2) {
      throw new Error(
        "Baseline bloqueado: el schema de staging difiere del snapshot pre-Gestion-IT.",
      );
    }

    throw new Error(
      "Baseline bloqueado: no se pudo comparar staging con el snapshot pre-Gestion-IT.",
    );
  }
}

async function main() {
  assertStagingBaselineTarget(process.env);

  const prisma = new PrismaClient();
  let schema: SchemaInspectionRow;
  let recordedMigrations: Set<string>;

  try {
    schema = await inspectSchema(prisma);
    recordedMigrations = await getRecordedMigrations(
      prisma,
      schema.migrationTable,
    );
  } finally {
    await prisma.$disconnect();
  }

  const migrationsToResolve = planLegacyBaseline(
    recordedMigrations,
    schema,
  );

  if (!recordedMigrations.has(IT_MANAGEMENT_MIGRATION)) {
    assertDatabaseMatchesPreItSchema();
  }

  if (migrationsToResolve.length === 0) {
    const itState = recordedMigrations.has(IT_MANAGEMENT_MIGRATION)
      ? "Gestion IT ya aplicada"
      : "baseline historico completo";
    console.log(`Baseline staging: sin cambios (${itState}).`);
    return;
  }

  for (const migration of migrationsToResolve) {
    if (!LEGACY_MIGRATIONS.includes(migration)) {
      throw new Error(`Migracion no permitida para baseline: ${migration}`);
    }

    console.log(`Baseline staging: registrando ${migration}.`);
    execFileSync(
      prismaExecutable(),
      ["migrate", "resolve", "--applied", migration],
      {
        env: process.env,
        stdio: "inherit",
      },
    );
  }

  console.log("Baseline staging completado.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Error desconocido";
  console.error(`Baseline staging fallo: ${message}`);
  process.exit(1);
});
