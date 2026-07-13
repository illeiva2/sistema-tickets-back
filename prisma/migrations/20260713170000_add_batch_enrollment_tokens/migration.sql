-- Permite que un token de enrolamiento sea usado por un lote acotado de equipos.
-- Los tokens históricos conservan la semántica de un solo uso.
ALTER TABLE "agent_enrollment_tokens"
  ADD COLUMN "maxUses" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "useCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "revokedAt" TIMESTAMP(3);

ALTER TABLE "agent_devices"
  ADD COLUMN "enrollmentTokenId" TEXT;

-- Backfill antes de retirar la relación 1:1 anterior.
UPDATE "agent_enrollment_tokens"
SET "useCount" = CASE WHEN "usedAt" IS NULL THEN 0 ELSE 1 END;

UPDATE "agent_devices" AS device
SET "enrollmentTokenId" = token."id"
FROM "agent_enrollment_tokens" AS token
WHERE token."usedByDeviceId" = device."id";

ALTER TABLE "agent_enrollment_tokens"
  DROP CONSTRAINT "agent_enrollment_tokens_usedByDeviceId_fkey";

DROP INDEX "agent_enrollment_tokens_usedByDeviceId_key";

ALTER TABLE "agent_enrollment_tokens"
  DROP COLUMN "usedByDeviceId";

CREATE INDEX "agent_devices_enrollmentTokenId_idx"
  ON "agent_devices"("enrollmentTokenId");

CREATE INDEX "agent_enrollment_tokens_revokedAt_idx"
  ON "agent_enrollment_tokens"("revokedAt");

ALTER TABLE "agent_devices"
  ADD CONSTRAINT "agent_devices_enrollmentTokenId_fkey"
  FOREIGN KEY ("enrollmentTokenId") REFERENCES "agent_enrollment_tokens"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_enrollment_tokens"
  ADD CONSTRAINT "agent_enrollment_tokens_maxUses_check"
  CHECK ("maxUses" BETWEEN 1 AND 250);

ALTER TABLE "agent_enrollment_tokens"
  ADD CONSTRAINT "agent_enrollment_tokens_useCount_check"
  CHECK ("useCount" >= 0 AND "useCount" <= "maxUses");
