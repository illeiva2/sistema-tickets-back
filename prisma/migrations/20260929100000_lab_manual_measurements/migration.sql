-- Análisis manuales (termobalanza, estufa, colorímetro, PMG): un origen más
-- para las mediciones y quién las cargó. Aditiva: no toca datos existentes.

ALTER TYPE "LabSource" ADD VALUE 'MANUAL';

ALTER TABLE "lab_measurements" ADD COLUMN "createdById" TEXT;

ALTER TABLE "lab_measurements" ADD CONSTRAINT "lab_measurements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
