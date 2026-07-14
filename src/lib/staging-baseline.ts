export const LEGACY_MIGRATIONS = [
  "20250824202451_add_ticket_number",
  "20250824231100_add_file_organization",
  "20250825181504_add_google_id",
  "20250831004108_add_must_change_password",
] as const;

export const IT_MANAGEMENT_MIGRATION =
  "20260711000000_add_it_management_schema";

const EXPECTED_STAGING_API_URL =
  "https://sistema-tickets-back-staging.onrender.com";

const EXPECTED_STAGING_DATABASE_HOSTS = new Set([
  "ep-billowing-band-acugaroi-pooler.sa-east-1.aws.neon.tech",
  "ep-billowing-band-acugaroi.sa-east-1.aws.neon.tech",
]);

export type LegacySchemaState = {
  baseTicketing: boolean;
  fileOrganization: boolean;
  googleId: boolean;
  mustChangePassword: boolean;
  itAssets: boolean;
};

const REQUIRED_SCHEMA_BY_MIGRATION: Record<
  (typeof LEGACY_MIGRATIONS)[number],
  keyof LegacySchemaState
> = {
  "20250824202451_add_ticket_number": "baseTicketing",
  "20250824231100_add_file_organization": "fileOrganization",
  "20250825181504_add_google_id": "googleId",
  "20250831004108_add_must_change_password": "mustChangePassword",
};

export function assertStagingBaselineTarget(env: NodeJS.ProcessEnv): string {
  if (env.STAGING_ENV !== "1") {
    throw new Error("Baseline bloqueado: STAGING_ENV debe ser 1.");
  }

  if (env.API_URL !== EXPECTED_STAGING_API_URL) {
    throw new Error(
      "Baseline bloqueado: API_URL no corresponde al servicio de staging.",
    );
  }

  if (!env.DATABASE_URL) {
    throw new Error("Baseline bloqueado: falta DATABASE_URL.");
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("Baseline bloqueado: DATABASE_URL no es una URL valida.");
  }

  if (!EXPECTED_STAGING_DATABASE_HOSTS.has(databaseUrl.hostname)) {
    throw new Error(
      "Baseline bloqueado: DATABASE_URL no apunta al endpoint Neon de staging esperado.",
    );
  }

  if (databaseUrl.pathname !== "/neondb") {
    throw new Error(
      "Baseline bloqueado: DATABASE_URL no apunta a la base neondb de staging.",
    );
  }

  return databaseUrl.hostname;
}

export function planLegacyBaseline(
  recordedMigrations: ReadonlySet<string>,
  schema: LegacySchemaState,
): Array<(typeof LEGACY_MIGRATIONS)[number]> {
  const missing = LEGACY_MIGRATIONS.filter(
    (migration) => !recordedMigrations.has(migration),
  );

  if (
    recordedMigrations.has(IT_MANAGEMENT_MIGRATION) &&
    missing.length > 0
  ) {
    throw new Error(
      "Historial inconsistente: Gestion IT figura aplicada antes del baseline historico.",
    );
  }

  if (!recordedMigrations.has(IT_MANAGEMENT_MIGRATION) && schema.itAssets) {
    throw new Error(
      "Baseline bloqueado: la tabla assets existe pero la migracion de Gestion IT no figura aplicada.",
    );
  }

  for (const migration of missing) {
    const requiredSchema = REQUIRED_SCHEMA_BY_MIGRATION[migration];
    if (!schema[requiredSchema]) {
      throw new Error(
        `Baseline bloqueado: el schema requerido por ${migration} no esta completo.`,
      );
    }
  }

  return [...missing];
}
