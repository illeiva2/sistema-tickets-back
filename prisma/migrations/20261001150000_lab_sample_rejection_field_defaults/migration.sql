-- Camión rechazado (cuándo, motivo, quién) sobre la muestra, y dos reglas más
-- del catálogo de campos: valor inicial y "ofrecer como filtro". Aditiva: no
-- toca datos existentes.

ALTER TABLE "lab_sample_field_defs" ADD COLUMN "defaultValue" VARCHAR(80);
ALTER TABLE "lab_sample_field_defs" ADD COLUMN "filterable" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "lab_samples" ADD COLUMN "rejectedAt" TIMESTAMP(3);
ALTER TABLE "lab_samples" ADD COLUMN "rejectedReason" VARCHAR(500);
ALTER TABLE "lab_samples" ADD COLUMN "rejectedById" TEXT;

ALTER TABLE "lab_samples" ADD CONSTRAINT "lab_samples_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
