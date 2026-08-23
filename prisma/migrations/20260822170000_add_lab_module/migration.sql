-- Modulo Laboratorio: espejo de las mediciones del molino.
-- Solo CREATE. No modifica ni borra nada de lo existente.

CREATE TYPE "LabSource" AS ENUM ('GLUTOMATIC', 'NIR');

CREATE TABLE "lab_measurements" (
    "id"               TEXT NOT NULL,
    "source"           "LabSource" NOT NULL,
    "sourceId"         VARCHAR(60) NOT NULL,
    "instrumentSerial" VARCHAR(64),
    "productCode"      VARCHAR(40),
    "sampleRef"        VARCHAR(80),
    "analyzedAt"       TIMESTAMP(3) NOT NULL,
    "ingestedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt"        TIMESTAMP(3),
    CONSTRAINT "lab_measurements_pkey" PRIMARY KEY ("id")
);

-- La identidad del registro es la PK del origen, no (serial, fecha).
CREATE UNIQUE INDEX "lab_measurements_source_sourceId_key"
    ON "lab_measurements"("source", "sourceId");

-- A proposito NO unique: el origen ya lo garantiza, y una P2002 aca abortaria
-- el lote entero dejando el cursor congelado con el heartbeat en verde.
CREATE INDEX "lab_measurements_instrumentSerial_analyzedAt_idx"
    ON "lab_measurements"("instrumentSerial", "analyzedAt");
CREATE INDEX "lab_measurements_source_analyzedAt_idx"
    ON "lab_measurements"("source", "analyzedAt");
CREATE INDEX "lab_measurements_productCode_analyzedAt_idx"
    ON "lab_measurements"("productCode", "analyzedAt");

CREATE TABLE "lab_parameters" (
    "measurementId"  TEXT NOT NULL,
    "code"           VARCHAR(40) NOT NULL,
    "value"          DOUBLE PRECISION NOT NULL,
    "unit"           VARCHAR(16),
    "isImplausible"  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "lab_parameters_pkey" PRIMARY KEY ("measurementId", "code")
);

CREATE INDEX "lab_parameters_code_isImplausible_idx"
    ON "lab_parameters"("code", "isImplausible");

ALTER TABLE "lab_parameters"
    ADD CONSTRAINT "lab_parameters_measurementId_fkey"
    FOREIGN KEY ("measurementId") REFERENCES "lab_measurements"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "lab_parameter_ranges" (
    "productCode" VARCHAR(40) NOT NULL,
    "code"        VARCHAR(40) NOT NULL,
    "minValue"    DOUBLE PRECISION NOT NULL,
    "maxValue"    DOUBLE PRECISION NOT NULL,
    CONSTRAINT "lab_parameter_ranges_pkey" PRIMARY KEY ("productCode", "code")
);

CREATE TABLE "lab_feeds" (
    "source"               "LabSource" NOT NULL,
    "lastHeartbeatAt"      TIMESTAMP(3),
    "lastIngestAt"         TIMESTAMP(3),
    "lastSourceAnalyzedAt" TIMESTAMP(3),
    "cursorId"             VARCHAR(60),
    "pendingCount"         INTEGER NOT NULL DEFAULT 0,
    "sqlReachable"         BOOLEAN NOT NULL DEFAULT true,
    "lastErrorCode"        TEXT,
    "agentVersion"         TEXT,
    "lastReconciledAt"     TIMESTAMP(3),
    "alertOpenTicketId"    TEXT,
    "alertLastNotifiedAt"  TIMESTAMP(3),
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lab_feeds_pkey" PRIMARY KEY ("source")
);

CREATE TABLE "service_clients" (
    "id"         TEXT NOT NULL,
    "slug"       TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes"     TEXT[],
    "isActive"   BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt"  TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_clients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "service_clients_slug_key" ON "service_clients"("slug");

-- Las dos filas de feed nacen con el modulo: si no existen, el watchdog no
-- tiene contra que comparar y el silencio inicial seria invisible.
INSERT INTO "lab_feeds" ("source", "updatedAt") VALUES ('GLUTOMATIC', CURRENT_TIMESTAMP);
INSERT INTO "lab_feeds" ("source", "updatedAt") VALUES ('NIR', CURRENT_TIMESTAMP);
