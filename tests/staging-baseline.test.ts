import { describe, expect, it } from "vitest";
import {
  assertStagingBaselineTarget,
  IT_MANAGEMENT_MIGRATION,
  LEGACY_MIGRATIONS,
  LegacySchemaState,
  planLegacyBaseline,
} from "../src/lib/staging-baseline";

const validEnv = {
  STAGING_ENV: "1",
  API_URL: "https://sistema-tickets-back-staging.onrender.com",
  DATABASE_URL:
    "postgresql://user:password@ep-billowing-band-acugaroi-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require",
};

const completeLegacySchema: LegacySchemaState = {
  baseTicketing: true,
  fileOrganization: true,
  googleId: true,
  mustChangePassword: true,
  itAssets: false,
};

describe("baseline seguro de staging", () => {
  it("acepta solamente el servicio y endpoint de staging esperados", () => {
    expect(assertStagingBaselineTarget(validEnv)).toBe(
      "ep-billowing-band-acugaroi-pooler.sa-east-1.aws.neon.tech",
    );

    expect(() =>
      assertStagingBaselineTarget({
        ...validEnv,
        API_URL: "https://sistema-tickets-back.onrender.com",
      }),
    ).toThrow(/API_URL/);

    expect(() =>
      assertStagingBaselineTarget({
        ...validEnv,
        DATABASE_URL:
          "postgresql://user:password@ep-production-pooler.sa-east-1.aws.neon.tech/neondb",
      }),
    ).toThrow(/endpoint Neon de staging/);
  });

  it("planifica solo las cuatro migraciones historicas", () => {
    expect(planLegacyBaseline(new Set(), completeLegacySchema)).toEqual([
      ...LEGACY_MIGRATIONS,
    ]);
  });

  it("es idempotente cuando el baseline y Gestion IT ya figuran aplicados", () => {
    const recorded = new Set<string>([
      ...LEGACY_MIGRATIONS,
      IT_MANAGEMENT_MIGRATION,
    ]);

    expect(
      planLegacyBaseline(recorded, {
        ...completeLegacySchema,
        itAssets: true,
      }),
    ).toEqual([]);
  });

  it("se bloquea si falta schema historico o si assets ya existe sin historial", () => {
    expect(() =>
      planLegacyBaseline(new Set(), {
        ...completeLegacySchema,
        googleId: false,
      }),
    ).toThrow(/20250825181504_add_google_id/);

    expect(() =>
      planLegacyBaseline(new Set(), {
        ...completeLegacySchema,
        itAssets: true,
      }),
    ).toThrow(/tabla assets existe/);
  });
});
