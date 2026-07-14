BEGIN;

-- Preflight: no aplicar cambios parciales si el historial existente viola la
-- invariante que esta migración refuerza a nivel de base.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "phone_line_assignments"
    WHERE "returnedAt" IS NULL
    GROUP BY "phoneLineId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'No se puede aplicar la migración: existen líneas con más de una asignación vigente';
  END IF;
END $$;

-- AddColumn
ALTER TABLE "phone_lines" ADD COLUMN "dataAllowanceGb" INTEGER;

-- AddCheckConstraint
ALTER TABLE "phone_lines"
ADD CONSTRAINT "phone_lines_dataAllowanceGb_check"
CHECK ("dataAllowanceGb" IS NULL OR ("dataAllowanceGb" >= 0 AND "dataAllowanceGb" <= 100000));

-- AddColumn
ALTER TABLE "phone_line_assignments" ADD COLUMN "returnNote" TEXT;

-- CreateTable
CREATE TABLE "phone_line_sim_changes" (
    "id" TEXT NOT NULL,
    "phoneLineId" TEXT NOT NULL,
    "previousIccid" TEXT,
    "newIccid" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "notes" TEXT,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_line_sim_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "phone_line_sim_changes_phoneLineId_changedAt_idx"
ON "phone_line_sim_changes"("phoneLineId", "changedAt");

-- CreateIndex
CREATE INDEX "phone_line_sim_changes_changedById_idx"
ON "phone_line_sim_changes"("changedById");

-- Refuerza a nivel de base la invariante del historial: una sola asignación
-- vigente por línea. Prisma no representa índices parciales en schema.prisma.
CREATE UNIQUE INDEX "phone_line_assignments_one_open_per_line_key"
ON "phone_line_assignments"("phoneLineId")
WHERE "returnedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "phone_line_sim_changes"
ADD CONSTRAINT "phone_line_sim_changes_phoneLineId_fkey"
FOREIGN KEY ("phoneLineId") REFERENCES "phone_lines"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_line_sim_changes"
ADD CONSTRAINT "phone_line_sim_changes_changedById_fkey"
FOREIGN KEY ("changedById") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
